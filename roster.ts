/**
 * The loop's project, as the harness keys it: which project this is, and
 * which loops work it.
 *
 * The roster is the project's own — `loops` in its `.ralph/config.json` — so
 * two projects may both run a `ralph`. The id keys that project's blocks in
 * the harness-wide `models.json` and `jav.json`, so those two `ralph`s need
 * not share a lineup or a route.
 *
 * Each loop holds a role (`roles.ts`): a plain name is a coder, and an entry
 * `{ "name", "role" }` names another. The claim fences read every name
 * whatever its role (`projectRoster`); what differs by role reads
 * `roleOf` and `loopsWithRole`.
 */
import { projectRoot } from "./paths";
import { loadProjectConfig, type RosterEntry } from "./project-config";
import type { Role } from "./roles";

export { currentProjectId } from "./project-id";
export type { RosterEntry } from "./project-config";

/**
 * The loops that work this project, by name, in roster order, whatever their
 * role.
 *
 * A checkout with no config, or an invalid one, THROWS: guessing a roster
 * there would validate a claim label against loops the project never named.
 */
export function projectRoster(root: string = projectRoot()): readonly string[] {
  return loadProjectConfig(root).loops;
}

/** The loops that work this project with their roles, in roster order. Throws like `projectRoster`. */
export function projectRosterEntries(root: string = projectRoot()): readonly RosterEntry[] {
  return loadProjectConfig(root).roster;
}

/**
 * `loop`'s role, or null when `loop` is not on the roster. The roster is the
 * project's unless one is passed.
 */
export function roleOf(loop: string, roster: readonly RosterEntry[] = projectRosterEntries()): Role | null {
  return roster.find((entry) => entry.name === loop)?.role ?? null;
}

/**
 * The names of every loop holding `role`, in roster order. "The coders" is
 * `loopsWithRole("coder")`: every entry whose role is coder, string or object.
 */
export function loopsWithRole(role: Role, roster: readonly RosterEntry[] = projectRosterEntries()): string[] {
  return roster.filter((entry) => entry.role === role).map((entry) => entry.name);
}
