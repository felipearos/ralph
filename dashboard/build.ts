/**
 * Bundle the React shell once, in memory, at server start.
 *
 * The UI under `ui/` is React + Tailwind + shadcn components. There is no
 * checked-in build output: Vite builds `ui/index.html` and everything it
 * references without writing to disk (`vite-config.ts` holds the config), and
 * the server serves the artifacts straight from this map. The build is the
 * only place that knows the UI is bundled at all; the handlers see a shell
 * string and a set of assets keyed by request path.
 *
 * The remote dashboard serves the same bundle as static files from Vercel:
 * `writeShell` writes this build to disk, flagged as remote.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { Rolldown } from "vite";

export interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export interface Shell {
  /** The HTML document served at `/`. */
  html: string;
  /** Every other artifact, keyed by the absolute request path it is served at. */
  assets: Map<string, Asset>;
}

/** MIME types by extension for what the build emits; anything else is served as bytes. */
const TYPES: Record<string, string> = {
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json;charset=utf-8",
  ".map": "application/json;charset=utf-8",
  ".wasm": "application/wasm",
};

function bytes(source: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array(source);
}

/**
 * The build in flight, if any. Builds run one at a time: Vite reads and writes
 * `process.env.NODE_ENV` (below), and the preview's watcher can ask for a
 * second build before the first ends, which must not finish first and leave
 * the older bundle served.
 */
let building: Promise<unknown> = Promise.resolve();

export function buildShell(): Promise<Shell> {
  const next = building.then(buildOnce, buildOnce);
  building = next.catch(() => undefined);
  return next;
}

async function buildOnce(): Promise<Shell> {
  // Vite and its plugins are imported here rather than at the top so
  // `server.ts` stays importable by the vitest suites, which never build the
  // shell.
  const [{ build }, { shellBuildConfig }] = await Promise.all([import("vite"), import("./vite-config")]);
  // Vite sets `NODE_ENV` on the process when it is unset, and every loop the
  // dashboard later starts copies `process.env`: a leaked "production" would
  // put the loops' gates in React's production mode. It also compiles the
  // client against this value, so the shell is always built as production and
  // the caller's own value is put back afterwards.
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await build(shellBuildConfig());
  } catch (error) {
    throw new Error(`dashboard shell failed to build:\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  // `write: false` without `watch` yields the output itself, never a watcher.
  const outputs = (Array.isArray(result) ? result : [result as Rolldown.RolldownOutput]).flatMap((r) => r.output);

  let html: string | null = null;
  const assets = new Map<string, Asset>();
  for (const output of outputs) {
    const body = output.type === "chunk" ? output.code : output.source;
    if (output.fileName === "index.html") {
      html = typeof body === "string" ? body : new TextDecoder().decode(body);
      continue;
    }
    assets.set(`/${output.fileName}`, { body: bytes(body), type: TYPES[extname(output.fileName)] ?? "application/octet-stream" });
  }
  if (html === null) throw new Error("dashboard shell build produced no index.html");
  return { html, assets };
}

/**
 * Flags the document as the remote dashboard's. The UI reads it to tell the
 * Vercel-served shell from the local one.
 */
export const REMOTE_META = '<meta name="ralph-remote" content="1">';

/** The shell's document flagged with {@link REMOTE_META}, as the remote dashboard serves it. */
export function flagRemote(html: string): string {
  if (!html.includes("</head>")) throw new Error("dashboard shell has no </head> to flag as remote");
  return html.replace("</head>", `${REMOTE_META}</head>`);
}

/**
 * Flags the document as the open intake deployment's (`RALPH_REMOTE_SURFACE=intake`).
 * Vercel serves the static shell for every `/p/…` path before the function
 * is asked anything, so the UI reads this to answer "not found" for any page
 * but the intake page, instead of drawing a loop dashboard with no data.
 */
export const INTAKE_SURFACE_META = '<meta name="ralph-surface" content="intake">';

/**
 * Write the shell to `dir`: `index.html` and every asset at its request path,
 * ready to serve as static files. With `remote`, the document carries
 * {@link REMOTE_META}, and with `surface: "intake"` also
 * {@link INTAKE_SURFACE_META}; without either, the files are byte for byte
 * what {@link buildShell} serves.
 */
export async function writeShell(dir: string, { remote, surface = "full" }: { remote: boolean; surface?: "full" | "intake" }): Promise<void> {
  const { html, assets } = await buildShell();
  const flagged = remote ? flagRemote(html) : html;
  const document = surface === "intake" ? flagged.replace("</head>", `${INTAKE_SURFACE_META}</head>`) : flagged;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.html"), document);
  for (const [path, asset] of assets) {
    const file = join(dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, asset.body);
  }
}
