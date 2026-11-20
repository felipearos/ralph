import { describe, expect, it } from "vitest";

import type { LoopStatus, ProjectHealthView, ProjectView } from "../contracts";
import {
  apiPath,
  landingProject,
  needsYouText,
  pagePath,
  parseLocation,
  shellPage,
  switcherHealth,
  switcherView,
} from "./project-model";

const project = (id: string, path = `/home/op/${id}`): ProjectView => ({
  id,
  path,
  addedAt: "2026-09-23T00:00:00.000Z",
  source: "local",
});

describe("a location", () => {
  it("names its project and the page within it", () => {
    expect(parseLocation("/p/loggd/loops/rafa")).toEqual({ project: "loggd", rest: "/loops/rafa" });
    expect(parseLocation("/p/loggd/usage")).toEqual({ project: "loggd", rest: "/usage" });
    expect(parseLocation("/p/loggd/")).toEqual({ project: "loggd", rest: "/" });
    expect(parseLocation("/p/loggd")).toEqual({ project: "loggd", rest: "/" });
  });

  it("has no project when unscoped", () => {
    expect(parseLocation("/")).toEqual({ project: null, rest: "/" });
    expect(parseLocation("/loops/rafa")).toEqual({ project: null, rest: "/loops/rafa" });
  });
});

describe("the page the shell draws", () => {
  it("is the intake page at /p/:project/intake, on either surface", () => {
    expect(shellPage("/p/acme-intake/intake", false)).toEqual({ kind: "intake", project: "acme-intake" });
    expect(shellPage("/p/acme-intake/intake", true)).toEqual({ kind: "intake", project: "acme-intake" });
    // The router takes these to the intake route too, so they get its theme.
    expect(shellPage("/p/acme-intake/intake/", false)).toEqual({ kind: "intake", project: "acme-intake" });
    expect(shellPage("/p/acme-intake/Intake", false)).toEqual({ kind: "intake", project: "acme-intake" });
  });

  it("is the loop dashboard anywhere else on the full surface", () => {
    expect(shellPage("/p/acme-intake/", false)).toEqual({ kind: "dashboard" });
    expect(shellPage("/", false)).toEqual({ kind: "dashboard" });
  });

  it("is not found anywhere else on the intake deployment", () => {
    expect(shellPage("/p/acme-intake/", true)).toEqual({ kind: "not-found", project: "acme-intake" });
    expect(shellPage("/p/acme-intake", true)).toEqual({ kind: "not-found", project: "acme-intake" });
    expect(shellPage("/p/acme-intake/usage", true)).toEqual({ kind: "not-found", project: "acme-intake" });
    expect(shellPage("/", true)).toEqual({ kind: "not-found", project: null });
  });
});

describe("paths within a project", () => {
  it("prefix pages with /p/:project", () => {
    expect(pagePath("loggd", "/")).toBe("/p/loggd/");
    expect(pagePath("loggd", "/loops/rafa")).toBe("/p/loggd/loops/rafa");
    expect(parseLocation(pagePath("my.repo", "/usage"))).toEqual({ project: "my.repo", rest: "/usage" });
  });

  it("prefix API routes with /api/p/:project, keeping the query", () => {
    expect(apiPath("loggd", "/api/loops")).toBe("/api/p/loggd/loops");
    expect(apiPath("loggd", "/api/lineup?loop=ralph")).toBe("/api/p/loggd/lineup?loop=ralph");
    expect(apiPath("loggd", "/api/loops/ra%20fa/output")).toBe("/api/p/loggd/loops/ra%20fa/output");
  });

  it("leave a path outside the API alone", () => {
    expect(apiPath("loggd", "/elsewhere")).toBe("/elsewhere");
  });
});

describe("the landing project", () => {
  const projects = [project("loggd"), project("widgets")];

  it("is the one used last, while it is still registered", () => {
    expect(landingProject(projects, "widgets")).toBe("widgets");
  });

  it("is the first registered otherwise", () => {
    expect(landingProject(projects, null)).toBe("loggd");
    expect(landingProject(projects, "removed")).toBe("loggd");
  });

  it("is none when nothing is registered", () => {
    expect(landingProject([], "loggd")).toBeNull();
  });
});

describe("the project switcher", () => {
  it("shows the selected project and lists every project, with Add project last", () => {
    const view = switcherView([project("loggd"), project("widgets")], "widgets", "/usage");
    expect(view.current).toEqual({ id: "widgets", label: "widgets", detail: "/home/op/widgets" });
    expect(view.items.map((item) => [item.id, item.active])).toEqual([
      ["loggd", false],
      ["widgets", true],
    ]);
    expect(view.add).toEqual({ label: "Add project", disabled: false });
  });

  it("keeps the overview page when switching, but leaves a loop page for the project's agents", () => {
    const projects = [project("loggd"), project("widgets")];
    expect(switcherView(projects, "loggd", "/usage").items[1]!.href).toBe("/p/widgets/usage");
    expect(switcherView(projects, "loggd", "/loops/rafa").items[1]!.href).toBe("/p/widgets/");
    // The All projects floor is no project's page: switching from it opens the project's agents.
    expect(switcherView(projects, "loggd", "/factory").items[1]!.href).toBe("/p/widgets/");
  });

  it("with one project lists only it", () => {
    const view = switcherView([project("loggd")], "loggd", "/");
    expect(view.items.map((item) => item.id)).toEqual(["loggd"]);
    expect(view.current.id).toBe("loggd");
  });

  it("names the selected project even before the list has loaded", () => {
    expect(switcherView(null, "loggd", "/").current).toEqual({ id: "loggd", label: "loggd", detail: null });
    expect(switcherView(null, "loggd", "/").items).toEqual([]);
  });
});

describe("other projects' health in the switcher", () => {
  const projects = [project("loggd"), project("widgets"), project("gadgets")];
  const health = (over: Partial<ProjectHealthView> & { project: string }): ProjectHealthView => ({
    readAt: "2026-09-23T00:00:00.000Z",
    health: "idle",
    needsYou: 0,
    needs: [],
    loops: 2,
    running: 0,
    problem: null,
    ...over,
  });

  it("gives each other project a dot and its needs-you count, and the selected one neither", () => {
    const view = switcherView(projects, "loggd", "/", [
      health({
        project: "widgets",
        health: "needs-you",
        needsYou: 2,
        needs: [
          { loop: "ralph", reason: "approval" },
          { loop: "rafa", reason: "errored" },
        ],
      }),
      health({ project: "gadgets", health: "running", running: 1, loops: 3 }),
    ]);
    expect(view.items.map((item) => [item.id, item.health])).toEqual([
      ["loggd", null],
      ["widgets", { tone: "bad", needsYou: 2, label: "2 need you: ralph awaits approval, rafa stopped on an error" }],
      ["gadgets", { tone: "good", needsYou: 0, label: "1 of 3 loops running" }],
    ]);
  });

  it("sums what needs the operator elsewhere, for the closed switcher", () => {
    const blocked = (loop: string) => ({ loop, reason: "blocked" as const });
    const view = switcherView(projects, "loggd", "/", [
      health({ project: "widgets", health: "needs-you", needsYou: 2, needs: [blocked("ralph"), blocked("rafa")] }),
      health({ project: "gadgets", health: "needs-you", needsYou: 1, needs: [blocked("remo")] }),
    ]);
    expect(view.elsewhere).toBe(3);
    expect(needsYouText(view.elsewhere)).toBe("3 need you");
    expect(needsYouText(1)).toBe("1 needs you");
  });

  it("never counts the selected project, even when a read of it is handed in", () => {
    const view = switcherView(projects, "widgets", "/", [health({ project: "widgets", health: "needs-you", needsYou: 4 })]);
    expect(view.items.find((item) => item.id === "widgets")!.health).toBeNull();
    expect(view.elsewhere).toBe(0);
  });

  it("shows no dot for a project not read yet, or before any health has loaded", () => {
    expect(switcherView(projects, "loggd", "/", [health({ project: "widgets" })]).items[2]!.health).toBeNull();
    expect(switcherView(projects, "loggd", "/").items.every((item) => item.health === null)).toBe(true);
    expect(switcherView(projects, "loggd", "/").elsewhere).toBe(0);
  });

  it("tones trouble red, degraded amber, running green, idle blue and unreadable grey", () => {
    expect(
      switcherHealth(health({ project: "w", health: "needs-you", needsYou: 1, needs: [{ loop: "ralph", reason: "blocked" }] })),
    ).toEqual({ tone: "bad", needsYou: 1, label: "1 needs you: ralph is blocked" });
    expect(switcherHealth(health({ project: "w", health: "degraded" })).tone).toBe("warn");
    expect(switcherHealth(health({ project: "w", health: "running", running: 2 })).tone).toBe("good");
    expect(switcherHealth(health({ project: "w", health: "idle" }))).toEqual({
      tone: "info",
      needsYou: 0,
      label: "2 loops, none running",
    });
    expect(switcherHealth(health({ project: "w", health: "idle", loops: 0 })).label).toBe("No loop has a checkout");
    expect(switcherHealth(health({ project: "w", health: "unknown", loops: 0, problem: "roster contract drift" }))).toEqual({
      tone: "neutral",
      needsYou: 0,
      label: "Could not be read: roster contract drift",
    });
  });

  it("says why a project is unreadable in plain words when the reason is a known one", () => {
    const unknown = (over: Partial<ProjectHealthView>) => switcherHealth(health({ project: "w", health: "unknown", loops: 0, ...over }));
    expect(unknown({ problem: "… (ENOENT); a project opts in …", problemKind: "not-set-up" })).toEqual({
      tone: "neutral",
      needsYou: 0,
      label: "Not a Ralph project yet: it has no .ralph/config.json",
    });
    expect(unknown({ problem: "the project folder /p/w does not exist", problemKind: "missing" })).toMatchObject({
      tone: "warn",
      label: "Its folder is gone from this machine; restore it, or remove the project in Settings",
    });
    expect(
      unknown({ problem: "/p/w/.ralph/config.json is invalid:\n  - loops must be an array\n  - merge is unknown", problemKind: "invalid-config" }),
    ).toMatchObject({ tone: "warn", label: "Its .ralph/config.json does not validate: loops must be an array (and 1 more)" });
    expect(unknown({ problem: "/p/w/.ralph/config.json is not valid JSON: bad", problemKind: "invalid-config" }).label).toBe(
      "Its .ralph/config.json is not valid JSON",
    );
    // Anything else keeps its raw reason: a guessed plain one would mislead.
    expect(unknown({ problem: "loop-state unavailable: timed out", problemKind: "unreadable" }).label).toBe(
      "Could not be read: loop-state unavailable: timed out",
    );
  });

  it("names the loops that make a project degraded", () => {
    const agent = (loop: string, loopStatus: LoopStatus) =>
      ({ loop, loopStatus, supervisor: "alive", stage: null, lastEvent: null }) as const;
    const degraded = (agents: ProjectHealthView["agents"]) => switcherHealth(health({ project: "w", health: "degraded", agents })).label;
    expect(degraded([agent("rafa", "stale"), agent("testo", "running"), agent("tria", "unknown")])).toBe(
      "rafa has gone quiet, tria cannot be read",
    );
    expect(degraded([agent("rafa", "running")])).toBe("A loop's pause and stop controls cannot be read");
    expect(degraded(undefined)).toBe("A loop is stale or unknown, or its controls cannot be read");
  });
});
