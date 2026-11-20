/**
 * The project registry: which repos the dashboard knows as projects.
 *
 * It lives at `ralph/projects.json` under the XDG config home (`~/.config` by
 * default) as `[{ id, path, addedAt, source }]`, and every dashboard process on
 * the machine reads and writes the same file. A write is a read-modify-write
 * under an exclusive lock file, committed as a temp file in the same directory
 * and an atomic rename: two processes adding at once both land, and a reader
 * never sees half a file.
 *
 * A missing registry is seeded from the roots the dashboard was started with
 * (`RALPH_DASHBOARD_ROOTS`, else the project it was started from). When
 * `RALPH_DASHBOARD_ROOTS` is set it also overrides the file for the run: the
 * run observes exactly those roots and the registry is read-only, so fixtures
 * and tests can point the dashboard at scratch roots.
 *
 * This is a write path, kept apart from the observation reads like the control
 * and lifecycle adapters. It runs no subprocess: a project's id is read from
 * the checkout's `.git` directly, by the harness's `project-id.ts` — the same
 * rule a loop keys its lineup and Jav routing by.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PROJECT_ID, projectIdFor } from "../project-id";
import { PROJECT_SOURCES, type Env, type ProjectSource, type ProjectView } from "./contracts";

/** One registry entry, exactly as `projects.json` stores it. */
export type RegisteredProject = ProjectView;

/** A registry entry with the roots the dashboard observes for it. */
export interface ProjectEntry extends RegisteredProject {
  /** Absolute checkout roots to observe: `[path]`, or the override's roots. */
  roots: string[];
}

export class ProjectRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

/**
 * A worktrees folder the registry will not take, as opposed to a registry it
 * cannot read or lock: the route answers this one as a refusal in its words.
 */
export class WorktreesFolderRefused extends ProjectRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "WorktreesFolderRefused";
  }
}

export interface ProjectRegistry {
  readonly file: string;
  /** True when `RALPH_DASHBOARD_ROOTS` overrides the file for this run. */
  readonly readOnly: boolean;
  /** Registered projects, in registration order. Re-read on every call. */
  list(): ProjectEntry[];
  add(entry: { path: string; id?: string; source?: ProjectSource }): RegisteredProject;
  /** False when no project had that id. */
  remove(id: string): boolean;
  /**
   * Sets the folder the project's new agent worktrees are created in; `null`
   * clears it back to the dashboard's default. Refuses an unknown id or a
   * folder `checkWorktreesFolder` rejects.
   */
  setWorktrees(id: string, folder: string | null): ProjectEntry;
}

/** `$XDG_CONFIG_HOME/ralph/projects.json`, else `~/.config/ralph/projects.json`. */
export function projectsFile(env: Env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : join(env.HOME?.trim() || "/", ".config");
  return join(base, "ralph", "projects.json");
}

export { PROJECT_ID, projectIdFor };

/**
 * Roots grouped by project — by the repo's main checkout, not its name — in
 * first-seen order. Two repos sharing a directory name get distinct ids.
 */
function groupRoots(roots: readonly string[]): { id: string; path: string; roots: string[] }[] {
  const groups: { id: string; path: string; roots: string[] }[] = [];
  for (const root of roots) {
    const { id, path } = projectIdFor(root);
    const group = groups.find((entry) => entry.path === path);
    if (group !== undefined) {
      if (!group.roots.includes(resolve(root))) group.roots.push(resolve(root));
      continue;
    }
    let unique = id;
    for (let n = 2; groups.some((entry) => entry.id === unique); n += 1) unique = `${id}-${n}`;
    groups.push({ id: unique, path, roots: [resolve(root)] });
  }
  return groups;
}

function parseRegistry(file: string, text: string): RegisteredProject[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectRegistryError(`${file} is not JSON`);
  }
  if (!Array.isArray(raw)) throw new ProjectRegistryError(`${file} must be a list of projects`);
  return raw.map((entry: unknown, at) => {
    const value = entry as Partial<RegisteredProject> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      !PROJECT_ID.test(value.id) ||
      typeof value.path !== "string" ||
      !isAbsolute(value.path) ||
      typeof value.addedAt !== "string" ||
      !PROJECT_SOURCES.includes(value.source as ProjectSource) ||
      (value.worktrees !== undefined && (typeof value.worktrees !== "string" || !isAbsolute(value.worktrees)))
    ) {
      throw new ProjectRegistryError(`${file}[${at}] is not a project entry`);
    }
    const project: RegisteredProject = {
      id: value.id,
      path: value.path,
      addedAt: value.addedAt,
      source: value.source as ProjectSource,
    };
    // Absent stays absent: the file never grows a `worktrees: null` key.
    if (value.worktrees !== undefined) project.worktrees = value.worktrees;
    return project;
  });
}

/** The nearest ancestor of `path` (itself included) that exists, and the tail below it. */
function nearestExisting(path: string): { dir: string; tail: string } {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir, tail: relative(dir, resolve(path)) };
}

/** `path` with symlinks resolved as far as it exists, so containment is physical. */
function physical(path: string): string {
  const { dir, tail } = nearestExisting(path);
  try {
    return join(realpathSync(dir), tail);
  } catch {
    return resolve(path);
  }
}

/** Whether `child` is `parent` or below it. A child named `..x` is below, so only a `..` segment is outside. */
function within(parent: string, child: string): boolean {
  const below = relative(parent, child);
  return below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

/**
 * Why `folder` cannot hold a project's agent worktrees, or null when it can.
 * The folder itself need not exist yet (Add agent creates it), but the nearest
 * existing ancestor must be a writable directory. It must not sit inside any
 * registered checkout, the project's own included: a worktree there shows up
 * as untracked files in that repo, which the supervisor reads as work to
 * recover, and its cleans would sweep it. Nor may it be another project's
 * folder, where two agents of one name would claim the same `<name>-loop`.
 * `self` is the project the folder is for, whose own folder it may repeat.
 */
export function checkWorktreesFolder(
  folder: string,
  projects: readonly { id: string; path: string; worktrees?: string }[],
  self?: string,
): string | null {
  if (!isAbsolute(folder)) return `must be an absolute path; got '${folder}'`;
  const { dir } = nearestExisting(folder);
  try {
    if (!statSync(dir).isDirectory()) return `${dir} is not a directory, so ${folder} cannot be created`;
    accessSync(dir, constants.W_OK);
  } catch {
    return `${dir} is not writable, so ${folder} cannot be created there`;
  }
  const target = physical(folder);
  for (const project of projects) {
    if (within(physical(project.path), target)) {
      return project.id === self
        ? `${folder} is inside this project's own checkout at ${project.path}`
        : `${folder} is inside project '${project.id}''s checkout at ${project.path}`;
    }
    if (project.id !== self && project.worktrees !== undefined && physical(project.worktrees) === target) {
      return `${folder} is already project '${project.id}''s worktrees folder`;
    }
  }
  return null;
}

let tempSequence = 0;

/** Temp file in the same directory, then rename: all or nothing. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${tempSequence++}.tmp`;
  try {
    const fd = openSync(temp, "w", 0o644);
    try {
      const bytes = Buffer.from(text, "utf8");
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already renamed, or never created.
    }
    throw error;
  }
}

const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 30_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Run `body` holding the registry's lock file, shared with every process. */
function withLock<T>(file: string, body: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
      } catch {
        // Released between the open and the stat: try again.
      }
      if (Date.now() > deadline) throw new ProjectRegistryError(`${lock} is held by another process`);
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try {
    return body();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Removed as stale by another process; nothing left to release.
    }
  }
}

const serialize = (projects: readonly RegisteredProject[]): string => `${JSON.stringify(projects, null, 2)}\n`;

export function createProjectRegistry({
  file,
  seed,
  override,
  now = () => new Date(),
}: {
  file: string;
  /** Roots a missing registry is seeded from. */
  seed: readonly string[];
  /** When non-null, the roots this run observes instead of the file's. */
  override: readonly string[] | null;
  now?: () => Date;
}): ProjectRegistry {
  const read = (): RegisteredProject[] => (existsSync(file) ? parseRegistry(file, readFileSync(file, "utf8")) : []);

  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    withLock(file, () => {
      // Another process may have seeded it while this one waited.
      if (existsSync(file)) return;
      const addedAt = now().toISOString();
      writeAtomically(
        file,
        serialize(groupRoots(seed).map(({ id, path }) => ({ id, path, addedAt, source: "local" as const }))),
      );
    });
  }

  if (override !== null) {
    const addedAt = now().toISOString();
    const projects: ProjectEntry[] = groupRoots(override).map(({ id, path, roots }) => ({
      id,
      path,
      addedAt,
      source: "local",
      roots,
    }));
    const refuse = (): never => {
      throw new ProjectRegistryError("RALPH_DASHBOARD_ROOTS overrides the project registry for this run; it is read-only");
    };
    // The folder's refusal is the operator's to read on the Settings page, so it is a refused folder, not a broken registry.
    const refuseFolder = (): never => {
      throw new WorktreesFolderRefused("RALPH_DASHBOARD_ROOTS overrides the project registry for this run; it is read-only");
    };
    return {
      file,
      readOnly: true,
      list: () => projects.map((project) => ({ ...project, roots: [...project.roots] })),
      add: refuse,
      remove: refuse,
      setWorktrees: refuseFolder,
    };
  }

  return {
    file,
    readOnly: false,
    list: () => read().map((project) => ({ ...project, roots: [project.path] })),
    add: ({ path, id, source = "local" }) => {
      if (!isAbsolute(path)) throw new ProjectRegistryError(`a project path must be absolute; got '${path}'`);
      const project: RegisteredProject = {
        id: id ?? projectIdFor(path).id,
        path: id === undefined ? projectIdFor(path).path : resolve(path),
        addedAt: now().toISOString(),
        source,
      };
      if (!PROJECT_ID.test(project.id)) throw new ProjectRegistryError(`'${project.id}' is not a valid project id`);
      return withLock(file, () => {
        const projects = read();
        const clash = projects.find((entry) => entry.id === project.id || entry.path === project.path);
        if (clash !== undefined) {
          throw new ProjectRegistryError(`project '${clash.id}' at ${clash.path} is already registered`);
        }
        // The folder rule holds in both orders: a checkout may not be added
        // around a folder another project's worktrees already live in.
        const around = projects.find((entry) => entry.worktrees !== undefined && within(physical(project.path), physical(entry.worktrees)));
        if (around !== undefined) {
          throw new ProjectRegistryError(`${project.path} holds project '${around.id}''s worktrees folder ${around.worktrees}; move that folder first`);
        }
        writeAtomically(file, serialize([...projects, project]));
        return project;
      });
    },
    remove: (id) =>
      withLock(file, () => {
        const projects = read();
        const kept = projects.filter((entry) => entry.id !== id);
        if (kept.length === projects.length) return false;
        writeAtomically(file, serialize(kept));
        return true;
      }),
    setWorktrees: (id, folder) =>
      withLock(file, () => {
        // Validated under the lock, against the entries as they stand now;
        // `add` checks the other order, a checkout added around a folder.
        const projects = read();
        const at = projects.findIndex((entry) => entry.id === id);
        if (at === -1) throw new WorktreesFolderRefused(`no project '${id}' is registered`);
        const project: RegisteredProject = { ...projects[at]! };
        delete project.worktrees;
        if (folder !== null) {
          const reason = checkWorktreesFolder(folder, projects, id);
          if (reason !== null) throw new WorktreesFolderRefused(`worktrees folder for '${id}': ${reason}`);
          project.worktrees = resolve(folder);
        }
        projects[at] = project;
        writeAtomically(file, serialize(projects));
        return { ...project, roots: [project.path] };
      }),
  };
}
