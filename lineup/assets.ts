/**
 * The page's static assets, read once at startup.
 *
 * Plain files under `static/`, served as they are: no bundler, no transpile, no
 * module graph beyond the one helper module the page imports. Kept apart from
 * `server.ts` so the handlers hold no filesystem call of their own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface StaticAsset {
  body: string;
  contentType: string;
}

/** Request path → asset. Only these paths are served; nothing else under `static/` is. */
export type StaticAssets = Record<string, StaticAsset>;

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./static/${name}`, import.meta.url)), "utf8");

export function readAssets(): StaticAssets {
  return {
    "/": { body: read("index.html"), contentType: "text/html; charset=utf-8" },
    "/lineup-view.js": { body: read("lineup-view.js"), contentType: "text/javascript; charset=utf-8" },
  };
}
