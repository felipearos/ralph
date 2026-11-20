/**
 * The dashboard's route shapes, shared by the local server and the remote
 * Vercel function, and the two predicates the local server gates every request
 * with (`hostAllowed`, `sameSiteWrite` — the remote function has its own).
 *
 * This module has no imports, and must keep none: the Vercel function imports
 * it, and anything it pulled in would drag `server.ts`'s process-spawning
 * graph into the function bundle with it.
 */

/**
 * The shell's client-side routes within a project: the overview pages and
 * `/loops/:name`. The shell reads the path itself, so a deep link or a reload
 * works. Exported so a test can hold it against the UI's route tree and the
 * hosted rewrites (dashboard/ui/route-consistency.test.ts).
 */
export const SHELL_PAGES: ReadonlySet<string> = new Set(["/", "/factory", "/notifications", "/usage", "/backlog", "/ci", "/learnings", "/evals", "/ownership", "/reconciliation", "/labels", "/settings", "/states", "/intake"]);
export const isShellPath = (pathname: string): boolean => SHELL_PAGES.has(pathname) || pathname.startsWith("/loops/");

/**
 * The pages above any one project: `/` (which opens the last project) and the
 * All projects floor. They are the shell as they are, never redirected into a
 * project, because they belong to none.
 */
const TOP_LEVEL_PAGES = new Set(["/", "/factory"]);
export const isTopLevelPage = (pathname: string): boolean => TOP_LEVEL_PAGES.has(pathname);

/** Every other project's health, for the switcher. Served at the top level, not per project. */
export const PROJECTS_HEALTH_PATH = "/api/projects/health";

/** `/api/p/:project/…`: an API route scoped to one project. */
export const SCOPED_API_PATH = /^\/api\/p\/([^/]+)(\/.*)?$/;
/** `/p/:project/…`: a page scoped to one project. */
export const SCOPED_PAGE_PATH = /^\/p\/([^/]+)(\/.*)?$/;

/** A loop's iteration log, as server-sent events. */
export const OUTPUT_PATH = /^\/api\/loops\/([^/]+)\/output$/;

/**
 * The `Host` names the local server answers to. A browser page whose name was
 * re-pointed at 127.0.0.1 (DNS rebinding) reaches the socket with its OWN name
 * in `Host`, and that is the one header it cannot forge; refusing anything but
 * these keeps such a page from reading loop state or sending commands.
 * The spellings a browser or a local client actually sends — `[::1]` bracketed,
 * as the port strip below would otherwise eat the `:1` of a bare `::1` — plus
 * the tailnet (`tailscale serve` forwards the machine's
 * `<name>.<tailnet>.ts.net`) and whatever the operator adds.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "0.0.0.0"]);

/**
 * Whether a `Host` header (or the URL's host when there is none) is one of ours.
 * `extra` is compared as given, so its names must already be lower-cased and
 * port-less — `configFromEnv` normalises `RALPH_DASHBOARD_HOSTS` that way.
 */
export function hostAllowed(host: string | null, extra: ReadonlySet<string> = new Set()): boolean {
  if (host === null) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (name === "") return false;
  return LOOPBACK_HOSTS.has(name) || name.endsWith(".ts.net") || extra.has(name);
}

/**
 * Whether a write came from the dashboard's own page, by the browser's own
 * account. `Sec-Fetch-Site` is set by every current browser and cannot be set
 * by a script; `Origin` is the fallback for older ones. A client that sends
 * neither (the bridge relay, `curl`, a test's `Request`) is not a browser, so
 * no other site can be riding its cookies: it is let through.
 *
 * `same-site` is refused on purpose, hence the `CrossOrigin` the server
 * answers: a sibling name under one tailnet is a different origin, and the
 * dashboard's own page always reports `same-origin`.
 */
export function sameSiteWrite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return origin === new URL(request.url).origin;
}
