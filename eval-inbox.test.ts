import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { addEntry, inboxPath, inboxView, parseInbox, planTrials, readInbox, removeEntry, type InboxEntry } from "./eval-inbox";
import { scratchDir } from "./test-scratch";

const NOW = "2026-11-19T10:00:00.000Z";
const prPlan = { source: { kind: "pr", prs: [12, 14] }, arms: [{ name: "b", lineup: "live" }, { name: "c", lineup: "opus", overlay: "/home/x/overlay.md" }], repeats: 1 };

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "rec-1", plan: {}, recommendedBy: { kind: "agent", name: "rita" }, reason: "why", addedAt: NOW, ...over,
});

const writeRaw = (project: string, value: unknown): void => {
  const path = inboxPath(project);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

describe("the inbox store", () => {
  it("reads a missing file as an empty inbox", () => {
    expect(readInbox(scratchDir("ralph-inbox-"))).toEqual([]);
  });

  it("round-trips a plan: what is added reads back equal", async () => {
    const project = scratchDir("ralph-inbox-");
    const added = await addEntry(project, { plan: prPlan, recommendedBy: { kind: "person", name: "felipe" }, reason: "compare opus" }, NOW);
    expect(added.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const [read] = readInbox(project);
    expect(read).toEqual(added);
    expect(read!.plan).toEqual(prPlan);
  });

  it("keeps two sequential adds, with distinct ids", async () => {
    const project = scratchDir("ralph-inbox-");
    const first = await addEntry(project, { plan: prPlan, recommendedBy: { kind: "agent", name: "rita" }, reason: "one" }, NOW);
    const second = await addEntry(project, { plan: { clerk: "clara", sample: { cap: 3 } }, recommendedBy: { kind: "person", name: "felipe" }, reason: "two" }, NOW);
    expect(first.id).not.toBe(second.id);
    expect(readInbox(project).map((e) => e.reason)).toEqual(["one", "two"]);
  });

  it("serialises concurrent adds through the lock", async () => {
    const project = scratchDir("ralph-inbox-");
    await Promise.all(["a", "b", "c"].map((reason) => addEntry(project, { plan: prPlan, recommendedBy: { kind: "agent", name: "rita" }, reason }, NOW)));
    expect(readInbox(project).map((e) => e.reason).sort()).toEqual(["a", "b", "c"]);
  });

  it("removes an entry by id, and answers null for an unknown one", async () => {
    const project = scratchDir("ralph-inbox-");
    const added = await addEntry(project, { plan: prPlan, recommendedBy: { kind: "agent", name: "rita" }, reason: "one" }, NOW);
    expect(await removeEntry(project, "rec-nope")).toBeNull();
    expect(await removeEntry(project, added.id)).toEqual(added);
    expect(readInbox(project)).toEqual([]);
  });

  it("refuses a malformed file on disk and never overwrites it", async () => {
    const project = scratchDir("ralph-inbox-");
    const bad = { version: 1, entries: [entry({ recommendedBy: { kind: "robot", name: "x" } })] };
    writeRaw(project, bad);
    await expect(addEntry(project, { plan: prPlan, recommendedBy: { kind: "agent", name: "rita" }, reason: "r" }, NOW))
      .rejects.toThrow("entries[0].recommendedBy.kind must be \"agent\" or \"person\"");
    expect(JSON.parse(readFileSync(inboxPath(project), "utf8"))).toEqual(bad);
    writeRaw(project, "{not json");
    expect(() => readInbox(project)).toThrow("not JSON");
  });
});

describe("parseInbox", () => {
  const refuses = (value: unknown, message: string) => expect(() => parseInbox(value, "inbox")).toThrow(message);

  it("accepts a well-formed file", () => {
    expect(parseInbox({ version: 1, entries: [entry()] }).entries).toHaveLength(1);
  });

  it("names the dotted path of what is wrong", () => {
    refuses([], "inbox must be an object");
    refuses({ version: 2, entries: [] }, "version must be 1");
    refuses({ version: 1, entries: [], extra: 1 }, "unknown key extra");
    refuses({ version: 1, entries: {} }, "entries must be a list");
    refuses({ version: 1, entries: [entry({ plan: [] })] }, "entries[0].plan must be an object");
    refuses({ version: 1, entries: [entry(), entry({ id: "rec-2" }), entry({ id: "rec-3", recommendedBy: { kind: "bot", name: "x" } })] }, "entries[2].recommendedBy.kind must be \"agent\" or \"person\"");
    refuses({ version: 1, entries: [entry({ recommendedBy: { kind: "agent", name: "x", extra: 1 } })] }, "unknown key entries[0].recommendedBy.extra");
    refuses({ version: 1, entries: [entry({ recommendedBy: { kind: "agent", name: " " } })] }, "entries[0].recommendedBy.name must be a non-empty string");
    refuses({ version: 1, entries: [entry({ reason: "" })] }, "entries[0].reason must be a non-empty string");
    refuses({ version: 1, entries: [entry({ addedAt: "yesterday" })] }, "entries[0].addedAt must be a date");
    refuses({ version: 1, entries: [entry({ surprise: true })] }, "unknown key entries[0].surprise");
    refuses({ version: 1, entries: [entry(), entry()] }, "entries[1].id must be unique");
  });
});

describe("planTrials", () => {
  it("counts a PR plan as one case, as completePlan does", () => {
    expect(planTrials(prPlan)).toBe(1 * 2 * (1 + 1));
    expect(planTrials({ source: { kind: "pr", prs: [3] } })).toBe(1 * 1 * 3);
  });

  it("counts a clerk plan by its sample cap, repeating nothing by default", () => {
    expect(planTrials({ clerk: "clara", sample: { cap: 5 } })).toBe(5);
    expect(planTrials({ clerk: "clara", sample: { cap: 5 }, repeats: 1, arms: [{ name: "b" }, { name: "c" }] })).toBe(20);
  });

  it("counts a set plan by the cases it names, and cannot know one picked by tags or by nothing", () => {
    expect(planTrials({ source: { kind: "set", cases: ["a", "b", "c"] } })).toBe(9);
    expect(planTrials({ source: { kind: "set", tags: ["auth"] } })).toBeNull();
    expect(planTrials({ source: { kind: "set" } })).toBeNull();
  });

  it("repeats nothing by default on a noise-floor plan", () => {
    expect(planTrials({ source: { kind: "set", cases: ["a"] }, noiseFloor: {}, arms: [{ name: "b" }, { name: "c" }] })).toBe(2);
  });
});

describe("inboxView", () => {
  const stored = (plan: Record<string, unknown>): InboxEntry => ({ id: "rec-1", plan, recommendedBy: { kind: "agent", name: "rita" }, reason: "why", addedAt: NOW });

  it("summarises each source in one label", () => {
    const labels = inboxView([
      stored(prPlan),
      stored({ source: { kind: "set", tags: ["a", "b"] } }),
      stored({ source: { kind: "set", cases: ["x", "y", "z"] } }),
      stored({ source: { kind: "set" } }),
      stored({ clerk: "clara", sample: { cap: 4 } }),
    ]).map((row) => row.source);
    expect(labels).toEqual(["PR #12, #14", "test set (tags: a, b)", "test set (3 cases)", "test set", "clerk clara, up to 4 cases"]);
  });

  it("carries arms, repeats and trials, and never the plan", () => {
    const [row] = inboxView([stored(prPlan)]);
    expect(row).toEqual({ id: "rec-1", source: "PR #12, #14", arms: ["b", "c"], repeats: 1, trials: 4, recommendedBy: { kind: "agent", name: "rita" }, reason: "why", addedAt: NOW });
    expect(row).not.toHaveProperty("plan");
    expect(JSON.stringify(row)).not.toContain("/home/x");
  });
});

describe("eval-inbox.ts source", () => {
  it("cannot start a run: it imports only experimentsRoot from eval-runs", () => {
    const source = readFileSync(join(import.meta.dirname, "eval-inbox.ts"), "utf8");
    expect(source).not.toMatch(/startRun|\blaunch\b/);
    const fromRuns = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/eval-runs"/g)].map((match) => match[1]!.split(",").map((name) => name.trim()).filter(Boolean));
    expect(fromRuns).toEqual([["experimentsRoot"]]);
  });
});
