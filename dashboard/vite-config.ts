/**
 * The Vite config the dashboard shell is built with.
 *
 * It lives here, not in a `vite.config.ts`, so the root `vitest.config.ts`
 * stays the only config vitest picks up, and outside `ui/`, whose tsconfig
 * carries no node types. The build passes it inline (`configFile: false`), and
 * the dev server (`dev.ts`, `bun run dashboard:dev`) spreads it in too.
 *
 * The plugins are imported at the top, so `build.ts` imports this module
 * lazily: `server.ts` must stay importable without loading Vite.
 */
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { InlineConfig } from "vite";

/** The UI sources, Vite's root. */
export const UI_ROOT = fileURLToPath(new URL("./ui", import.meta.url));

export function dashboardViteConfig(): InlineConfig {
  return {
    root: UI_ROOT,
    // Links in the document are absolute: the shell is also served at nested
    // paths (`/p/x/loops/y`), where relative links would miss.
    base: "/",
    configFile: false,
    // The server builds at start; Vite's per-file report would flood its log.
    logLevel: "warn",
    plugins: [react(), tailwindcss()],
    resolve: {
      // Matches `paths` in ui/tsconfig.json.
      alias: { "@": UI_ROOT },
    },
  };
}

/**
 * The shell's production build: `buildShell` runs exactly this, and the Vercel
 * config test walks the same build for the files it bundles.
 */
export function shellBuildConfig(): InlineConfig {
  return {
    ...dashboardViteConfig(),
    mode: "production",
    build: {
      // In memory: the server serves from the returned map, and nothing
      // lands in the repo.
      write: false,
      // Every asset at the top level, so its request path is just its name.
      assetsDir: "",
      minify: true,
    },
  };
}
