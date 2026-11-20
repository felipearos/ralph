/**
 * The current project's URLs. The shell's project is the one on screen, so
 * every fetch and in-app link is scoped to it without threading the project
 * through every component.
 */
import { apiPath, pagePath } from "./project-model";
import { screenProject } from "./screen-project";

/** `/api/x` scoped to the project the shell is showing. */
export function api(path: string): string {
  const project = screenProject();
  return project === null ? path : apiPath(project, path);
}

/** A page within the project the shell is showing. */
export function page(rest: string): string {
  const project = screenProject();
  return project === null ? rest : pagePath(project, rest);
}

let remote: boolean | undefined;

/**
 * Whether this is the remote dashboard's page: the static build flags its
 * document with `<meta name="ralph-remote" content="1">`. Read once; the local
 * shell never carries it, so every remote affordance stays off there.
 */
export function isRemote(): boolean {
  remote ??= document.querySelector('meta[name="ralph-remote"]')?.getAttribute("content") === "1";
  return remote;
}

/**
 * Whether this is the open intake deployment (`RALPH_REMOTE_SURFACE=intake`),
 * which serves the intake page alone: its build flags the document with
 * `<meta name="ralph-surface" content="intake">`.
 */
export function isIntakeSurface(): boolean {
  return document.querySelector('meta[name="ralph-surface"]')?.getAttribute("content") === "intake";
}
