// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { currentProjectId, loopsWithRole, projectRoster, projectRosterEntries, roleOf, type RosterEntry } from "./roster";

const CONFIG = {
  repo: "felipearos/loggd",
  owner: "felipearosr",
  baseBranch: "main",
  displayName: "Loggd",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/loggd" },
};

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project(name: string, config?: unknown): string {
  const parent = mkdtempSync(join(tmpdir(), "ralph-roster-"));
  dirs.push(parent);
  const root = join(parent, name);
  mkdirSync(join(root, ".ralph"), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(config));
  return root;
}

describe("the project's roster", () => {
  it("is the project's own `loops`", () => {
    expect(projectRoster(project("loggd", { ...CONFIG, loops: ["nova", "vera"] }))).toEqual(["nova", "vera"]);
  });

  it("refuses to guess when the config names no loops, or there is no config", () => {
    expect(() => projectRoster(project("loggd", CONFIG))).toThrow(/missing 'loops'/);
    expect(() => projectRoster(project("scratch"))).toThrow(/\.ralph\/config\.json/);
  });

  it("refuses to guess past an invalid config", () => {
    expect(() => projectRoster(project("loggd", { ...CONFIG, loops: ["ralph", "ralph"] }))).toThrow(/repeats 'ralph'/);
  });
});

describe("the roster's roles", () => {
  const MIXED = ["ralph", { name: "tria", role: "triager" }, "rafa", { name: "doc", role: "ci-doctor" }, { name: "nova" }];

  it("pairs every loop with its role, a plain name and a role-less object as coders", () => {
    const root = project("loggd", { ...CONFIG, loops: MIXED });
    expect(projectRoster(root)).toEqual(["ralph", "tria", "rafa", "doc", "nova"]);
    expect(projectRosterEntries(root)).toEqual([
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "rafa", role: "coder" },
      { name: "doc", role: "ci-doctor" },
      { name: "nova", role: "coder" },
    ]);
  });

  it("reads loggd's roster of plain names as coders only", () => {
    const roster = projectRosterEntries(project("loggd", { ...CONFIG, loops: ["ralph", "rafa", "remo", "rulo"] }));
    expect(loopsWithRole("coder", roster)).toEqual(["ralph", "rafa", "remo", "rulo"]);
    expect(loopsWithRole("triager", roster)).toEqual([]);
    expect(loopsWithRole("ci-doctor", roster)).toEqual([]);
    expect(roleOf("remo", roster)).toBe("coder");
  });

  it("answers roleOf for a roster loop, and null for any other name", () => {
    const roster = projectRosterEntries(project("loggd", { ...CONFIG, loops: MIXED }));
    expect(roleOf("tria", roster)).toBe("triager");
    expect(roleOf("doc", roster)).toBe("ci-doctor");
    expect(roleOf("ralph", roster)).toBe("coder");
    expect(roleOf("nova", roster)).toBe("coder");
    expect(roleOf("vera", roster)).toBeNull();
  });

  it("lists loopsWithRole in roster order", () => {
    const roster: RosterEntry[] = [
      { name: "doc", role: "ci-doctor" },
      { name: "ralph", role: "coder" },
      { name: "tria", role: "triager" },
      { name: "rafa", role: "coder" },
    ];
    expect(loopsWithRole("coder", roster)).toEqual(["ralph", "rafa"]);
    expect(loopsWithRole("triager", roster)).toEqual(["tria"]);
    expect(loopsWithRole("ci-doctor", roster)).toEqual(["doc"]);
  });

  it("reads the project's roster when none is passed", () => {
    const previous = process.env.RALPH_PROJECT;
    process.env.RALPH_PROJECT = project("loggd", { ...CONFIG, loops: MIXED });
    try {
      expect(roleOf("tria")).toBe("triager");
      expect(loopsWithRole("coder")).toEqual(["ralph", "rafa", "nova"]);
    } finally {
      if (previous === undefined) delete process.env.RALPH_PROJECT;
      else process.env.RALPH_PROJECT = previous;
    }
  });

  it("refuses to guess past an unknown role", () => {
    expect(() => projectRosterEntries(project("loggd", { ...CONFIG, loops: [{ name: "tria", role: "judge" }] }))).toThrow(
      /'loops\[0\]\.role' must be one of coder, triager, ci-doctor, pr-medic, clerk, verifier/,
    );
  });
});

describe("the project's id", () => {
  it("is the main checkout's directory, from any worktree of it", () => {
    const main = project("Loggd");
    const admin = join(main, ".git", "worktrees", "rafa-loop");
    mkdirSync(admin, { recursive: true });
    const worktree = project("rafa-loop");
    writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
    expect(currentProjectId(main, {})).toBe("loggd");
    expect(currentProjectId(worktree, {})).toBe("loggd");
  });

  it("is RALPH_PROJECT_ID when the starter names one, and refuses a malformed one", () => {
    const root = project("loggd");
    expect(currentProjectId(root, { RALPH_PROJECT_ID: "loggd-2" })).toBe("loggd-2");
    expect(() => currentProjectId(root, { RALPH_PROJECT_ID: "Not An Id" })).toThrow(/RALPH_PROJECT_ID/);
  });
});
