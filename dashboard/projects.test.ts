// @vitest-environment node
/**
 * The project registry, driven through its public surface: what `list()`
 * answers, what lands in `projects.json`, and what two processes writing it at
 * once leave behind.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bunPath } from "./fixtures";
import { checkWorktreesFolder, createProjectRegistry, projectIdFor, projectsFile, ProjectRegistryError, WorktreesFolderRefused } from "./projects";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs the project registry CLI under bun");

const scratch: string[] = [];
afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const dir = (): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "ralph-projects-")));
  scratch.push(path);
  return path;
};

/** A main checkout: a `.git` directory, as `git clone` leaves one. */
const checkout = (parent: string, name: string): string => {
  const path = join(parent, name);
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
};

/** A linked worktree of `main`: a `.git` file naming its admin directory. */
const linkedWorktree = (parent: string, main: string, name: string): string => {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  mkdirSync(join(main, ".git", "worktrees", name), { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${join(main, ".git", "worktrees", name)}\n`);
  return path;
};

const NOW = () => new Date("2026-09-23T12:00:00.000Z");
const onDisk = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

describe("where the registry lives", () => {
  it("is ralph/projects.json under the XDG config home, else ~/.config", () => {
    expect(projectsFile({ HOME: "/home/op" })).toBe("/home/op/.config/ralph/projects.json");
    expect(projectsFile({ HOME: "/home/op", XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/ralph/projects.json");
  });
});

describe("a project's id", () => {
  it("is the repo's directory name, for the main checkout and any worktree of it", () => {
    const parent = dir();
    const main = checkout(parent, "loggd");
    const loop = linkedWorktree(parent, main, "ralph-loop");
    expect(projectIdFor(main)).toEqual({ id: "loggd", path: main });
    expect(projectIdFor(loop)).toEqual({ id: "loggd", path: main });
  });

  it("falls back to the directory name when there is no readable .git", () => {
    const parent = dir();
    expect(projectIdFor(join(parent, "Some Repo"))).toEqual({ id: "some-repo", path: join(parent, "Some Repo") });
  });
});

describe("seeding and overriding", () => {
  it("seeds a missing registry from the roots, one project per repo", () => {
    const parent = dir();
    const main = checkout(parent, "loggd");
    const loop = linkedWorktree(parent, main, "ralph-loop");
    const file = join(parent, "config", "ralph", "projects.json");
    const registry = createProjectRegistry({ file, seed: [loop, main], override: null, now: NOW });

    expect(registry.readOnly).toBe(false);
    expect(onDisk(file)).toEqual([{ id: "loggd", path: main, addedAt: "2026-09-23T12:00:00.000Z", source: "local" }]);
    expect(registry.list()).toEqual([
      { id: "loggd", path: main, addedAt: "2026-09-23T12:00:00.000Z", source: "local", roots: [main] },
    ]);
  });

  it("keeps two repos that share a directory name apart", () => {
    const one = checkout(dir(), "app");
    const two = checkout(dir(), "app");
    const registry = createProjectRegistry({ file: join(dir(), "projects.json"), seed: [], override: [one, two], now: NOW });
    expect(registry.list().map(({ id, roots }) => [id, roots])).toEqual([
      ["app", [one]],
      ["app-2", [two]],
    ]);
  });

  it("leaves an existing registry alone", () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    const existing = [{ id: "other", path: "/srv/other", addedAt: "2026-01-01T00:00:00.000Z", source: "github" }];
    writeFileSync(file, JSON.stringify(existing));
    const registry = createProjectRegistry({ file, seed: [checkout(parent, "loggd")], override: null, now: NOW });
    expect(onDisk(file)).toEqual(existing);
    expect(registry.list().map((project) => project.id)).toEqual(["other"]);
  });

  it("serves the override roots for the run, read-only, and still seeds a missing file from them", () => {
    const parent = dir();
    const main = checkout(parent, "loggd");
    const loop = linkedWorktree(parent, main, "ralph-loop");
    const scratchRoot = join(parent, "scratch");
    const file = join(parent, "projects.json");
    const registry = createProjectRegistry({ file, seed: [loop, scratchRoot], override: [loop, scratchRoot], now: NOW });

    expect(registry.readOnly).toBe(true);
    // The run observes exactly the roots it was given, grouped by project.
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "loggd", roots: [loop] }),
      expect.objectContaining({ id: "scratch", roots: [scratchRoot] }),
    ]);
    expect((onDisk(file) as { id: string }[]).map((project) => project.id)).toEqual(["loggd", "scratch"]);
    expect(() => registry.add({ path: join(parent, "x") })).toThrow(ProjectRegistryError);
    expect(() => registry.remove("loggd")).toThrow(ProjectRegistryError);
    expect(() => registry.setWorktrees("loggd", join(parent, "agents"))).toThrow(/read-only/);
  });

  it("refuses a registry that is not a list of projects, loudly", () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    writeFileSync(file, '{"id":"loggd"}');
    expect(() => createProjectRegistry({ file, seed: [], override: null, now: NOW }).list()).toThrow(/projects\.json/);
  });
});

describe("adding and removing", () => {
  it("adds and removes projects, writing the file each time", () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    const registry = createProjectRegistry({ file, seed: [checkout(parent, "loggd")], override: null, now: NOW });
    const added = registry.add({ path: checkout(parent, "widgets"), source: "github" });
    expect(added).toEqual({ id: "widgets", path: join(parent, "widgets"), addedAt: "2026-09-23T12:00:00.000Z", source: "github" });
    expect((onDisk(file) as { id: string }[]).map((project) => project.id)).toEqual(["loggd", "widgets"]);

    expect(registry.remove("loggd")).toBe(true);
    expect(registry.remove("loggd")).toBe(false);
    expect(registry.list().map((project) => project.id)).toEqual(["widgets"]);
  });

  it("refuses a relative path and a duplicate id or path", () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    const loggd = checkout(parent, "loggd");
    const registry = createProjectRegistry({ file, seed: [loggd], override: null, now: NOW });
    expect(() => registry.add({ path: "loggd" })).toThrow(/absolute/);
    expect(() => registry.add({ path: loggd })).toThrow(/already registered/);
    expect(() => registry.add({ path: join(dir(), "loggd") })).toThrow(/already registered/);
  });

  it("never loses or corrupts an entry when two processes write at once", async () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    writeFileSync(file, "[]");
    const writer = (label: string) =>
      new Promise<void>((resolve, reject) => {
        const script = [
          `import { createProjectRegistry } from ${JSON.stringify(join(__dirname, "projects.ts"))};`,
          `const registry = createProjectRegistry({ file: ${JSON.stringify(file)}, seed: [], override: null });`,
          `for (let i = 0; i < 25; i++) registry.add({ path: ${JSON.stringify(parent)} + "/${label}-" + i });`,
        ].join("\n");
        const child = spawn(bunPath(), ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    await Promise.all([writer("a"), writer("b")]);
    const ids = (onDisk(file) as { id: string }[]).map((project) => project.id).sort();
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  }, 30_000);

  it("never loses an entry or a worktrees folder when one process sets it while another adds", async () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    const projectA = checkout(parent, "alpha");
    writeFileSync(file, JSON.stringify([{ id: "alpha", path: projectA, addedAt: "2026-01-01T00:00:00.000Z", source: "local" }]));
    const run = (body: string) =>
      new Promise<void>((resolve, reject) => {
        const script = [
          `import { createProjectRegistry } from ${JSON.stringify(join(__dirname, "projects.ts"))};`,
          `const registry = createProjectRegistry({ file: ${JSON.stringify(file)}, seed: [], override: null });`,
          body,
        ].join("\n");
        const child = spawn(bunPath(), ["-e", script], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
      });
    await Promise.all([
      run(`for (let i = 0; i < 25; i++) registry.setWorktrees("alpha", ${JSON.stringify(parent)} + "/agents-" + i);`),
      run(`for (let i = 0; i < 25; i++) registry.add({ path: ${JSON.stringify(parent)} + "/b-" + i });`),
    ]);
    const projects = onDisk(file) as { id: string; worktrees?: string }[];
    expect(projects).toHaveLength(26);
    expect(new Set(projects.map((project) => project.id)).size).toBe(26);
    expect(projects.find((project) => project.id === "alpha")?.worktrees).toBe(join(parent, "agents-24"));
  }, 30_000);
});

describe("a project's worktrees folder", () => {
  const registryWith = () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    const loggd = checkout(parent, "loggd");
    const widgets = checkout(parent, "widgets");
    const registry = createProjectRegistry({ file, seed: [loggd, widgets], override: null, now: NOW });
    return { parent, file, loggd, widgets, registry };
  };

  it("is set, listed and cleared back to the default, the key leaving the file", () => {
    const { parent, file, registry } = registryWith();
    const folder = join(parent, "agents");
    mkdirSync(folder);
    expect(registry.setWorktrees("loggd", folder)).toEqual(
      expect.objectContaining({ id: "loggd", worktrees: folder, roots: [join(parent, "loggd")] }),
    );
    expect(registry.list().find((project) => project.id === "loggd")?.worktrees).toBe(folder);
    expect((onDisk(file) as { worktrees?: string }[])[0]).toEqual(expect.objectContaining({ worktrees: folder }));

    const cleared = registry.setWorktrees("loggd", null);
    expect(cleared).not.toHaveProperty("worktrees");
    expect((onDisk(file) as object[])[0]).not.toHaveProperty("worktrees");
    expect(registry.list().find((project) => project.id === "loggd")).not.toHaveProperty("worktrees");
  });

  it("accepts a folder that does not exist yet under a writable directory", () => {
    const { parent, registry } = registryWith();
    const folder = join(parent, "not", "yet", "here");
    expect(registry.setWorktrees("loggd", folder).worktrees).toBe(folder);
  });

  it("refuses a relative path", () => {
    const { registry } = registryWith();
    expect(() => registry.setWorktrees("loggd", "agents")).toThrow(/absolute path; got 'agents'/);
  });

  it.skipIf(process.getuid?.() === 0)("refuses a folder it cannot create or write", () => {
    const { parent, file, registry } = registryWith();
    const locked = join(parent, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      expect(() => registry.setWorktrees("loggd", join(locked, "agents"))).toThrow(/locked.*not writable/);
      expect(() => registry.setWorktrees("loggd", locked)).toThrow(/not writable/);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect((onDisk(file) as object[])[0]).not.toHaveProperty("worktrees");
  });

  it("refuses a folder at or inside another project's checkout, through a symlink too", () => {
    const { parent, widgets, registry } = registryWith();
    expect(() => registry.setWorktrees("loggd", widgets)).toThrow(/project 'widgets'/);
    expect(() => registry.setWorktrees("loggd", join(widgets, "agents"))).toThrow(/project 'widgets'/);
    const link = join(parent, "link");
    symlinkSync(widgets, link);
    expect(() => registry.setWorktrees("loggd", join(link, "agents"))).toThrow(/project 'widgets'/);
    // A child named `..x` is inside; a sibling name is not.
    expect(() => registry.setWorktrees("loggd", join(widgets, "..agents"))).toThrow(/project 'widgets'/);
    expect(registry.setWorktrees("loggd", join(parent, "widgets-agents")).worktrees).toBe(join(parent, "widgets-agents"));
  });

  it("refuses a folder inside the project's own checkout, which its supervisor would read as untracked work", () => {
    const { loggd, registry } = registryWith();
    expect(() => registry.setWorktrees("loggd", join(loggd, "agents"))).toThrow(/this project's own checkout/);
  });

  it("refuses another project's folder, where two agents of one name would share a worktree", () => {
    const { parent, registry } = registryWith();
    const shared = join(parent, "agents");
    registry.setWorktrees("widgets", shared);
    expect(() => registry.setWorktrees("loggd", shared)).toThrow(/already project 'widgets''s worktrees folder/);
    // Setting a project's own folder again is no clash with itself.
    expect(registry.setWorktrees("widgets", shared).worktrees).toBe(shared);
  });

  it("refuses to add a checkout around a folder another project's worktrees live in", () => {
    const { parent, registry } = registryWith();
    const outer = join(parent, "outer");
    mkdirSync(outer);
    registry.setWorktrees("widgets", join(outer, "agents"));
    expect(() => registry.add({ path: outer })).toThrow(/holds project 'widgets''s worktrees folder/);
    expect(registry.list().map((project) => project.id)).toEqual(["loggd", "widgets"]);
  });

  it("refuses a folder as a WorktreesFolderRefused, which the route tells from a broken registry", () => {
    const { registry } = registryWith();
    expect(() => registry.setWorktrees("loggd", "agents")).toThrow(WorktreesFolderRefused);
    expect(() => registry.setWorktrees("nope", "/tmp")).toThrow(WorktreesFolderRefused);
  });

  it("refuses an unknown project id", () => {
    const { parent, registry } = registryWith();
    expect(() => registry.setWorktrees("nope", join(parent, "agents"))).toThrow(/'nope'/);
  });

  it("refuses a registry entry whose worktrees is not an absolute path", () => {
    const parent = dir();
    const file = join(parent, "projects.json");
    writeFileSync(
      file,
      JSON.stringify([{ id: "x", path: "/srv/x", addedAt: "2026-01-01T00:00:00.000Z", source: "local", worktrees: "rel" }]),
    );
    expect(() => createProjectRegistry({ file, seed: [], override: null, now: NOW }).list()).toThrow(/is not a project entry/);
  });

  it("checks a folder against the given checkouts only", () => {
    const parent = dir();
    const own = checkout(parent, "own");
    expect(checkWorktreesFolder(join(own, "agents"), [])).toBeNull();
    expect(checkWorktreesFolder(join(own, "agents"), [{ id: "own", path: own }])).toMatch(/project 'own'/);
    expect(checkWorktreesFolder(join(own, "agents"), [{ id: "own", path: own }], "own")).toMatch(/own checkout/);
  });
});
