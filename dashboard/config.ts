/**
 * Where the dashboard listens and which checkouts it observes.
 *
 * The tool is meant to be run from anywhere — its defaults are absolute paths
 * derived from the file's own location, never the working directory — and a
 * root an operator points at must be absolute too, so a `cd` cannot silently
 * change which machine is being observed. Bad configuration is a loud error at
 * startup rather than a dashboard that quietly shows nothing.
 */
import { isAbsolute, resolve } from "node:path";

import type { Env } from "./contracts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8791;

export const DASHBOARD_ENV = {
  port: "RALPH_DASHBOARD_PORT",
  roots: "RALPH_DASHBOARD_ROOTS",
  bun: "RALPH_DASHBOARD_BUN",
  start: "RALPH_DASHBOARD_START",
  hosts: "RALPH_DASHBOARD_HOSTS",
} as const;

export class DashboardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardConfigError";
  }
}

export interface DashboardConfig {
  /**
   * Always `127.0.0.1`. Not configurable: the localhost-only property is the
   * point of the tool, and an override could only expose loop state.
   */
  host: string;
  /** 0 asks the OS for an ephemeral port; the bound port is printed at startup. */
  port: number;
  /**
   * Absolute repo/checkout roots: what a missing project registry is seeded
   * from, and — when `rootsOverride` — the only roots observed this run.
   */
  roots: string[];
  /** True when `RALPH_DASHBOARD_ROOTS` set the roots, overriding the registry for the run. */
  rootsOverride: boolean;
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  bunPath?: string;
  /** Absolute starter the start and restart routes run; defaults to `start.sh` in `cliDir`. */
  startScript?: string;
  /**
   * Extra `Host` names the server answers to, beside loopback and `*.ts.net`
   * (comma-separated in `RALPH_DASHBOARD_HOSTS`). A request for any other name
   * is refused: see `hostAllowed` in `routes.ts`. Stored lower-cased and
   * without a `:port`, which is the form that predicate compares.
   */
  hosts: string[];
}

export interface ConfigDefaults {
  /** The harness checkout (RALPH_HOME), which holds the CLI scripts. */
  cliDir: string;
  /** The project worktree the dashboard was started from; the default root. */
  root: string;
}

export function configFromEnv(env: Env, defaults: ConfigDefaults): DashboardConfig {
  const cliDir = resolve(defaults.cliDir);
  const portRaw = env[DASHBOARD_ENV.port]?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new DashboardConfigError(
      `${DASHBOARD_ENV.port} must be an integer between 0 and 65535; got '${portRaw}'`,
    );
  }

  const rootsRaw = env[DASHBOARD_ENV.roots]?.trim();
  const roots =
    rootsRaw === undefined || rootsRaw === ""
      ? [resolve(defaults.root)]
      : rootsRaw
          .split(",")
          .map((root) => root.trim())
          .filter((root) => root !== "");
  if (roots.length === 0) {
    throw new DashboardConfigError(`${DASHBOARD_ENV.roots} listed no roots`);
  }
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new DashboardConfigError(
        `${DASHBOARD_ENV.roots} must be absolute paths; got '${root}'`,
      );
    }
  }

  // Not validated beyond shape: an unknown name here only widens what the
  // server answers to, and a typo shows up as the dashboard still refusing it.
  // A `:port` suffix is dropped because `hostAllowed` compares port-less names,
  // and the refusal the operator is reading it from prints the raw header —
  // pasting `box.example:8791` back in has to work.
  const hostsRaw = env[DASHBOARD_ENV.hosts]?.trim();
  const hosts =
    hostsRaw === undefined || hostsRaw === ""
      ? []
      : hostsRaw
          .split(",")
          .map((host) => host.trim().toLowerCase().replace(/:\d+$/, ""))
          .filter((host) => host !== "");

  const bunPath = env[DASHBOARD_ENV.bun]?.trim();
  const startScript = env[DASHBOARD_ENV.start]?.trim();
  if (startScript !== undefined && startScript !== "" && !isAbsolute(startScript)) {
    throw new DashboardConfigError(`${DASHBOARD_ENV.start} must be an absolute path; got '${startScript}'`);
  }
  return {
    host: DEFAULT_HOST,
    port,
    roots,
    rootsOverride: rootsRaw !== undefined && rootsRaw !== "",
    cliDir,
    hosts,
    ...(bunPath === undefined || bunPath === "" ? {} : { bunPath }),
    ...(startScript === undefined || startScript === "" ? {} : { startScript }),
  };
}
