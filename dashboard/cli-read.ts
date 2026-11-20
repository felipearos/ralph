/**
 * The CLI read module: run a ralph CLI over the Executor port, parse what it
 * printed, narrow it, classify the failure, degrade by a named policy, and
 * cache the panel shape with a TTL and in-flight sharing on an injected clock.
 *
 * Every read the dashboard makes of a CLI used to re-decide these steps at its
 * own call site — which status counts as "unavailable", whether non-JSON is
 * drift, whether a failure blanks the panel or the whole snapshot. Declaring a
 * read as a `CliSurface` and running it here decides them once, and the
 * declarations are what a closed surface list will be built from (the
 * read-only test's rewrite is a later ticket of spec #601).
 *
 * It spawns nothing itself — the injected executor does — and reaches the
 * executor port through `./executor`, which imports no adapter.
 */
import { join } from "node:path";

import type { Env } from "./contracts";
import { guarded, type Executor, type Invocation } from "./executor";

/** A CLI that could not be run, or exited non-zero. Degradable per worktree. */
export class RalphUnavailableError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`${command} unavailable: ${detail}`);
    this.name = "RalphUnavailableError";
  }
}

/** The CLI ran, but its JSON was not the shape the adapter was written against. */
export class RalphContractError extends Error {
  constructor(
    readonly contract: string,
    readonly detail: string,
  ) {
    super(`${contract} contract drift: ${detail}`);
    this.name = "RalphContractError";
  }
}

/**
 * How a failed read degrades. `loud`: every failure throws. `unavailable`: a
 * CLI that could not run degrades, drift still throws (the adapter is wrong,
 * and saying nothing would hide it). `any`: every failure degrades.
 */
export type DegradePolicy = "loud" | "unavailable" | "any";

/**
 * A declared read: what a closed surface list will be built from. Exactly one
 * of `command` / `script`, which the type enforces.
 */
export type CliSurface<T> = CliSurfaceBase<T> &
  (
    | {
        /** An executable, e.g. "gh", "git". */
        command: string;
        script?: never;
      }
    | {
        /** A ralph script relative to cliDir, run as `bunPath <cliDir>/<script>`. */
        script: string;
        command?: never;
      }
  );

interface CliSurfaceBase<T> {
  contract: string;
  /** Declared argv; per-call args are APPENDED, never replace. */
  args: readonly string[];
  /** "json" (default): stdout is JSON.parse'd, non-JSON is drift. "text": narrow gets the raw stdout string. */
  parse?: "json" | "text";
  /** Narrows the parsed value; any throw from it is contract drift. */
  narrow: (value: unknown) => T;
  ttlMs?: number;
  degrade: DegradePolicy;
}

export interface CliCall {
  cwd: string;
  env: Env;
  /** Appended to the surface's declared argv. */
  args?: readonly string[];
  /** Written to stdin. */
  input?: string;
  /** Cache key; defaults to `cwd`. */
  key?: string;
}

/** The `{readAt, view, problem}` shape the frontier and Following panels already use. */
export interface CliRead<T> {
  readAt: string;
  view: T | null;
  problem: string | null;
}

export interface CliReaderConfig {
  exec: Executor;
  now: () => number;
  bunPath: string;
  cliDir: string;
  /** Passed on every Invocation as `timeoutMs`. */
  timeoutMs: number;
}

export interface CliReader {
  /**
   * Uncached. loud → T (every failure throws); unavailable → T | null
   * (unavailable → null, drift throws); any → T | null (every failure → null).
   */
  read<T>(surface: CliSurface<T> & { degrade: "loud" }, call: CliCall): Promise<T>;
  read<T>(surface: CliSurface<T>, call: CliCall): Promise<T | null>;
  /**
   * The panel shape. readAt is taken when the run STARTS. loud → failures
   * throw; unavailable → unavailable becomes {view:null, problem}, drift
   * throws; any → every failure becomes {view:null, problem}. With
   * `surface.ttlMs`, served from the shared TTL cache keyed by (surface
   * identity, call.key ?? cwd).
   */
  view<T>(surface: CliSurface<T>, call: CliCall): Promise<CliRead<T>>;
}

/**
 * The ONE TTL + in-flight cache. Overlapping get()s for a key share one load;
 * a RESOLVED value is kept for ttlMs, measured from when it settled; a
 * REJECTED load is not kept, so the next get re-runs it.
 */
export function createTtlCache<V>(options: { ttlMs: number; now: () => number }): {
  get(key: string, load: () => Promise<V>): Promise<V>;
} {
  const settled = new Map<string, { value: V; at: number }>();
  const inFlight = new Map<string, Promise<V>>();
  return {
    get(key, load) {
      const hit = settled.get(key);
      if (hit !== undefined && options.now() - hit.at < options.ttlMs) return Promise.resolve(hit.value);
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending;
      // Wrapped so a load that throws synchronously still rejects this promise
      // and clears its in-flight slot, rather than escaping get().
      const run = (async () => load())().then(
        (value) => {
          settled.set(key, { value, at: options.now() });
          inFlight.delete(key);
          return value;
        },
        (error: unknown) => {
          settled.delete(key);
          inFlight.delete(key);
          throw error;
        },
      );
      inFlight.set(key, run);
      return run;
    },
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether a failure degrades under a policy, or must reach the caller. */
const degrades = (policy: DegradePolicy, error: unknown): boolean =>
  policy === "any" || (policy === "unavailable" && error instanceof RalphUnavailableError);

/** The `problem` a degraded view carries: the detail for unavailable (what the frontier shows), the message otherwise. */
const problemOf = (error: unknown): string =>
  error instanceof RalphUnavailableError ? error.detail : messageOf(error);

export function createCliReader(config: CliReaderConfig): CliReader {
  const caches = new WeakMap<CliSurface<unknown>, ReturnType<typeof createTtlCache<CliRead<unknown>>>>();

  const invocationOf = (surface: CliSurface<unknown>, call: CliCall): Invocation => {
    const args = [...surface.args, ...(call.args ?? [])];
    const invocation: Invocation =
      surface.script !== undefined
        ? { command: config.bunPath, args: [join(config.cliDir, surface.script), ...args], cwd: call.cwd, env: call.env }
        : { command: surface.command, args, cwd: call.cwd, env: call.env };
    if (call.input !== undefined) invocation.input = call.input;
    invocation.timeoutMs = config.timeoutMs;
    return invocation;
  };

  // The executor made total: a rejection or a synchronous throw is a step
  // that never reached a status, so it classifies as unavailable.
  const run = guarded(config.exec);

  /** Runs the surface once; throws a classified error on any failure. */
  const strict = async <T>(surface: CliSurface<T>, call: CliCall): Promise<T> => {
    const invocation = invocationOf(surface as CliSurface<unknown>, call);
    const result = await run(invocation);
    if (result.status !== 0) {
      throw new RalphUnavailableError(
        `${invocation.command} ${invocation.args.join(" ")}`,
        result.stderr.trim() || `exited with status ${result.status}`,
      );
    }
    let value: unknown = result.stdout;
    if ((surface.parse ?? "json") === "json") {
      try {
        value = JSON.parse(result.stdout);
      } catch {
        throw new RalphContractError(surface.contract, "stdout was not JSON");
      }
    }
    try {
      return surface.narrow(value);
    } catch (error) {
      // A narrow's rejection is drift by definition, whatever it threw.
      if (error instanceof RalphContractError) throw error;
      throw new RalphContractError(surface.contract, messageOf(error));
    }
  };

  async function read<T>(surface: CliSurface<T>, call: CliCall): Promise<T | null> {
    try {
      return await strict(surface, call);
    } catch (error) {
      if (degrades(surface.degrade, error)) return null;
      throw error;
    }
  }

  const fresh = async <T>(surface: CliSurface<T>, call: CliCall): Promise<CliRead<T>> => {
    const readAt = new Date(config.now()).toISOString();
    try {
      return { readAt, view: await strict(surface, call), problem: null };
    } catch (error) {
      if (degrades(surface.degrade, error)) return { readAt, view: null, problem: problemOf(error) };
      throw error;
    }
  };

  const view = <T>(surface: CliSurface<T>, call: CliCall): Promise<CliRead<T>> => {
    if (surface.ttlMs === undefined) return fresh(surface, call);
    const identity = surface as CliSurface<unknown>;
    let cache = caches.get(identity);
    if (cache === undefined) {
      cache = createTtlCache<CliRead<unknown>>({ ttlMs: surface.ttlMs, now: config.now });
      caches.set(identity, cache);
    }
    return cache.get(call.key ?? call.cwd, () => fresh(surface, call)) as Promise<CliRead<T>>;
  };

  return { read: read as CliReader["read"], view };
}
