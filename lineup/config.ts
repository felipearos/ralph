/**
 * Where the lineup editor listens and which checkouts it edits.
 *
 * The tool is meant to be run from anywhere — its defaults are absolute paths
 * derived from the harness's own location, never the working directory — and a
 * root an operator points at must be absolute too, so a `cd` cannot silently
 * change which `models.json` is edited. Bad configuration is a loud error at
 * startup rather than an editor that quietly edits nothing.
 */
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PROJECT, type Env } from "./contracts";

/**
 * The harness checkout holding `models.ts`: this file's parent directory.
 *
 * Derived here rather than imported from the harness's `paths.ts`, so the HTTP
 * layer imports no `ralph/*.ts` module and lifts out of the repo unchanged.
 */
export const HARNESS_DIR = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8792;

export const LINEUP_ENV = {
  port: "RALPH_LINEUP_PORT",
  roots: "RALPH_LINEUP_ROOTS",
  bun: "RALPH_LINEUP_BUN",
  project: "RALPH_LINEUP_PROJECT",
} as const;

/** A project id, as the registry and `models.json` spell it. */
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]*$/;

export class LineupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineupConfigError";
  }
}

export interface LineupConfig {
  /**
   * Always `127.0.0.1`. Not configurable: the localhost-only property is the
   * point of the tool, and an override could only expose a write surface.
   */
  host: string;
  /** 0 asks the OS for an ephemeral port; the bound port is printed at startup. */
  port: number;
  /** Absolute repo/checkout roots, each holding the `models.json` it edits. */
  roots: string[];
  /** Absolute directory holding the ralph CLI scripts. */
  cliDir: string;
  bunPath?: string;
  /** The project whose keys a request that names none edits. */
  project: string;
}

export interface ConfigDefaults {
  /** The harness checkout (`RALPH_HOME`), which holds the CLI and its own lineup. */
  cliDir: string;
  /** The checkout whose lineup is edited when no root is configured. */
  root: string;
}

export function configFromEnv(env: Env, defaults: ConfigDefaults): LineupConfig {
  const cliDir = resolve(defaults.cliDir);
  const portRaw = env[LINEUP_ENV.port]?.trim();
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new LineupConfigError(
      `${LINEUP_ENV.port} must be an integer between 0 and 65535; got '${portRaw}'`,
    );
  }

  const rootsRaw = env[LINEUP_ENV.roots]?.trim();
  const roots =
    rootsRaw === undefined || rootsRaw === ""
      ? [resolve(defaults.root)]
      : rootsRaw
          .split(",")
          .map((root) => root.trim())
          .filter((root) => root !== "");
  if (roots.length === 0) {
    throw new LineupConfigError(`${LINEUP_ENV.roots} listed no roots`);
  }
  for (const root of roots) {
    if (!isAbsolute(root)) {
      throw new LineupConfigError(`${LINEUP_ENV.roots} must be absolute paths; got '${root}'`);
    }
  }

  const project = env[LINEUP_ENV.project]?.trim() || DEFAULT_PROJECT;
  if (!PROJECT_ID.test(project)) {
    throw new LineupConfigError(`${LINEUP_ENV.project} must be a project id; got '${project}'`);
  }

  const bunPath = env[LINEUP_ENV.bun]?.trim();
  return {
    host: DEFAULT_HOST,
    port,
    roots,
    cliDir,
    project,
    ...(bunPath === undefined || bunPath === "" ? {} : { bunPath }),
  };
}
