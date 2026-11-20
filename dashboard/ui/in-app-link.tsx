/**
 * An in-app link the router follows in place, for a page whose hrefs are
 * strings its models build (the All projects floor): those cannot be typed
 * `<Link to>`s, so without this a click reloads the whole page. Like a router
 * link it preloads its page on hover and focus (#739), through the target
 * route's loader; `usePreloadHref` does the same for the shell's other plain
 * anchors.
 */
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import type { ComponentProps } from "react";

/**
 * Preloads the page an in-app href opens: the router runs the matching
 * route's loader, which reads the page's data through the Query layer, whose
 * keep-alive decides whether a read happens at all. A prefetch is a hint:
 * neither a throw nor a rejection may reach the page the pointer is on.
 */
export function usePreloadHref(): (href: string) => void {
  const router = useRouter();
  return useCallback(
    (href: string) => {
      try {
        // `href` is a built string (path and maybe a query), not a typed route,
        // so the typed options cannot name it; buildLocation parses an `href`.
        void router.preloadRoute({ href } as unknown as Parameters<typeof router.preloadRoute>[0]).catch(() => {});
      } catch {
        // A route that cannot be matched or built: the click still navigates.
      }
    },
    [router],
  );
}

/**
 * An anchor with `href` and every other anchor prop. A plain left click
 * navigates through the router and scrolls to the top, as the shell's `go`
 * does; a modified click (a new tab or window) is left to the browser. The
 * caller's `onClick` runs first, and can claim the click with `preventDefault`;
 * the caller's `onPointerEnter` and `onFocus` run before the preload.
 */
export function InAppLink({ href, onClick, onPointerEnter, onFocus, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  const preloadHref = usePreloadHref();
  return (
    <a
      {...props}
      href={href}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        preloadHref(href);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        preloadHref(href);
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        router.history.push(href);
        window.scrollTo(0, 0);
      }}
    />
  );
}
