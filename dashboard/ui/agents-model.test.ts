// @vitest-environment node
import { describe, expect, it } from "vitest";

import type {
  AddAgentResult,
  AgentPreflightView,
  CreateCheckoutResult,
  DeleteAgentResult,
  PendingAgentView,
  ReadinessItem,
  RemoveProjectResult,
  RerunSetupResult,
  StartResult,
  WorktreeSetupRecord,
  WorktreeSetupStepView,
} from "../contracts";
import {
  addNotice,
  agentNameProblem,
  checkoutNotice,
  deleteNotice,
  pendingCard,
  preflightLine,
  removeNotice,
  rerunNotice,
  resumeStep,
  setupLines,
  startNotice,
} from "./agents-model";

const pr = { url: "https://github.com/o/r/pull/7", branch: "ralph-roster/add-nova", state: "open" as const };
const agent = (over: Partial<PendingAgentView> = {}): PendingAgentView => ({
  name: "nova",
  worktree: "/w/nova-loop",
  status: "pending-merge",
  pr,
  role: "coder",
  readiness: [],
  ...over,
});

describe("a pending agent's card", () => {
  it("says it waits on the roster PR, links it, and still offers Start for the server to judge", () => {
    expect(pendingCard(agent())).toEqual({
      badge: "pending merge",
      tone: "warn",
      readiness: [],
      outstanding: 0,
      canStart: true,
      startHint: "Start is refused until the roster PR merges into the base branch; it checks the base branch afresh.",
      pr: { href: pr.url, label: "PR #7 · open", title: "PR #7", state: "open" },
    });
  });

  it("unlocks Start once the base branch names it", () => {
    const card = pendingCard(agent({ status: "ready", pr: { ...pr, state: "merged" } }));
    expect(card).toMatchObject({ badge: "ready", tone: "good", canStart: true, pr: { label: "PR #7 · merged" } });
    expect(card.startHint).toContain("moved up to the base branch");
  });

  it("says when no roster PR can be found, and when it was closed unmerged", () => {
    expect(pendingCard(agent({ pr: null })).pr).toBeNull();
    expect(pendingCard(agent({ pr: { ...pr, state: "closed" } }))).toMatchObject({ tone: "bad", pr: { label: "PR #7 · closed" } });
  });
});

describe("the readiness items on a card", () => {
  const items: ReadinessItem[] = [
    { key: "roster-pr", label: "roster PR merged", state: "pass", reason: "origin/main lists it in 'loops'" },
    { key: "labels", label: "claim labels exist", state: "fail", reason: "the project has no nova-done label" },
    { key: "jav", label: "Jav route exists", state: "unknown", reason: "Jav's config could not be read" },
  ];

  it("paints each of the three states, and counts what is outstanding", () => {
    const card = pendingCard(agent({ readiness: items }));
    expect(card.readiness).toEqual([
      // A pass is good; a fail WARNS rather than erring, because nothing here
      // blocks Start — preflight is the gate, and Start itself moves a ready
      // agent's checkout up to the base branch.
      { key: "roster-pr", label: "roster PR merged", state: "pass", tone: "good", reason: items[0]!.reason },
      { key: "labels", label: "claim labels exist", state: "fail", tone: "warn", reason: items[1]!.reason },
      // Unknown is neutral, not a warning: a command that could not run says
      // nothing about the agent either way.
      { key: "jav", label: "Jav route exists", state: "unknown", tone: "neutral", reason: items[2]!.reason },
    ]);
    expect(card.outstanding).toBe(2);
  });

  it("keeps the server's order, and reads an empty list as nothing outstanding", () => {
    const reversed = pendingCard(agent({ readiness: [...items].reverse() }));
    expect(reversed.readiness.map((line) => line.key)).toEqual(["jav", "labels", "roster-pr"]);
    expect(pendingCard(agent({ readiness: [] })).outstanding).toBe(0);
  });

  it("paints the preflight item the card asked its own route for", () => {
    const view: AgentPreflightView = {
      name: "nova",
      item: { key: "preflight", label: "preflight verdict", state: "fail", reason: "preflight denies the start: loop-labels" },
    };
    expect(preflightLine(view)).toEqual({
      key: "preflight",
      label: "preflight verdict",
      state: "fail",
      tone: "warn",
      reason: "preflight denies the start: loop-labels",
    });
  });
});

describe("the name field", () => {
  it("asks for one lowercase word and leaves the roster rules to the server", () => {
    expect(agentNameProblem("")).toBe("Name the agent.");
    expect(agentNameProblem("Nova")).toBe("One lowercase word: a-z, then a-z or 0-9.");
    expect(agentNameProblem("nova-2")).toBe("One lowercase word: a-z, then a-z or 0-9.");
    expect(agentNameProblem("nova2")).toBeNull();
    // A repeat or a stage name is the server's call, answered as a refusal.
    expect(agentNameProblem("executor")).toBeNull();
  });
});

const step = (over: Partial<WorktreeSetupStepView> = {}): WorktreeSetupStepView => ({
  name: "install",
  command: "bun install",
  state: "passed",
  durationMs: 12_300,
  exitCode: 0,
  output: "",
  truncated: false,
  limitMs: 120_000,
  error: null,
  ...over,
});
const record = (...steps: WorktreeSetupStepView[]): WorktreeSetupRecord => ({ ranAt: "2026-11-04T00:00:00Z", steps });
const stopped = record(step(), step({ name: "env", state: "failed", exitCode: 2, durationMs: 4_000, output: "no .env" }));

describe("answers", () => {
  it("paints each add outcome", () => {
    const base: AddAgentResult = { name: "nova", worktree: "/w", outcome: "added", status: "pending-merge", pr, labels: null, setup: null, why: "ok" };
    expect(addNotice(base)).toEqual({ tone: "good", title: "Added nova", detail: "ok" });
    expect(addNotice({ ...base, outcome: "pr-failed", pr: null })).toMatchObject({ tone: "warn", title: "Added nova, but the roster PR was not opened" });
    expect(addNotice({ ...base, outcome: "refused", pr: null })).toMatchObject({ tone: "bad", title: "Add agent refused, nothing was created" });
  });

  it("warns over an added agent whose setup did not finish, and not over one whose setup passed", () => {
    const base: AddAgentResult = { name: "nova", worktree: "/w", outcome: "added", status: "pending-merge", pr, labels: null, setup: null, why: "env failed" };
    expect(addNotice({ ...base, setup: stopped })).toEqual({ tone: "warn", title: "Added nova, but its setup did not finish", detail: "env failed" });
    expect(addNotice({ ...base, setup: record(step()) })).toMatchObject({ tone: "good", title: "Added nova" });
    expect(addNotice({ ...base, setup: record(step()), labels: "nova-wip" })).toMatchObject({ title: "Added nova, but its labels need a hand" });
    // A roster PR that was not opened is still the headline.
    expect(addNotice({ ...base, outcome: "pr-failed", pr: null, setup: stopped }).title).toBe("Added nova, but the roster PR was not opened");
  });

  it("paints each delete outcome", () => {
    const base: DeleteAgentResult = { name: "rafa", worktree: "/w", outcome: "deleted", pr, why: "gone" };
    expect(deleteNotice(base)).toEqual({ tone: "good", title: "Deleted rafa's worktree", detail: "gone" });
    expect(deleteNotice({ ...base, outcome: "pr-failed" }).tone).toBe("warn");
    expect(deleteNotice({ ...base, outcome: "refused" })).toMatchObject({ tone: "bad", title: "Delete refused, nothing was removed" });
  });

  it("paints each create-checkout outcome", () => {
    const base: CreateCheckoutResult = { name: "rafa", worktree: "/w", outcome: "created", labels: null, setup: null, why: "at /w" };
    expect(checkoutNotice(base)).toEqual({ tone: "good", title: "Created rafa's checkout", detail: "at /w" });
    // A checkout whose labels are missing still cannot be started, so it warns.
    expect(checkoutNotice({ ...base, labels: "rafa-wip" })).toMatchObject({
      tone: "warn",
      title: "Created rafa's checkout, but its labels need a hand",
    });
    expect(checkoutNotice({ ...base, outcome: "incomplete" })).toMatchObject({ tone: "warn", title: "rafa's worktree is there, but it was not finished" });
    expect(checkoutNotice({ ...base, outcome: "incomplete", setup: stopped })).toMatchObject({
      tone: "warn",
      title: "rafa's worktree is there, but its setup did not finish",
    });
    expect(checkoutNotice({ ...base, outcome: "incomplete", setup: record(step()) }).title).toBe("rafa's worktree is there, but it was not finished");
    expect(checkoutNotice({ ...base, outcome: "refused", why: "not on the roster" })).toEqual({
      tone: "bad",
      title: "Create checkout refused, nothing was created",
      detail: "not on the roster",
    });
  });

  it("paints a start and a project removal", () => {
    const start: StartResult = { loop: "nova", action: "start", worktree: "/w", outcome: "refused", pid: null, why: "pending", at: "" };
    expect(startNotice(start)).toEqual({ tone: "warn", title: "Start refused, nothing was started", detail: "pending" });
    expect(startNotice({ ...start, outcome: "started", pid: 9 }).tone).toBe("good");
    const removed: RemoveProjectResult = { project: "p", outcome: "refused", why: "running", running: ["/a"] };
    expect(removeNotice(removed)).toEqual({ tone: "bad", title: "Remove refused, p stays registered", detail: "running\n/a" });
    expect(removeNotice({ ...removed, outcome: "removed", running: [] }).tone).toBe("good");
  });
});

describe("a setup rerun", () => {
  it("paints each outcome", () => {
    const base: RerunSetupResult = { name: "rafa", worktree: "/w", outcome: "passed", setup: record(step()), why: "all passed" };
    expect(rerunNotice(base)).toEqual({ tone: "good", title: "Setup passed in rafa's worktree", detail: "all passed" });
    expect(rerunNotice({ ...base, outcome: "failed", setup: stopped, why: "env" })).toEqual({ tone: "warn", title: "rafa's setup did not finish", detail: "env" });
    expect(rerunNotice({ ...base, outcome: "refused", worktree: null, setup: null, why: "running" })).toEqual({
      tone: "bad",
      title: "Rerun setup refused, nothing was run",
      detail: "running",
    });
  });
});

describe("setup steps", () => {
  it("lists nothing without a record or without steps", () => {
    expect(setupLines(null)).toEqual([]);
    expect(setupLines(record())).toEqual([]);
  });

  it("says how each step ended, in config order", () => {
    const lines = setupLines(
      record(
        step(),
        step({ name: "env", state: "failed", exitCode: 2, durationMs: 4_000, output: "no .env\n" }),
        step({ name: "seed", state: "timeout", exitCode: null, durationMs: 120_400 }),
        step({ name: "spawn", state: "failed", exitCode: null, durationMs: 3, error: "ENOENT" }),
        step({ name: "late", state: "skipped", exitCode: null, durationMs: null }),
      ),
    );
    expect(lines.map(({ name, state, summary }) => ({ name, state, summary }))).toEqual([
      { name: "install", state: "passed", summary: "passed in 12.3s" },
      { name: "env", state: "failed", summary: "failed with exit code 2 after 4.0s" },
      { name: "seed", state: "timeout", summary: "timed out after 120s" },
      { name: "spawn", state: "failed", summary: "could not start: ENOENT" },
      { name: "late", state: "skipped", summary: "skipped: an earlier step did not pass" },
    ]);
    expect(lines[1]!.output).toBe("no .env\n");
    expect(lines.map((line) => line.tone)).toEqual(["good", "bad", "bad", "bad", "neutral"]);
  });
});

describe("resuming a new agent's setup", () => {
  it("lands on the roster PR while it has not merged", () => {
    expect(resumeStep(agent())).toBe("pr");
  });

  it("lands on readiness once the roster lists it", () => {
    expect(resumeStep(agent({ status: "ready" }))).toBe("ready");
  });
});
