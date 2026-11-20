/**
 * The project the shell is rendering, for code outside React (fetch URLs,
 * links, commands). The address bar can run ahead of the screen during a
 * navigation; the screen is what the operator acts on, so a command sent
 * right after a navigation goes to the project actually on screen.
 */
import { parseLocation } from "./project-model";

// `undefined` until the shell first renders: nothing recorded yet, so the
// address bar is the best guess. `null` is a recorded "no project" (the floor).
let recorded: string | null | undefined;

/** Records the project the shell is rendering; `null` where it renders none. */
export function setScreenProject(project: string | null): void {
  recorded = project;
}

/** The project on screen; the address bar's until the shell has recorded one. */
export function screenProject(): string | null {
  if (recorded !== undefined) return recorded;
  if (typeof window === "undefined") return null;
  return parseLocation(window.location.pathname).project;
}

/** Forgets the recorded project, so a test starts from the address-bar fallback. */
export function resetScreenProjectForTests(): void {
  recorded = undefined;
}
