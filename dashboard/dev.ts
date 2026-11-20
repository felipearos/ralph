/**
 * The dashboard UI under Vite's dev server, with hot module replacement.
 *
 * `bun run dashboard:dev` serves `ui/` from source and forwards every `/api`
 * request to a dashboard that answers it: by default the design preview
 * (`preview.ts`), which this script starts as a child on a free port and
 * stops when it exits; with `--target <url>`, a server already running (the
 * real local one on 8791, say), and nothing is spawned.
 *
 * The proxy is deliberately transparent: the browser's own `Host`, `Origin`
 * and `Sec-Fetch-Site` reach the target unchanged, because the server's host
 * fence and same-site write check judge exactly those, and nothing is timed
 * out or buffered, because `/api/stream` and a loop's output are SSE streams
 * and a chat's events are long-polled.
 *
 * Vite is loaded here and nowhere `server.ts` imports, so the server stays
 * importable without it. The pieces a test needs are exported; listening and
 * spawning happen only when this file is run.
 */
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { createServer, type InlineConfig } from "vite";

import { configFromEnv, DASHBOARD_ENV } from "./config";
import type { Env } from "./contracts";
import { dashboardViteConfig } from "./vite-config";

export const DEV_ENV = {
  host: "RALPH_DASHBOARD_DEV_HOST",
  port: "RALPH_DASHBOARD_DEV_PORT",
} as const;

export const DEFAULT_DEV_HOST = "127.0.0.1";
// Not 8793: that is the remote preview's (`remote/preview.ts`).
export const DEFAULT_DEV_PORT = 8794;

const PREVIEW_ENTRY = fileURLToPath(new URL("./preview.ts", import.meta.url));

/** How long the preview child may take to answer: it builds the shell at start. */
const PREVIEW_READY_MS = 60_000;

export const USAGE = `usage: bun dashboard/dev.ts [--target <url>]

Serves the dashboard UI with Vite and hot module replacement, proxying /api to
the design preview (started here, on a free port) or to --target, e.g.
--target http://127.0.0.1:8791 for the local server already running.

env: ${DEV_ENV.host} (default ${DEFAULT_DEV_HOST}), ${DEV_ENV.port} (default ${DEFAULT_DEV_PORT};
     a busy port fails, 0 = any free port), RALPH_PREVIEW_HOST and RALPH_PREVIEW_PORT
     (the preview child's address; default 127.0.0.1 and a free port),
     ${DASHBOARD_ENV.hosts} (extra allowed Host names)`;

export interface DevArgs {
  help: boolean;
  /** Where `/api` goes; undefined means the preview child dev.ts starts. */
  target?: string;
}

export function parseDevArgs(argv: string[]): DevArgs {
  const args: DevArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--target") {
      const value = argv[++i];
      if (value === undefined || value === "") throw new Error("--target needs a URL");
      args.target = value;
    } else if (arg.startsWith("--target=")) {
      args.target = arg.slice("--target=".length);
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }
  if (args.target !== undefined) {
    const url = new URL(args.target);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`--target must be an http(s) URL; got '${args.target}'`);
    }
  }
  return args;
}

export interface DevOptions {
  /** The dashboard `/api` is proxied to. */
  target: string;
  host: string;
  port: number;
  /** Extra `Host` names, as `RALPH_DASHBOARD_HOSTS` lists them for the local server. */
  hosts: string[];
}

/** What the environment decides: everything but the target. */
export type DevListenOptions = Omit<DevOptions, "target">;

/**
 * Listen address and allowed hosts from the environment. The target is the
 * caller's, known only after the spawn decision; this runs before it, so a bad
 * value fails at once rather than after the preview's build.
 */
export function devOptionsFromEnv(env: Env): DevListenOptions {
  const host = env[DEV_ENV.host]?.trim() || DEFAULT_DEV_HOST;
  const portRaw = env[DEV_ENV.port]?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_DEV_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${DEV_ENV.port} must be an integer between 0 and 65535; got '${portRaw}'`);
  }
  // Only the hosts variable is passed on: the rest of the server's config
  // (roots, start script) means nothing here and must not fail a dev start.
  const { hosts } = configFromEnv(
    { [DASHBOARD_ENV.hosts]: env[DASHBOARD_ENV.hosts] },
    { cliDir: ".", root: "." },
  );
  return { host, port, hosts };
}

export function devViteConfig(options: DevOptions): InlineConfig {
  return {
    ...dashboardViteConfig(),
    mode: "development",
    // In dev the per-request and HMR lines are the point.
    logLevel: "info",
    // Nested paths (`/p/x/loops/y`) are client routes: they get index.html.
    appType: "spa",
    server: {
      host: options.host,
      port: options.port,
      // A busy port fails loudly rather than moving: a bookmarked or tailnet
      // mapped port that quietly changed would serve nothing. `0` still picks one.
      strictPort: true,
      // Vite's default reflects any localhost origin into
      // Access-Control-Allow-Origin, which would let another page on this
      // machine READ the proxied `/api` — the local server alone never allows
      // that. The dashboard page is same-origin and needs no CORS.
      cors: false,
      // The names the local server answers to beside loopback, which Vite
      // already allows: the tailnet's, and the operator's extra ones.
      allowedHosts: [".ts.net", ...options.hosts],
      proxy: {
        "/api": {
          target: options.target,
          // The target's host fence must judge the name the browser used.
          changeOrigin: false,
          // Vite's own HMR socket must stay Vite's.
          ws: false,
          // SSE streams and the chat long-poll stay open as long as they like.
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
  };
}

/** A port nothing listens on right now, from the OS. */
export async function freePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Resolves true once `url` answers at all, false if `exited` settles or time runs out first. */
async function waitForAnswer(url: string, exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (!gone && Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      // Not listening yet: poll again shortly.
    }
    await Promise.race([exited, Bun.sleep(100)]);
  }
  return false;
}

/** Copies a child's stream, holding it back until `forward` is set so an early failure can be shown whole. */
function drain(stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream, state: { forward: boolean; held: Uint8Array[] }) {
  void (async () => {
    try {
      for await (const chunk of stream) {
        if (state.forward) sink.write(chunk);
        else state.held.push(chunk);
      }
    } catch {
      // The child is gone; nothing left to copy.
    }
  })();
}

async function main(): Promise<void> {
  let args: DevArgs;
  try {
    args = parseDevArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  let listen: DevListenOptions;
  try {
    listen = devOptionsFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  let child: ReturnType<typeof Bun.spawn> | undefined;
  // Set on SIGINT/SIGTERM, so the preview dying of our own kill is not a failure.
  let stopping = false;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  // Registered before the preview starts: a stop while it builds must take it down too.
  const stop = () => {
    stopping = true;
    child?.kill();
    // Closing Vite can stall on open SSE sockets; the exit must not.
    setTimeout(() => process.exit(0), 1_000).unref();
    if (server === undefined) process.exit(0);
    void server.close().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let target = args.target;
  if (target === undefined) {
    const previewHost = process.env.RALPH_PREVIEW_HOST?.trim() || "127.0.0.1";
    const previewPort = process.env.RALPH_PREVIEW_PORT?.trim() || String(await freePort(previewHost));
    // An IPv6 literal needs its brackets in a URL.
    const urlHost = previewHost.includes(":") ? `[${previewHost}]` : previewHost;
    target = `http://${urlHost}:${previewPort}`;
    child = Bun.spawn([process.execPath, PREVIEW_ENTRY], {
      // Under Vite the preview's own rebuild is wasted work: HMR replaces it.
      env: { ...process.env, RALPH_PREVIEW_PORT: previewPort, RALPH_PREVIEW_WATCH: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = { forward: false, held: [] as Uint8Array[] };
    const err = { forward: false, held: [] as Uint8Array[] };
    drain(child.stdout as ReadableStream<Uint8Array>, process.stdout, out);
    drain(child.stderr as ReadableStream<Uint8Array>, process.stderr, err);
    // A preview left behind would hold its port and serve stale code.
    const spawned = child;
    process.on("exit", () => spawned.kill());

    const ready = await waitForAnswer(`${target}/api/loops`, child.exited, PREVIEW_READY_MS);
    for (const chunk of out.held) process.stdout.write(chunk);
    for (const chunk of err.held) process.stderr.write(chunk);
    out.forward = err.forward = true;
    if (!ready) {
      // A child killed by a signal has no exit code, only the signal.
      const ended = spawned.exitCode ?? spawned.signalCode;
      console.error(
        ended !== null
          ? `ralph-dashboard dev: the preview exited (${ended}) before answering`
          : `ralph-dashboard dev: the preview did not answer on ${target} within ${PREVIEW_READY_MS / 1000}s`,
      );
      spawned.kill();
      process.exit(1);
    }
    void spawned.exited.then((code) => {
      if (stopping) return;
      console.error(`ralph-dashboard dev: the preview exited (${code}); stopping`);
      process.exit(1);
    });
  }

  const options: DevOptions = { ...listen, target };

  server = await createServer(devViteConfig(options));
  await server.listen();
  const address = server.httpServer?.address();
  const port = address !== null && typeof address === "object" ? address.port : options.port;
  console.log(`ralph-dashboard dev listening on http://${options.host}:${port} (api → ${target})`);
}

if (import.meta.main) {
  await main();
}
