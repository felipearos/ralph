import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";

import { writeCredential } from "./credentials";
import { createTracker, TrackerUnavailableError } from "./index";

const base = { repo: "acme/widgets", owner: "felipe" };
const linear = { ...base, tracker: { kind: "linear" as const, team: "AND", workspace: "acme", scopeLabel: null, states: { claimed: "In Progress", done: "Done" } } };
const scratchEnv = () => ({ XDG_CONFIG_HOME: scratchDir("tracker-index-") });

const unavailable = (run: () => unknown): TrackerUnavailableError => {
  try {
    run();
  } catch (error) {
    if (error instanceof TrackerUnavailableError) return error;
    throw error;
  }
  throw new Error("expected the tracker to be unavailable");
};

describe("createTracker", () => {
  it("builds the GitHub adapter on the project's repo with no credential", () => {
    const tracker = createTracker({ ...base, tracker: { kind: "github" } }, { projectId: "w", env: scratchEnv() });
    expect(tracker.kind).toBe("github");
    expect(tracker.url(3)).toBe("https://github.com/acme/widgets/issues/3");
  });

  it("is not connected when a Linear project has no credential", () => {
    const error = unavailable(() => createTracker(linear, { projectId: "w", env: scratchEnv() }));
    expect(error.reason).toBe("not-connected");
    expect(error.message).toMatch(/connect it from the dashboard/);
  });

  it("is not connected when the credential is for another tracker", () => {
    const env = scratchEnv();
    writeCredential("w", { kind: "jira", email: "a@b.c", apiToken: "t" }, env);
    expect(unavailable(() => createTracker(linear, { projectId: "w", env })).message).toMatch(/is for jira/);
  });

  it("builds the Linear adapter once connected", () => {
    const env = scratchEnv();
    writeCredential("w", { kind: "linear", apiKey: "k" }, env);
    const tracker = createTracker(linear, { projectId: "w", env });
    expect(tracker.kind).toBe("linear");
    expect(tracker.url(184)).toBe("https://linear.app/acme/issue/AND-184");
  });

  it("builds the Jira adapter once connected", () => {
    const env = scratchEnv();
    writeCredential("w", { kind: "jira", email: "a@b.c", apiToken: "t" }, env);
    const jira = { ...base, tracker: { kind: "jira" as const, site: "acme.atlassian.net", project: "OA", scopeLabel: null, states: linear.tracker.states } };
    const tracker = createTracker(jira, { projectId: "w", env });
    expect(tracker.kind).toBe("jira");
    expect(tracker.url(410)).toBe("https://acme.atlassian.net/browse/OA-410");
  });

  it("builds the local tracker with no credential, writing to its file", async () => {
    const file = join(scratchDir("tracker-local-"), "tickets.json");
    const local = { ...base, tracker: { kind: "local" as const, key: "SBX", file, scopeLabel: null, states: linear.tracker.states } };
    // Nothing to read a credential from: an empty config home and an empty HOME.
    const tracker = createTracker(local, { projectId: "w", env: { ...scratchEnv(), HOME: scratchDir("tracker-home-") } });
    expect(tracker.kind).toBe("local");
    expect(existsSync(file)).toBe(false);
    const { number } = await tracker.create({ title: "Sandbox ticket", body: "body", labels: [] });
    expect(tracker.ref(number)).toBe(`SBX-${number}`);
    expect(JSON.parse(readFileSync(file, "utf8")).issues).toMatchObject([{ number, title: "Sandbox ticket" }]);
  });
});
