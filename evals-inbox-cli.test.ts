import { describe, expect, it } from "vitest";

import { addEntry, readInbox } from "./eval-inbox";
import { runEvalsInbox, type EvalsInboxDeps } from "./evals-inbox";
import { scratchDir } from "./test-scratch";

const NOW = "2026-11-19T10:00:00.000Z";
const PLAN = { source: { kind: "pr", prs: [7] }, arms: [{ name: "b", lineup: "live" }], repeats: 0 };

function fakeDeps(over: Partial<EvalsInboxDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const starts: { project: string; plan: Record<string, unknown> }[] = [];
  const deps: EvalsInboxDeps = {
    now: () => NOW,
    user: () => "felipe",
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: async () => JSON.stringify(PLAN),
    start: (project, plan) => { starts.push({ project, plan }); return { id: "run-1" }; },
    check: () => {},
    ...over,
  };
  return { deps, out, err, starts, json: () => JSON.parse(out.at(-1)!) as Record<string, any> };
}

const seed = (project: string) => addEntry(project, { plan: PLAN, recommendedBy: { kind: "agent", name: "rita" }, reason: "try it" }, NOW);

describe("evals-inbox list", () => {
  it("prints the rows and never starts a run", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const added = await seed(project);
    const fake = fakeDeps();
    expect(await runEvalsInbox(["list", "--project", project], fake.deps)).toBe(0);
    expect(fake.json()).toEqual({ version: 1, entries: [{ id: added.id, source: "PR #7", arms: ["b"], repeats: 0, trials: 1, recommendedBy: { kind: "agent", name: "rita" }, reason: "try it", addedAt: NOW }] });
    expect(fake.starts).toEqual([]);
  });
});

describe("evals-inbox add", () => {
  it("records the operator as the recommender and stores the plan", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps();
    expect(await runEvalsInbox(["add", "--reason", "compare", "--project", project], fake.deps)).toBe(0);
    const { entry } = fake.json();
    expect(entry.recommendedBy).toEqual({ kind: "person", name: "felipe" });
    expect(entry).not.toHaveProperty("plan");
    const [stored] = readInbox(project);
    expect(stored!.plan).toEqual(PLAN);
    expect(stored!.id).toBe(entry.id);
    expect(fake.starts).toEqual([]);
  });

  it("records an agent with --agent and --by", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps();
    expect(await runEvalsInbox(["add", "--reason", "r", "--agent", "--by", "rita", "--project", project], fake.deps)).toBe(0);
    expect(readInbox(project)[0]!.recommendedBy).toEqual({ kind: "agent", name: "rita" });
  });

  it("stores nothing when the plan check refuses it", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps({ check: () => { throw new Error("eval plan: must name a source"); } });
    expect(await runEvalsInbox(["add", "--reason", "r", "--project", project], fake.deps)).toBe(1);
    expect(fake.err).toEqual(["evals-inbox: eval plan: must name a source"]);
    expect(fake.out).toEqual([]);
    expect(readInbox(project)).toEqual([]);
  });

  it("refuses a plan that is not JSON, and needs --reason", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps({ stdin: async () => "{nope" });
    expect(await runEvalsInbox(["add", "--reason", "r", "--project", project], fake.deps)).toBe(1);
    expect(await runEvalsInbox(["add", "--project", project], fakeDeps().deps)).toBe(64);
    expect(readInbox(project)).toEqual([]);
  });
});

describe("evals-inbox start", () => {
  it("starts the stored plan once and removes the entry", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const added = await seed(project);
    const fake = fakeDeps();
    expect(await runEvalsInbox(["start", added.id, "--project", project], fake.deps)).toBe(0);
    expect(fake.starts).toEqual([{ project, plan: PLAN }]);
    expect(fake.json()).toEqual({ version: 1, run: { id: "run-1" }, removed: added.id });
    expect(readInbox(project)).toEqual([]);
  });

  it("keeps the entry when the starter refuses", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const added = await seed(project);
    const fake = fakeDeps({ start: () => { throw new Error("eval: run-1 is already running"); } });
    expect(await runEvalsInbox(["start", added.id, "--project", project], fake.deps)).toBe(1);
    expect(fake.err).toEqual(["evals-inbox: eval: run-1 is already running"]);
    expect(readInbox(project)).toEqual([added]);
  });

  it("takes the entry out before the run starts, so a second start of it finds nothing", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const added = await seed(project);
    const later = await addEntry(project, { plan: PLAN, recommendedBy: { kind: "person", name: "felipe" }, reason: "later" }, "2026-11-19T13:00:00.000Z");
    let seen: string[] | null = null;
    const fake = fakeDeps({ start: () => { seen = readInbox(project).map((e) => e.id); throw new Error("eval plan: no"); } });
    expect(await runEvalsInbox(["start", added.id, "--project", project], fake.deps)).toBe(1);
    expect(seen).toEqual([later.id]);
    // The refused start put it back in its place, oldest first.
    expect(readInbox(project).map((e) => e.id)).toEqual([added.id, later.id]);
    const again = fakeDeps();
    expect(await runEvalsInbox(["start", added.id, "--project", project], again.deps)).toBe(0);
    expect(await runEvalsInbox(["start", added.id, "--project", project], again.deps)).toBe(1);
    expect(again.starts).toHaveLength(1);
  });

  it("refuses an unknown id", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps();
    expect(await runEvalsInbox(["start", "rec-nope", "--project", project], fake.deps)).toBe(1);
    expect(fake.err).toEqual(["evals-inbox: no inbox entry rec-nope"]);
    expect(fake.starts).toEqual([]);
  });
});

describe("evals-inbox dismiss", () => {
  it("removes the entry without starting it", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const added = await seed(project);
    const fake = fakeDeps();
    expect(await runEvalsInbox(["dismiss", added.id, "--project", project], fake.deps)).toBe(0);
    expect(fake.json()).toEqual({ version: 1, removed: added.id });
    expect(readInbox(project)).toEqual([]);
    expect(fake.starts).toEqual([]);
  });

  it("refuses an unknown id", async () => {
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps();
    expect(await runEvalsInbox(["dismiss", "rec-nope", "--project", project], fake.deps)).toBe(1);
    expect(fake.err).toEqual(["evals-inbox: no inbox entry rec-nope"]);
  });
});

describe("evals-inbox usage", () => {
  it("exits 64 on an unknown command or flag", async () => {
    // --project keeps the CLI from asking git for the project, so this file spawns nothing.
    const project = scratchDir("ralph-inbox-cli-");
    const fake = fakeDeps();
    expect(await runEvalsInbox(["run"], fake.deps)).toBe(64);
    expect(await runEvalsInbox(["list", "--json"], fake.deps)).toBe(64);
    expect(await runEvalsInbox(["start", "--project", project], fake.deps)).toBe(64);
    expect(fake.starts).toEqual([]);
  });
});
