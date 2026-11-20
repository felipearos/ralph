// @vitest-environment node
/**
 * The project pages, held three ways: the UI's route tree, the paths the
 * local server answers with the shell (`SHELL_PAGES`), and the hosted
 * dashboard's rewrites in `vercel.json`. A page added to one and not the
 * others opens locally and 404s when hosted, or the other way round; this
 * pins them together.
 */
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import vercel from "../../vercel.json";
import { isShellPath, SHELL_PAGES } from "../routes";
import { createRouterFor, type RoutePages } from "./route-tree";

const stub = () => null;
const pages: RoutePages = {
  App: stub,
  Agents: stub,
  Loop: stub,
  overview: {
    notifications: stub,
    usage: stub,
    backlog: stub,
    ci: stub,
    learnings: stub,
    evals: stub,
    ownership: stub,
    reconciliation: stub,
    labels: stub,
  },
  Settings: stub,
  States: stub,
  Floor: stub,
  Landing: stub,
  Intake: stub,
};

const PROJECT = "/p/$project";
/** The loop page's route; the server and the rewrites take every `/loops/<name>` by prefix. */
const LOOP_ROUTE = "/loops/$name";

/**
 * The routes the tree has, as paths below `/p/:project` for a project's pages.
 * Filtered on the full path, not the parent: `/intake` sits under the root, to
 * stand outside the project chrome, yet it is still addressed under a project.
 * The `$` splat (an unknown page, drawn as Agents) and the `/factory` redirect
 * (an old address that moves up to the floor) are not pages of their own. The
 * unscoped `/factory` is listed, though: the shell is served there too.
 */
function routedPages(): string[] {
  const router = createRouterFor(pages, createMemoryHistory({ initialEntries: ["/"] }));
  const paths = Object.values(router.routesById).map((route) => route.fullPath as string);
  const scoped = paths
    .filter((path) => path.startsWith(`${PROJECT}/`))
    .map((path) => path.slice(PROJECT.length))
    .filter((path) => path !== "/$" && path !== "/factory");
  return [...scoped, ...paths.filter((path) => path === "/factory")];
}

// Imported, not read with node:fs: dashboard/ui typechecks without node's types.
const config: { rewrites: { source: string; destination: string }[] } = vercel;

/** Where Vercel sends `pathname`: as in vercel-config.test.ts, the sources are anchored regexes. */
function rewrite(pathname: string): string | null {
  for (const { source, destination } of config.rewrites) {
    if (new RegExp(`^${source}$`).test(pathname)) return destination;
  }
  return null;
}

/** A path as one concrete address: the loop route's param filled in. */
const concrete = (path: string) => (path === LOOP_ROUTE ? "/loops/y" : path);

describe("the route list", () => {
  const drawn = routedPages();

  it("has every page as a typed route", () => {
    for (const path of [LOOP_ROUTE, "/", "/usage", "/settings", "/states", "/intake", "/factory"]) {
      expect(drawn).toContain(path);
    }
  });

  it("is what the local server serves the shell at, and the other way round", () => {
    expect(drawn.map(concrete).filter((path) => !isShellPath(path))).toEqual([]);
    const pagesWithoutLoop = drawn.filter((path) => path !== LOOP_ROUTE).sort();
    expect(pagesWithoutLoop).toEqual([...SHELL_PAGES].sort());
  });

  it("is what the hosted rewrites send to the shell, under a project and unscoped", () => {
    const missing: string[] = [];
    for (const path of drawn.map(concrete)) {
      // `/p/x/` and `/p/x` are a project's Agents page; its unscoped form `/` is the
      // static index itself, served without a rewrite.
      const addresses = path === "/" ? ["/p/x/", "/p/x"] : [`/p/x${path}`, path];
      // Every other page's unscoped address, `/intake` included, is one the
      // local server serves or 302s into a project (`isShellPath`): an old
      // bookmark the shell moves into the last project (or, for `/factory`,
      // the All projects floor). Hosted, it must reach the shell too.
      for (const address of addresses) if (rewrite(address) !== "/index.html") missing.push(address);
    }
    expect(missing.sort()).toEqual([]);
  });
});
