import { describe, expect, it } from "vitest";

import type { DashboardLoop, HealthAgentView, ProjectHealthView, ProjectView } from "../contracts";
import { projectHue, projectMarks, railView } from "./project-rail-model";

const project = (id: string): ProjectView => ({ id, path: `/home/me/${id}`, addedAt: "2026-10-01T00:00:00Z", source: "local" });

const agent = (loop: string, over: Partial<HealthAgentView> = {}): HealthAgentView => ({
  loop,
  loopStatus: "idle",
  supervisor: "alive",
  stage: "gate",
  lastEvent: "frontier-wait",
  ...over,
});
const dead = { supervisor: "dead", loopStatus: "interrupted", stage: "stopped", lastEvent: "interrupted" } as const;

const health = (id: string, agents: HealthAgentView[], over: Partial<ProjectHealthView> = {}): ProjectHealthView => ({
  project: id,
  readAt: "2026-10-28T12:00:00Z",
  health: "idle",
  needsYou: 0,
  needs: [],
  loops: agents.length,
  running: 0,
  agents,
  problem: null,
  ...over,
});

/** Only the fields the rail reads; the rest of a loop does not reach it. */
const loop = (over: Partial<DashboardLoop>) =>
  ({ supervisor: "alive", stage: "iteration", loopStatus: "running", lastEvent: null, ...over }) as DashboardLoop;

describe("a project's letters", () => {
  it("are two letters, three where two collide, never the same twice", () => {
    const marks = projectMarks([
      "loggd",
      "software-factory",
      "acme-agentes",
      "acme-pwa",
      "acme-intake-pruebas",
      "demo-hackathon-2026",
      "acme-backoffice",
      "acme-backoffice-oai",
    ]);
    expect(Object.fromEntries(marks)).toEqual({
      loggd: "LG",
      "software-factory": "SF",
      "acme-agentes": "AA",
      "acme-pwa": "APW",
      "acme-intake-pruebas": "APR",
      "demo-hackathon-2026": "DH",
      "acme-backoffice": "AB",
      "acme-backoffice-oai": "AO",
    });
    expect(new Set(marks.values()).size).toBe(marks.size);
    // Even names that agree on every letter the rule reads stay apart.
    expect([...projectMarks(["a-bc", "a-bd", "a-bcx"]).values()]).toEqual(["ABC", "ABD", "AB2"]);
  });

  it("have a hue that is the name's alone, the same on every read", () => {
    expect(projectHue("loggd")).toBe(projectHue("loggd"));
    expect(projectHue("loggd")).not.toBe(projectHue("software-factory"));
    expect(projectHue("loggd")).toBeGreaterThanOrEqual(0);
    expect(projectHue("loggd")).toBeLessThan(360);
  });
});

describe("the project rail", () => {
  const projects = ["acme", "loggd", "dormant", "fresh"].map(project);

  it("marks each project's agents, busiest first, and folds the ones with every agent down", () => {
    const rail = railView({
      projects,
      selected: "loggd",
      rest: "/usage",
      health: [
        health("acme", [agent("tria"), agent("ralph", { loopStatus: "running", stage: "iteration", lastEvent: "pr-wait" }), agent("rafa", { loopStatus: "running", stage: "iteration", lastEvent: "phase" })], {
          health: "running",
          running: 2,
        }),
        health("dormant", [agent("ralph", dead), agent("rafa", dead)]),
      ],
      selectedLoops: [loop({ loopStatus: "failed" }), loop({})],
      onFloor: false,
    });
    expect(rail.live.map((tile) => [tile.id, tile.agents, tile.tone, tile.active, tile.href])).toEqual([
      ["acme", ["working", "waiting", "idle"], "good", false, "/p/acme/usage"],
      ["loggd", ["blocked", "working"], "bad", true, "/p/loggd/usage"],
      // Not read yet: no marks and no tone, and not folded away on a guess.
      ["fresh", [], null, false, "/p/fresh/usage"],
    ]);
    expect(rail.live[0]!.lines).toEqual(["acme", "1 working · 1 waiting · 1 idle", "2 of 3 loops running"]);
    expect(rail.dormant.map((tile) => tile.id)).toEqual(["dormant"]);
  });

  it("draws six squares and counts the rest", () => {
    const many = Array.from({ length: 9 }, (_, index) => agent(`a${index}`));
    const rail = railView({ projects, selected: "loggd", rest: "/", health: [health("acme", many)], selectedLoops: null, onFloor: false });
    expect(rail.live[0]).toMatchObject({ id: "acme", more: 3 });
    expect(rail.live[0]!.agents).toHaveLength(6);
  });

  it("lights no project on the floor, and opens a project's agents from it", () => {
    const rail = railView({ projects, selected: "loggd", rest: "/factory", health: [], selectedLoops: [], onFloor: true });
    expect([...rail.live, ...rail.dormant].find((tile) => tile.id === "loggd")).toMatchObject({ active: false, href: "/p/loggd/" });
    // With nothing running it folds below the rule like any dormant project.
    expect(rail.dormant.map((tile) => tile.id)).toContain("loggd");
  });

  it("folds a folder that is not a Ralph project yet below the rule, and says so plainly", () => {
    const unread = {
      health: "unknown",
      loops: 0,
      problem: "roster contract drift: cannot read the project config at /home/me/fresh: …",
      problemKind: "not-set-up",
    } as const;
    const { agents: _agents, ...notSetUp } = health("fresh", [], unread);
    const rail = railView({ projects, selected: "loggd", rest: "/", health: [notSetUp], selectedLoops: [loop({})], onFloor: false });
    const tile = rail.dormant.find((entry) => entry.id === "fresh");
    expect(tile).toMatchObject({ tone: "neutral", lines: ["fresh", "Not a Ralph project yet: it has no .ralph/config.json"] });
  });
});
