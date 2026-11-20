/**
 * Jav's runtime adapter: reads and saves one project's block of the harness's
 * `jav.json` by running `jav.ts` for that project, never by importing it — the
 * same process boundary the lineup editor keeps with `models.ts`. The project
 * travels as `RALPH_PROJECT` (its root, whose config names its roster) and
 * `RALPH_PROJECT_ID` (the key its block is under).
 *
 * Two argv shapes and nothing else: `--json` to read, `--save` with the
 * candidate on stdin to validate-then-write. Validation is `jav.ts`'s; this
 * file only narrows what it prints. The read goes through the CLI read
 * (`cli-read.ts`) over an injected `Executor`. The save runs the same executor
 * directly: the CLI read is for reads, and the closed surface list built from
 * its declarations is a list of what the dashboard reads, so a write stays off it.
 */
import { join } from "node:path";

import { createCliReader, RalphContractError, RalphUnavailableError, type CliSurface } from "./cli-read";
import type { JavConfigView, JavSaveResult, JavView } from "./contracts";
import { createProcessExecutor, guarded, type Executor } from "./executor";

export const JAV_SURFACE = {
  read: { script: "jav.ts", args: ["--json"] },
  save: { script: "jav.ts", args: ["--save"] },
} as const;

export class JavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JavError";
  }
}

export interface JavAdapter {
  read(): Promise<JavView>;
  save(config: unknown): Promise<JavSaveResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * The file as written may be invalid — that is what the page is for fixing —
 * so the config is narrowed leniently: whatever cannot be shown is dropped,
 * and `problems` already says what was wrong with it.
 */
export function narrowJavConfig(value: unknown): JavConfigView {
  const raw = isRecord(value) ? value : {};
  const routes: Record<string, string[]> = {};
  if (isRecord(raw.routes)) {
    for (const [loop, labels] of Object.entries(raw.routes)) {
      if (isStrings(labels)) routes[loop] = labels;
    }
  }
  return {
    enabled: raw.enabled === true,
    labels: isStrings(raw.labels) ? raw.labels : [],
    routes,
  };
}

export function narrowJavView(value: unknown): JavView {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.exists !== "boolean" ||
    typeof value.project !== "string" ||
    typeof value.own !== "boolean" ||
    !isStrings(value.problems) ||
    !isStrings(value.loops) ||
    !isStrings(value.reserved)
  ) {
    throw new JavError(`jav.ts --json printed an unexpected shape: ${JSON.stringify(value)}`);
  }
  return {
    path: value.path,
    exists: value.exists,
    project: value.project,
    own: value.own,
    config: narrowJavConfig(value.config),
    problems: value.problems,
    loops: value.loops,
    reserved: value.reserved,
  };
}

export function narrowJavSave(value: unknown): JavSaveResult {
  if (!isRecord(value) || typeof value.valid !== "boolean" || !isStrings(value.problems)) {
    throw new JavError(`jav.ts --save printed an unexpected shape: ${JSON.stringify(value)}`);
  }
  return { valid: value.valid, problems: value.problems };
}

export function createJavAdapter(options: {
  cliDir: string;
  bunPath: string;
  /** The project whose block this adapter reads and writes. */
  project: { id: string; root: string };
  timeoutMs?: number;
  exec?: Executor;
}): JavAdapter {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const exec = options.exec ?? createProcessExecutor({ timeoutMs });
  const env = { ...process.env, RALPH_PROJECT: options.project.root, RALPH_PROJECT_ID: options.project.id };
  const reader = createCliReader({ exec, now: Date.now, bunPath: options.bunPath, cliDir: options.cliDir, timeoutMs });

  // Loud: the page is an editor, so a read it cannot trust must say why
  // rather than show an empty block the operator might save over. Parsed as
  // text so the "did not print JSON" message can still quote what it printed.
  const readSurface: CliSurface<JavView> & { degrade: "loud" } = {
    ...JAV_SURFACE.read,
    contract: "jav.ts --json",
    parse: "text",
    narrow: (value) => {
      const stdout = String(value);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new JavError(`jav.ts --json did not print JSON: ${stdout.trim()}`);
      }
      return narrowJavView(parsed);
    },
    degrade: "loud",
  };

  const read = async (): Promise<JavView> => {
    try {
      return await reader.read(readSurface, { cwd: options.cliDir, env });
    } catch (error) {
      // The route maps `instanceof JavError`; the reader's classified errors
      // are unwrapped back to the messages the page has always shown.
      if (error instanceof RalphUnavailableError) throw new JavError(`jav.ts --json failed: ${error.detail}`);
      if (error instanceof RalphContractError) throw new JavError(error.detail);
      throw error;
    }
  };

  const run = guarded(exec);
  const save = async (config: unknown): Promise<JavSaveResult> => {
    const result = await run({
      command: options.bunPath,
      args: [join(options.cliDir, JAV_SURFACE.save.script), ...JAV_SURFACE.save.args],
      cwd: options.cliDir,
      env,
      input: JSON.stringify(config),
      timeoutMs,
    });
    if (result.status !== 0) {
      throw new JavError(`jav.ts --save failed: ${result.stderr.trim() || `exited with status ${result.status}`}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new JavError(`jav.ts --save did not print JSON: ${result.stdout.trim()}`);
    }
    return narrowJavSave(parsed);
  };

  return { read, save };
}
