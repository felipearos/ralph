import { createMemoryHistory, isRedirect, type ValidateLinkOptions } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { parseLocation } from "./project-model";
import { committedPath, createRouterFor, screenOf, type RoutePages, type Screen } from "./route-tree";

// The real tree with stand-in pages: app.tsx does not load in node, and what
// this pins is which route an address lands on, not what it draws.
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

async function leaf(url: string) {
  const router = createRouterFor(pages, createMemoryHistory({ initialEntries: [url] }));
  await router.load();
  const match = router.state.matches.at(-1)!;
  return { routeId: match.routeId as string, params: match.params as Record<string, string>, href: router.state.location.href, statuses: router.state.matches.map((m) => m.status) };
}

describe("dashboard route tree", () => {
  it.each([
    ["/p/loggd", "/p/$project/"],
    ["/p/loggd/", "/p/$project/"],
    // Each overview page has its own route; the address stays the one it was.
    ["/p/loggd/notifications", "/p/$project/notifications"],
    ["/p/loggd/usage", "/p/$project/usage"],
    ["/p/loggd/backlog", "/p/$project/backlog"],
    ["/p/loggd/ci", "/p/$project/ci"],
    ["/p/loggd/learnings", "/p/$project/learnings"],
    ["/p/loggd/ownership", "/p/$project/ownership"],
    ["/p/loggd/reconciliation", "/p/$project/reconciliation"],
    ["/p/loggd/labels", "/p/$project/labels"],
    ["/p/loggd/settings", "/p/$project/settings"],
    ["/p/loggd/states", "/p/$project/states"],
    // Unknown pages fall to the project's splat, which draws Agents for them.
    ["/p/loggd/nope", "/p/$project/$"],
    // The intake surface out-ranks that splat, though it sits outside the project route.
    ["/p/loggd/intake", "/p/$project/intake"],
    ["/", "/"],
    ["/factory", "/factory"],
    // An unscoped old bookmark lands, to be moved into the remembered project.
    ["/usage", "/$"],
  ])("routes %s to %s", async (url, routeId) => {
    const result = await leaf(url);
    expect(result.routeId).toBe(routeId);
    // Found, and left as typed: no 404, no trailing-slash redirect.
    expect(result.statuses.every((status) => status === "success")).toBe(true);
    expect(result.href).toBe(url);
  });

  // In node the router loads as on a server: it records a redirect for the
  // response instead of following it, and following it needs `window`. So
  // this pins both halves the browser chains: the address reaches the
  // redirect route (not the splat), and that route moves it to `/factory`.
  it("moves a project's floor address up to the unscoped floor", () => {
    const router = createRouterFor(pages, createMemoryHistory({ initialEntries: ["/p/loggd/factory"] }));
    expect(router.matchRoutes("/p/loggd/factory").at(-1)?.routeId).toBe("/p/$project/factory");
    let thrown: unknown;
    try {
      router.routesById["/p/$project/factory"].options.beforeLoad?.({} as never);
    } catch (error) {
      thrown = error;
    }
    if (!isRedirect(thrown)) throw new Error("the project's floor route did not redirect");
    expect(thrown.options.replace).toBe(true);
    expect(router.resolveRedirect(thrown).headers.get("Location")).toBe("/factory");
  });

  it("routes a project to its own param", async () => {
    expect((await leaf("/p/loggd")).params.project).toBe("loggd");
  });

  it.each([
    ["/p/loggd/loops/rafa", "rafa"],
    ["/p/loggd/loops/rafa/", "rafa"],
    ["/p/loggd/loops/a%20b", "a b"],
  ])("routes %s to the loop page, named %s", async (url, name) => {
    const result = await leaf(url);
    expect(result.routeId).toBe("/p/$project/loops/$name");
    expect(result.params).toMatchObject({ project: "loggd", name });
    expect(result.href).toBe(url);
  });
});

describe("the screen a committed match draws", () => {
  it.each([
    ["/p/loggd", { page: "agents" }],
    ["/p/loggd/loops/rafa", { page: "loop", name: "rafa" }],
    ["/p/loggd/loops/a%20b", { page: "loop", name: "a b" }],
    ["/p/loggd/usage", { page: "usage" }],
    // Matched case-insensitively: the chrome must name the page the body draws.
    ["/p/loggd/Usage", { page: "usage" }],
    ["/p/loggd/labels", { page: "labels" }],
    ["/p/loggd/settings", { page: "settings" }],
    ["/p/loggd/states", { page: "states" }],
    ["/p/loggd/intake", { page: "intake" }],
    ["/factory", { page: "factory" }],
    ["/p/loggd/nope", { page: "agents" }],
    ["/", { page: "landing" }],
    ["/usage", { page: "landing" }],
  ])("reads %s as %o", async (url, expected) => {
    const router = createRouterFor(pages, createMemoryHistory({ initialEntries: [url] }));
    await router.load();
    expect(screenOf(router.state.matches.at(-1))).toEqual(expected);
  });

  it("falls back without throwing when nothing is committed or the route is unknown", () => {
    expect(screenOf(undefined)).toEqual({ page: "landing" });
    expect(screenOf({ routeId: "/p/$project/someday", params: {} })).toEqual({ page: "agents" });
    expect(screenOf({ routeId: "/someday", params: {} })).toEqual({ page: "landing" });
  });
});

describe("the page preload a route's loader starts", () => {
  function recording(initial: string, preload?: (screen: Screen, project: string | null) => void) {
    const calls: [Screen, string | null][] = [];
    const router = createRouterFor(
      {
        ...pages,
        preload: (screen, project) => {
          calls.push([screen, project]);
          preload?.(screen, project);
        },
      },
      createMemoryHistory({ initialEntries: [initial] }),
    );
    return { router, calls };
  }

  it("preloads a hovered link's page once, with its screen and project", async () => {
    const { router, calls } = recording("/p/loggd/usage");
    await router.load();
    calls.length = 0;
    await router.preloadRoute({ to: "/p/$project/loops/$name", params: { project: "loggd", name: "rafa" } });
    expect(calls).toEqual([[{ page: "loop", name: "rafa" }, "loggd"]]);
  });

  it("preloads a plain anchor's href, the way usePreloadHref asks", async () => {
    const { router, calls } = recording("/p/loggd/usage");
    await router.load();
    calls.length = 0;
    await router.preloadRoute({ href: "/p/loggd/loops/rafa" } as unknown as Parameters<typeof router.preloadRoute>[0]);
    expect(calls).toEqual([[{ page: "loop", name: "rafa" }, "loggd"]]);
  });

  it("re-runs the loader on every intent, leaving the Query keep-alive to decide whether a read happens", async () => {
    const { router, calls } = recording("/p/loggd/usage");
    await router.load();
    calls.length = 0;
    await router.preloadRoute({ to: "/p/$project/labels", params: { project: "loggd" } });
    await router.preloadRoute({ to: "/p/$project/labels", params: { project: "loggd" } });
    expect(calls).toEqual([
      [{ page: "labels" }, "loggd"],
      [{ page: "labels" }, "loggd"],
    ]);
  });

  it("preloads the page a navigation lands on", async () => {
    const { router, calls } = recording("/p/loggd");
    await router.load();
    calls.length = 0;
    // In node the router loads as on a server and no <RouterProvider>
    // follows the history, so the move and the load it chains are made here.
    router.history.push("/p/loggd/usage");
    await router.load();
    expect(calls).toEqual([[{ page: "usage" }, "loggd"]]);
  });

  it("preloads the floor with no project", async () => {
    const { router, calls } = recording("/factory");
    await router.load();
    expect(calls).toEqual([[{ page: "factory" }, null]]);
  });

  it("does not preload a project's floor address, which only redirects", async () => {
    const { router, calls } = recording("/p/loggd/factory");
    expect(router.routesById["/p/$project/factory"].options.loader).toBeUndefined();
    // Loaded, so the redirect is followed: only the unscoped floor preloads.
    await router.load().catch(() => {});
    expect(calls.some(([screen, project]) => screen.page === "factory" && project !== null)).toBe(false);
  });

  it("leaves the page loading when the preload throws", async () => {
    const { router, calls } = recording("/p/loggd/usage", () => {
      throw new Error("boom");
    });
    await expect(router.load()).resolves.toBeUndefined();
    expect(calls).toEqual([[{ page: "usage" }, "loggd"]]);
    expect(router.state.matches.at(-1)?.status).toBe("success");
  });
});

describe("the path the screen shows", () => {
  it.each([
    ["/p/loggd", { project: "loggd", rest: "/" }],
    ["/p/loggd/", { project: "loggd", rest: "/" }],
    ["/p/loggd/notifications", { project: "loggd", rest: "/notifications" }],
    ["/p/a%25b/loops/a%20b", { project: "a%b", rest: "/loops/a%20b" }],
    ["/p/loggd/nope/deep", { project: "loggd", rest: "/nope/deep" }],
    // The router matches these to the usage route; the chrome must read the
    // same page from the match, so its title and sidebar agree with the body.
    ["/p/loggd/usage/", { project: "loggd", rest: "/usage" }],
    ["/p/loggd/Usage", { project: "loggd", rest: "/usage" }],
    ["/factory", { project: null, rest: "/factory" }],
  ])("reads %s from the committed match as the address bar would", async (url, expected) => {
    const router = createRouterFor(pages, createMemoryHistory({ initialEntries: [url] }));
    await router.load();
    expect(parseLocation(committedPath(router.state))).toEqual(expected);
  });

  it("falls back to the address bar before anything is committed", () => {
    expect(committedPath({ matches: [], location: { href: "/p/loggd/usage?x=1#y" } })).toBe("/p/loggd/usage");
  });
});

type AppRouter = ReturnType<typeof createRouterFor>;

/** Type-level only, never called: the router types a link's `to` against the tree. */
function link<const TOptions>(options: ValidateLinkOptions<AppRouter, TOptions>) {
  return options;
}

// Never called; compiling it is the check.
export function typedLinks() {
  link({ to: "/p/$project/loops/$name", params: { project: "loggd", name: "rafa" } });
  link({ to: "/p/$project/usage", params: { project: "loggd" } });
  link({ to: "/p/$project/settings", params: { project: "loggd" } });
  // @ts-expect-error a page the tree does not have
  link({ to: "/p/$project/nope", params: { project: "loggd" } });
}
