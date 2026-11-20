/**
 * The runtime adapter — the one seam that knows the lineup CLI.
 *
 * Everything the editor needs from the Ralph runtime crosses this module as a
 * typed view model. The command names, the flags, the environment and the JSON
 * shapes live here and nowhere else, so the tool can be lifted out of this
 * repository as a move rather than a rewrite, and so a change in the CLI output
 * lands as one explicit error instead of a silently wrong form.
 *
 * The JSON is a *contract*: it is narrowed field by field and a drifted or
 * malformed shape throws `LineupContractError`, naming the command and the
 * unexpected output. It is never coerced. A resolver that refused a config — a
 * missing or malformed `models.json`, an environment override that leaves a
 * stage on a model its runner cannot use — is a different fact: it throws
 * `LineupRefusedError` carrying the resolver's own message so the operator sees
 * the restore guidance unchanged.
 *
 * This module chooses every CLI invocation for the editor: read, preview and
 * save all run `models.ts` under the environment this module builds, and it
 * owns the JSON contract each command's output is narrowed against. The pure
 * edit/serialize layer and its atomic writer are reused from `../lineup-editor`
 * — that layer hands a candidate to `models.ts --validate` and writes bytes,
 * but takes no part in read/preview resolution or the environment.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createLoopBlock,
  mergeProjectView,
  projectView,
  removeLoopBlock,
  serializeConfig,
  setStage,
  writeConfigAtomically,
} from "../lineup-editor";
import {
  DEFAULT_PROJECT,
  LINEUP_SOURCES,
  MODEL_UPDATE_ANSWERS,
  MODEL_UPDATE_POLICIES,
  PROVIDER_PREFIXES,
  isRecord,
  type CatalogModelView,
  type Env,
  type HarnessCatalogView,
  type JsonObject,
  type LineupEdit,
  type LineupEditOp,
  type LineupPreview,
  type RunnerCatalogView,
  type LineupRead,
  type LineupSave,
  type LineupSource,
  type ModelUpdateAgentView,
  type ModelUpdateAnswer,
  type ModelUpdateChangeView,
  type ModelUpdateResult,
  type ModelUpdatesView,
  type ProviderPrefix,
  type ResolvedLineup,
  type ResolvedStage,
  type RuntimeSchema,
  type Shadow,
  type ValidationResult,
} from "./contracts";

/**
 * The entire command surface of the adapter.
 *
 * Exported so a regression test can assert it: every invocation of the runtime
 * goes through `models.ts` with one of these three flags, and there is no
 * fourth command to reach for. The path and stdin travel as arguments, so the
 * surface is the flag, not a fixed argv.
 */
export const COMMAND_SURFACE = {
  read: { contract: "models --json", script: "models.ts", flag: "--json" },
  schema: { contract: "models --schema", script: "models.ts", flag: "--schema" },
  validate: { contract: "models --validate", script: "models.ts", flag: "--validate" },
  /** The one-time move of pre-project loop blocks under `loggd`; a no-op once done. */
  migrate: { contract: "models --migrate", script: "models.ts", flag: "--migrate" },
  /** The one command that is not the resolver: it asks each harness what it can run. */
  catalog: { contract: "harness-catalog --json", script: "harness-catalog.ts", flag: "--json" },
  /** Which blocks run an older Claude model than their family's latest, and their policy (#851). */
  updates: { contract: "model-updates --json", script: "model-updates.ts", flag: "--json" },
  /**
   * The operator's answer for one block. The CLI writes `models.json` itself,
   * refusing any edit that adds a resolver problem; this adapter writes nothing.
   */
  answer: { contract: "model-updates --answer", script: "model-updates.ts", flag: "--answer" },
} as const;

/** How long a harness catalogue is reused before the harnesses are asked again. */
export const CATALOG_TTL_MS = 10 * 60 * 1000;

/** The environment variable the adapter sets to pick a loop, besides the config. */
export const LOOP_ENV = "RALPH_LOOP_NAME";
/** And the one that picks the loop's project. */
export const PROJECT_ENV = "RALPH_PROJECT_ID";

/** A CLI that could not be run, or timed out. */
export class LineupUnavailableError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
  ) {
    super(`${command} unavailable: ${detail}`);
    this.name = "LineupUnavailableError";
  }
}

/** The CLI ran, but its JSON was not the shape the adapter was written against. */
export class LineupContractError extends Error {
  constructor(
    readonly contract: string,
    readonly detail: string,
  ) {
    super(`${contract} contract drift: ${detail}`);
    this.name = "LineupContractError";
  }
}

/** The resolver refused the config; `message` is its own guidance, verbatim. */
export class LineupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineupRefusedError";
  }
}

/** The request itself cannot be served: an unknown root, a malformed body. */
export class LineupRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineupRequestError";
  }
}

export interface LineupAdapterConfig {
  /** Absolute directory holding the ralph CLI (`models.ts`). */
  cliDir: string;
  /** Absolute repo/checkout roots, each holding the `models.json` it edits. */
  roots: readonly string[];
  /** Bun executable. Defaults to the running Bun, or `bun` on PATH under a test runner. */
  bunPath?: string;
  /** Extra environment for the child processes (merged over `process.env`). */
  env?: Env;
  /** Per-invocation timeout. */
  timeoutMs?: number;
  /** The project a request that names none edits; defaults to `DEFAULT_PROJECT`. */
  project?: string;
}

/** Which checkout, project and loop a request is about. Each is optional. */
export interface LineupSelectors {
  root?: string;
  project?: string;
  loop?: string;
  /**
   * The loop's role, when the CALLER knows it and the resolver would not.
   *
   * The dashboard does: it reads the project's roster, which this adapter
   * cannot reach from a harness checkout. Supplying it is what makes a
   * triager's form offer the triager's three stages rather than a coder's
   * five. Omitted, the resolver works the role out as before.
   */
  role?: string;
}

export interface LineupAdapter {
  /** The configured roots, in configuration order, for discovery. */
  readonly roots: readonly string[];
  /** The project's view of the file, its resolved lineup, the rules and the env shadows. */
  read(options?: LineupSelectors): Promise<LineupRead>;
  /**
   * Re-resolve and validate a candidate without writing it. A candidate is a
   * project's view (see `projectView`), judged as the whole file it would
   * make once merged back under that project.
   */
  preview(input: LineupSelectors & { config: JsonObject }): Promise<LineupPreview>;
  /**
   * Apply one edit to a copy of the candidate through the pure edit layer and
   * re-resolve it for `loop`. Nothing is written; the caller keeps the edited
   * candidate and saves it deliberately.
   */
  edit(input: LineupSelectors & { config: JsonObject; edit: LineupEditOp }): Promise<LineupEdit>;
  /**
   * Merge a project's view back into the file under that project's key alone,
   * validate the result and write it atomically only when the CLI accepts it.
   */
  save(input: LineupSelectors & { config: JsonObject }): Promise<LineupSave>;
  /** What each harness can run. Cached for `CATALOG_TTL_MS`; `refresh` asks again now. */
  catalog(options?: { refresh?: boolean }): Promise<HarnessCatalogView>;
  /** The project's blocks (and the file's `default`) with their outdated stages and policies. */
  updates(options?: { root?: string; project?: string }): Promise<ModelUpdatesView>;
  /**
   * Record the operator's answer for one block: the project's `block`, or the
   * file's own `default` when `fileDefault` is set.
   */
  answerUpdate(input: {
    root?: string;
    project?: string;
    block?: string;
    fileDefault?: boolean;
    answer: ModelUpdateAnswer;
  }): Promise<ModelUpdateResult>;
}

const defaultBunPath = (): string =>
  (process.versions as Record<string, string | undefined>).bun ? process.execPath : "bun";

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

function fail(contract: string, path: string, message: string): never {
  throw new LineupContractError(contract, `${path} ${message}`);
}

function asRecord(contract: string, path: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail(contract, path, `expected an object, got ${describe(value)}`);
  return value;
}

function string(contract: string, path: string, value: unknown): string {
  if (typeof value !== "string") fail(contract, path, `expected a string, got ${describe(value)}`);
  return value;
}

function optionalString(contract: string, path: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return string(contract, path, value);
}

function stringArray(contract: string, path: string, value: unknown): string[] {
  if (!Array.isArray(value)) fail(contract, path, `expected an array, got ${describe(value)}`);
  return value.map((item, index) => string(contract, `${path}[${index}]`, item));
}

function oneOf<T extends string>(
  contract: string,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T {
  const text = string(contract, path, value);
  if (!(allowed as readonly string[]).includes(text)) {
    fail(contract, path, `expected one of ${allowed.join(", ")}, got '${text}'`);
  }
  return text as T;
}

function booleanValue(contract: string, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") fail(contract, path, `expected a boolean, got ${describe(value)}`);
  return value;
}

function nullableString(contract: string, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return string(contract, path, value);
}

function catalogModel(contract: string, path: string, value: unknown): CatalogModelView {
  const raw = asRecord(contract, path, value);
  const label = optionalString(contract, `${path}.label`, raw.label);
  const upgradeTo = optionalString(contract, `${path}.upgradeTo`, raw.upgradeTo);
  const efforts = raw.efforts === undefined ? undefined : stringArray(contract, `${path}.efforts`, raw.efforts);
  const contextWindow = raw.contextWindow;
  if (contextWindow !== undefined && (typeof contextWindow !== "number" || !Number.isFinite(contextWindow))) {
    fail(contract, `${path}.contextWindow`, `expected a number, got ${describe(contextWindow)}`);
  }
  return {
    id: string(contract, `${path}.id`, raw.id),
    ...(label === undefined ? {} : { label }),
    ...(upgradeTo === undefined ? {} : { upgradeTo }),
    ...(efforts === undefined ? {} : { efforts }),
    ...(contextWindow === undefined ? {} : { contextWindow: contextWindow as number }),
  };
}

function runnerCatalog(contract: string, path: string, value: unknown): RunnerCatalogView {
  const raw = asRecord(contract, path, value);
  const models = raw.models;
  if (!Array.isArray(models)) fail(contract, `${path}.models`, `expected an array, got ${describe(models)}`);
  return {
    available: booleanValue(contract, `${path}.available`, raw.available),
    reason: nullableString(contract, `${path}.reason`, raw.reason),
    source: string(contract, `${path}.source`, raw.source),
    version: nullableString(contract, `${path}.version`, raw.version),
    models: models.map((model, index) => catalogModel(contract, `${path}.models[${index}]`, model)),
    efforts: stringArray(contract, `${path}.efforts`, raw.efforts),
    aliases: raw.aliases === undefined ? {} : aliasMap(contract, `${path}.aliases`, raw.aliases),
  };
}

function aliasMap(contract: string, path: string, value: unknown): Record<string, string> {
  const raw = asRecord(contract, path, value);
  const map: Record<string, string> = {};
  for (const alias of Object.keys(raw)) map[alias] = string(contract, `${path}.${alias}`, raw[alias]);
  return map;
}

function nullableProject(contract: string, path: string, value: unknown): string | null {
  return value === null ? null : string(contract, path, value);
}

function updateAgent(contract: string, path: string, value: unknown): ModelUpdateAgentView {
  const raw = asRecord(contract, path, value);
  const outdated = raw.outdated;
  if (!Array.isArray(outdated)) fail(contract, `${path}.outdated`, `expected an array, got ${describe(outdated)}`);
  return {
    project: nullableProject(contract, `${path}.project`, raw.project),
    block: string(contract, `${path}.block`, raw.block),
    policy: oneOf(contract, `${path}.policy`, raw.policy, MODEL_UPDATE_POLICIES),
    skip: stringArray(contract, `${path}.skip`, raw.skip),
    snoozedUntil: nullableString(contract, `${path}.snoozedUntil`, raw.snoozedUntil),
    malformed: booleanValue(contract, `${path}.malformed`, raw.malformed),
    outdated: outdated.map((entry, index) => {
      const stage = asRecord(contract, `${path}.outdated[${index}]`, entry);
      return {
        stage: string(contract, `${path}.outdated[${index}].stage`, stage.stage),
        model: string(contract, `${path}.outdated[${index}].model`, stage.model),
        latest: string(contract, `${path}.outdated[${index}].latest`, stage.latest),
      };
    }),
    ask: booleanValue(contract, `${path}.ask`, raw.ask),
  };
}

/** Narrow `model-updates.ts --json`. */
export function narrowUpdates(
  value: unknown,
  where: { root: string; project: string },
  contract = COMMAND_SURFACE.updates.contract,
): ModelUpdatesView {
  const raw = asRecord(contract, "$", value);
  const agents = raw.agents;
  if (!Array.isArray(agents)) fail(contract, "$.agents", `expected an array, got ${describe(agents)}`);
  return {
    ...where,
    latest: aliasMap(contract, "$.latest", raw.latest),
    latestSource: string(contract, "$.latestSource", raw.latestSource),
    agents: agents.map((agent, index) => updateAgent(contract, `$.agents[${index}]`, agent)),
  };
}

/** Narrow `model-updates.ts --answer`. */
export function narrowAnswer(value: unknown, root: string, contract = COMMAND_SURFACE.answer.contract): ModelUpdateResult {
  const raw = asRecord(contract, "$", value);
  const changes = raw.changes;
  if (!Array.isArray(changes)) fail(contract, "$.changes", `expected an array, got ${describe(changes)}`);
  return {
    root,
    project: nullableProject(contract, "$.project", raw.project),
    block: string(contract, "$.block", raw.block),
    answer: oneOf(contract, "$.answer", raw.answer, MODEL_UPDATE_ANSWERS),
    changes: changes.map((entry, index): ModelUpdateChangeView => {
      const change = asRecord(contract, `$.changes[${index}]`, entry);
      return {
        project: nullableProject(contract, `$.changes[${index}].project`, change.project),
        block: string(contract, `$.changes[${index}].block`, change.block),
        stage: string(contract, `$.changes[${index}].stage`, change.stage),
        from: string(contract, `$.changes[${index}].from`, change.from),
        to: string(contract, `$.changes[${index}].to`, change.to),
      };
    }),
    agent: raw.agent === null || raw.agent === undefined ? null : updateAgent(contract, "$.agent", raw.agent),
  };
}

/** Narrow `harness-catalog.ts --json` — every runner's catalogue. */
export function narrowCatalog(value: unknown, contract = COMMAND_SURFACE.catalog.contract): HarnessCatalogView {
  const raw = asRecord(contract, "$", value);
  const runners = asRecord(contract, "$.runners", raw.runners);
  return {
    fetchedAt: string(contract, "$.fetchedAt", raw.fetchedAt),
    runners: Object.fromEntries(
      Object.entries(runners).map(([name, entry]) => [name, runnerCatalog(contract, `$.runners.${name}`, entry)]),
    ),
  };
}

/** Narrow `models.ts --json` — the resolved lineup. */
export function narrowResolved(value: unknown, contract = COMMAND_SURFACE.read.contract): ResolvedLineup {
  const raw = asRecord(contract, "$", value);
  const project = optionalString(contract, "$.project", raw.project);
  const role = optionalString(contract, "$.role", raw.role);
  const loop = string(contract, "$.loop", raw.loop);
  const stagesRaw = asRecord(contract, "$.stages", raw.stages);
  const stages: Record<string, ResolvedStage> = {};
  const names = Object.keys(stagesRaw);
  if (names.length === 0) fail(contract, "$.stages", "expected at least one stage");
  for (const stage of names) {
    const node = asRecord(contract, `$.stages.${stage}`, stagesRaw[stage]);
    const effort = optionalString(contract, `$.stages.${stage}.effort`, node.effort);
    const fallback = node.fallback === undefined
      ? undefined
      : typeof node.fallback === "string"
        ? [node.fallback]
        : stringArray(contract, `$.stages.${stage}.fallback`, node.fallback);
    const fallbackEfforts = node.fallbackEfforts === undefined ? undefined : Object.fromEntries(
      Object.entries(asRecord(contract, `$.stages.${stage}.fallbackEfforts`, node.fallbackEfforts))
        .map(([id, value]) => [id, string(contract, `$.stages.${stage}.fallbackEfforts.${id}`, value)]),
    );
    stages[stage] = {
      model: string(contract, `$.stages.${stage}.model`, node.model),
      runner: string(contract, `$.stages.${stage}.runner`, node.runner),
      ...(effort === undefined ? {} : { effort }),
      ...(fallback === undefined ? {} : { fallback }),
      ...(fallbackEfforts === undefined ? {} : { fallbackEfforts }),
      source: oneOf<LineupSource>(
        contract,
        `$.stages.${stage}.source`,
        node.source,
        LINEUP_SOURCES,
      ),
    };
  }
  return { ...(project === undefined ? {} : { project }), ...(role === undefined ? {} : { role }), loop, stages };
}

/** Narrow `models.ts --schema` — the resolver's rules. */
export function narrowSchema(value: unknown, contract = COMMAND_SURFACE.schema.contract): RuntimeSchema {
  const raw = asRecord(contract, "$", value);
  const stages = stringArray(contract, "$.stages", raw.stages);
  const runners = stringArray(contract, "$.runners", raw.runners);
  const runnersForRaw = asRecord(contract, "$.runnersFor", raw.runnersFor);
  const runnersFor: Record<string, string[]> = {};
  for (const stage of Object.keys(runnersForRaw)) {
    runnersFor[stage] = stringArray(contract, `$.runnersFor.${stage}`, runnersForRaw[stage]);
  }
  const effortRunnersFor: Record<string, string[]> = {};
  if (raw.effortRunnersFor !== undefined) {
    const effortRaw = asRecord(contract, "$.effortRunnersFor", raw.effortRunnersFor);
    for (const stage of Object.keys(effortRaw)) {
      effortRunnersFor[stage] = stringArray(contract, `$.effortRunnersFor.${stage}`, effortRaw[stage]);
    }
  }
  const agentToolStages = stringArray(contract, "$.agentToolStages", raw.agentToolStages);
  const agentNames: Record<string, string> = {};
  if (raw.agentNames !== undefined) {
    const namesRaw = asRecord(contract, "$.agentNames", raw.agentNames);
    for (const stage of Object.keys(namesRaw)) {
      agentNames[stage] = string(contract, `$.agentNames.${stage}`, namesRaw[stage]);
    }
  }
  const aliases = stringArray(contract, "$.aliases", raw.aliases);
  // Older resolvers do not print the targets; an absent map is empty, not drift.
  const aliasTargets: Record<string, string> = {};
  if (raw.aliasTargets !== undefined) {
    const targetsRaw = asRecord(contract, "$.aliasTargets", raw.aliasTargets);
    for (const alias of Object.keys(targetsRaw)) {
      aliasTargets[alias] = string(contract, `$.aliasTargets.${alias}`, targetsRaw[alias]);
    }
  }
  const defaultFallback = string(contract, "$.defaultFallback", raw.defaultFallback);
  const defaultFallbacks = raw.defaultFallbacks === undefined
    ? [defaultFallback]
    : stringArray(contract, "$.defaultFallbacks", raw.defaultFallbacks);
  const modelIdRaw = asRecord(contract, "$.modelId", raw.modelId);
  const pattern = string(contract, "$.modelId.pattern", modelIdRaw.pattern);
  const prefixRaw = asRecord(contract, "$.modelId.providerPrefix", modelIdRaw.providerPrefix);
  const providerPrefix: Record<string, ProviderPrefix> = {};
  for (const runner of Object.keys(prefixRaw)) {
    providerPrefix[runner] = oneOf<ProviderPrefix>(
      contract,
      `$.modelId.providerPrefix.${runner}`,
      prefixRaw[runner],
      PROVIDER_PREFIXES,
    );
  }
  return {
    stages,
    runners,
    runnersFor,
    ...(raw.effortRunnersFor === undefined ? {} : { effortRunnersFor }),
    agentToolStages,
    ...(raw.agentNames === undefined ? {} : { agentNames }),
    ...(raw.claudeIdPrefix === undefined ? {} : { claudeIdPrefix: string(contract, "$.claudeIdPrefix", raw.claudeIdPrefix) }),
    aliases,
    aliasTargets,
    defaultFallback,
    defaultFallbacks,
    modelId: { pattern, providerPrefix },
  };
}

/** Narrow `models.ts --validate` — the complete collected problem list. */
export function narrowValidation(
  value: unknown,
  contract = COMMAND_SURFACE.validate.contract,
): ValidationResult {
  const raw = asRecord(contract, "$", value);
  if (typeof raw.valid !== "boolean") {
    fail(contract, "$.valid", `expected a boolean, got ${describe(raw.valid)}`);
  }
  return { valid: raw.valid, problems: stringArray(contract, "$.problems", raw.problems) };
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one child, capturing both streams and feeding `input` to stdin. */
function exec(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Env; timeout: number; input?: string },
): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Next.js augments `NodeJS.ProcessEnv` to require `NODE_ENV`; our plain
      // env map is the child's actual environment, so the cast is at the
      // process boundary, not in the tool's own types.
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        rejectPromise(
          new LineupUnavailableError(
            `${command} ${args.join(" ")}`,
            `timed out after ${options.timeout}ms`,
          ),
        ),
      );
    }, options.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(() =>
        rejectPromise(new LineupUnavailableError(`${command} ${args.join(" ")}`, error.message)),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(() => resolvePromise({ code, stdout, stderr }));
    });
    // A command that exits without reading stdin (or a broken pipe) is not an
    // adapter failure: the exit code and stdout are the answer.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** The resolver prefixes its refusal with `models: `; the operator wants the rest. */
const resolverMessage = (stderr: string): string => stderr.trim().replace(/^models:\s*/, "");

const parse = (contract: string, command: string, result: ExecResult): unknown => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new LineupContractError(
      contract,
      `${command} did not print JSON (exit ${result.code}): ` +
        `${JSON.stringify(result.stdout)}${result.stderr === "" ? "" : `\n  stderr: ${result.stderr.trim()}`}`,
    );
  }
};

const envTail = (stage: string): string => stage.replace(/\./g, "_").toUpperCase();

/**
 * Read the environment for overrides that would win over the file.
 *
 * The resolver tags a stage `env` when its model or runner comes from an
 * override — but the tag alone does not say *which* variable, and it never
 * moves for an effort override at all. So the shadow is derived from the same
 * environment the CLI was handed: model and runner are reported from the
 * resolved stage's `source`, and the effort override is reported whenever it is
 * set, because a save that silently does nothing is exactly what the operator
 * must be told about. `RALPH_CODER_MODEL` is the executor's legacy model knob,
 * named only when the current `RALPH_MODEL_EXECUTOR` is not the one in effect.
 */
export function computeShadows(env: Env, resolved: ResolvedLineup): Shadow[] {
  const shadows: Shadow[] = [];
  for (const [stage, value] of Object.entries(resolved.stages)) {
    if (value.source !== "env") continue;
    const tail = envTail(stage);
    const modelVar = `RALPH_MODEL_${tail}`;
    if ((env[modelVar] ?? "").trim() !== "") {
      shadows.push({ stage, field: "model", variable: modelVar });
    } else if (stage === "executor" && (env.RALPH_CODER_MODEL ?? "").trim() !== "") {
      shadows.push({ stage, field: "model", variable: "RALPH_CODER_MODEL" });
    }
    const runnerVar = `RALPH_RUNNER_${tail}`;
    if ((env[runnerVar] ?? "").trim() !== "") {
      shadows.push({ stage, field: "runner", variable: runnerVar });
    }
  }
  // Effort overrides leave source alone, including an explicit empty value.
  for (const stage of Object.keys(resolved.stages)) {
    const variable = `RALPH_MODEL_${stage.replace(/\./g, "_").toUpperCase()}_EFFORT`;
    if (env[variable] !== undefined) shadows.push({ stage, field: "effort", variable });
  }
  return shadows;
}

/**
 * Build an adapter over the configured runtime.
 *
 * The adapter holds no root-relative state between calls: every request resolves
 * the selector against the configured roots and reads a fresh file, so a
 * standing page never serves a stale lineup.
 */
export function createLineupAdapter(config: LineupAdapterConfig): LineupAdapter {
  const cliDir = resolve(config.cliDir);
  const roots = config.roots.map((root) => resolve(root));
  if (roots.length === 0) {
    throw new LineupRequestError("the lineup adapter needs at least one configured root");
  }
  const bunPath = config.bunPath ?? defaultBunPath();
  const timeout = config.timeoutMs ?? 30_000;
  const baseEnv: Env = { ...process.env, ...config.env };
  const cli = join(cliDir, COMMAND_SURFACE.read.script);

  const resolveRoot = (selector?: string): string => {
    if (selector === undefined || selector.trim() === "") return roots[0]!;
    // An exact configured path wins over the index reading, so a path that
    // happens to look like a number is never mistaken for a position.
    const wanted = resolve(selector);
    const byPath = roots.find((root) => root === wanted);
    if (byPath !== undefined) return byPath;
    if (/^\d+$/.test(selector)) {
      const index = Number(selector);
      if (index >= 0 && index < roots.length) return roots[index]!;
    }
    throw new LineupRequestError(
      `unknown root '${selector}'; configured roots: ${roots.join(", ")}`,
    );
  };

  const resolveLoop = (selector?: string): string => {
    const value = selector?.trim();
    if (value !== undefined && value !== "") return value;
    const fromEnv = baseEnv[LOOP_ENV]?.trim();
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : "ralph";
  };

  const defaultProject = config.project ?? DEFAULT_PROJECT;
  const resolveProject = (selector?: string): string => {
    const value = selector?.trim();
    if (value === undefined || value === "") return defaultProject;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw new LineupRequestError(`'${value}' is not a project id`);
    return value;
  };

  const modelsPath = (root: string): string => join(root, "models.json");

  const withLoop = (project: string, loop: string): Env => ({ ...baseEnv, [PROJECT_ENV]: project, [LOOP_ENV]: loop });

  /**
   * `role` is the caller's, when it knows one the resolver cannot.
   *
   * The dashboard does: it reads the project's roster, which this adapter
   * cannot (see `roleOf`). Passing it makes the resolver answer AS that role,
   * so a triager's stages and its resolved lineup are its own rather than a
   * coder's. Absent, the resolver works it out as before.
   */
  const readResolved = async (path: string, project: string, loop: string, role?: string): Promise<ResolvedLineup> => {
    const contract = COMMAND_SURFACE.read.contract;
    const args = role === undefined ? [cli, COMMAND_SURFACE.read.flag, path] : [cli, COMMAND_SURFACE.read.flag, path, "--role", role];
    const command = `${bunPath} ${args.join(" ")}`;
    const result = await exec(bunPath, args, {
      cwd: cliDir,
      env: withLoop(project, loop),
      timeout,
    });
    if (result.code !== 0) {
      throw new LineupRefusedError(
        resolverMessage(result.stderr) || `${command} exited ${result.code}`,
      );
    }
    return narrowResolved(parse(contract, command, result), contract);
  };

  const readSchema = async (role?: string): Promise<RuntimeSchema> => {
    const contract = COMMAND_SURFACE.schema.contract;
    // The role's own rules when the resolver named one: `stages` is then the set
    // a form may offer and a new block must be complete over, so a triager is
    // not shown an executor to choose a model for.
    const args = role === undefined ? [cli, COMMAND_SURFACE.schema.flag] : [cli, COMMAND_SURFACE.schema.flag, "--role", role];
    const command = `${bunPath} ${args.join(" ")}`;
    const result = await exec(bunPath, args, {
      cwd: cliDir,
      env: baseEnv,
      timeout,
    });
    if (result.code !== 0) {
      // A role the runtime does not know is a bad REQUEST, not a runtime that
      // cannot be reached: the caller chose the value, and reporting the CLI
      // as unavailable would send an operator looking for the wrong fault.
      const message = resolverMessage(result.stderr);
      if (/--role/.test(message)) throw new LineupRequestError(message);
      throw new LineupUnavailableError(
        command,
        result.stderr.trim() || `exited ${result.code}`,
      );
    }
    return narrowSchema(parse(contract, command, result), contract);
  };

  // The schema is a pure function of the CLI, the configured clips and the ROLE,
  // so it is fetched once per role per adapter rather than on every read.
  const schemaPromises = new Map<string, Promise<RuntimeSchema>>();
  const schema = (role?: string): Promise<RuntimeSchema> => {
    const key = role ?? "";
    const cached = schemaPromises.get(key);
    if (cached !== undefined) return cached;
    // A rejection is not memoised: a refused role would otherwise leave its
    // key in the map for the process's life, so one bad request would keep
    // answering for every later one — and the map would grow per bad value.
    const pending = readSchema(role).catch((error: unknown) => {
      schemaPromises.delete(key);
      throw error;
    });
    schemaPromises.set(key, pending);
    return pending;
  };

  /**
   * The role the resolver reports for a loop, or undefined when it does not.
   *
   * The CALLER's role wins when it supplies one, because the dashboard can
   * read the project's roster and this adapter cannot: the roots it edits are
   * HARNESS checkouts, so the project's `.ralph/config.json` — where a loop's
   * role is declared — is not reachable from here. Without a caller's role it
   * asks the resolver, and a loop whose role the resolver cannot name either is
   * edited as a coder, which is how every loop was edited before roles existed.
   */
  const roleOf = async (text: string, project: string, loop: string, role?: string): Promise<string | undefined> => {
    if (role !== undefined) return role;
    try {
      return (await resolveCandidateText(text, project, loop)).role;
    } catch {
      // A candidate the resolver refuses has no role to report; the caller is
      // about to surface that refusal itself.
      return undefined;
    }
  };

  /**
   * The candidate resolved as `role`, or — when the role refuses it — resolved
   * without one.
   *
   * Only `read` wants this. A block that names a stage its role does not run is
   * a real refusal and the operator has to see it, but `read` is how the form
   * OPENS: refusing there leaves no draft, no stages and nothing to edit, so a
   * triager configured before roles existed could never be corrected from the
   * page. Preview and save still refuse it, naming the offending stages.
   *
   * The fallback deliberately shows the block AS IT IS — five stages for a
   * legacy triager — rather than the role's three: the two stages a triager
   * must not have are exactly the ones the operator has to see to delete, and a
   * three-stage form would hide them.
   */
  const resolveWithRoleFallback = async (
    text: string,
    project: string,
    loop: string,
    role?: string,
  ): Promise<ResolvedLineup> => {
    if (role === undefined) return resolveCandidateText(text, project, loop);
    try {
      return await resolveCandidateText(text, project, loop, role);
    } catch (error) {
      if (!(error instanceof LineupRefusedError)) throw error;
      // A role the runtime does not know is the CALLER's mistake, not a block
      // the role refuses, so it must not be absorbed into a role-less read —
      // the form would open as a coder's and the bad selector go unreported.
      if (/--role/.test(error.message)) throw new LineupRequestError(error.message);
      try {
        return await resolveCandidateText(text, project, loop);
      } catch (withoutRole) {
        // A block that neither role accepts: report the ROLE's refusal, not the
        // coder's. The coder's names the five-stage rule, so it would tell the
        // operator to add the very stages a triager may not have — which is the
        // defect this fallback exists to avoid, arriving by the other door.
        throw withoutRole instanceof LineupRefusedError ? error : withoutRole;
      }
    }
  };

  const readCatalog = async (): Promise<HarnessCatalogView> => {
    const contract = COMMAND_SURFACE.catalog.contract;
    const script = join(cliDir, COMMAND_SURFACE.catalog.script);
    const command = `${bunPath} ${script} ${COMMAND_SURFACE.catalog.flag}`;
    // Asking three harnesses can take a while (opencode lists over the network).
    const result = await exec(bunPath, [script, COMMAND_SURFACE.catalog.flag], {
      cwd: cliDir,
      env: baseEnv,
      timeout: Math.max(timeout, 90_000),
    });
    if (result.code !== 0) {
      throw new LineupUnavailableError(command, result.stderr.trim() || `exited ${result.code}`);
    }
    return narrowCatalog(parse(contract, command, result), contract);
  };

  // A harness's catalogue changes rarely and costs seconds to ask for, so one
  // answer serves the form for a while. Past the TTL the stale answer is still
  // served while a fresh ask runs behind it, so a form never waits on the
  // harnesses twice; a failed ask is not cached.
  interface CatalogEntry {
    at: number;
    value: Promise<HarnessCatalogView>;
    settled: boolean;
  }
  let catalogCache: CatalogEntry | null = null;
  const ask = (): CatalogEntry => {
    const entry: CatalogEntry = { at: Date.now(), value: readCatalog(), settled: false };
    entry.value.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (catalogCache === entry) catalogCache = null;
      },
    );
    return entry;
  };
  const catalog = (options: { refresh?: boolean } = {}): Promise<HarnessCatalogView> => {
    const cached = catalogCache;
    if (options.refresh || cached === null) {
      catalogCache = ask();
      return catalogCache.value;
    }
    if (cached.settled && Date.now() - cached.at >= CATALOG_TTL_MS) {
      catalogCache = ask();
      return cached.value;
    }
    return cached.value;
  };

  /**
   * `--validate` judges a block against the stage set of whatever role it
   * believes the loop holds, so a caller's role has to reach it too — and so
   * does the loop's IDENTITY, because `models.ts:rolesForValidation` keys the
   * role it is given by `RALPH_PROJECT_ID`/`RALPH_LOOP_NAME`. With the role but
   * without the identity it tags the wrong loop and changes nothing, which is
   * why this takes both or neither.
   *
   * Without them a triager's three-stage block is validated as a coder's and
   * refused for "missing 'executor'" — on preview and on save, after the form
   * had just helped write it.
   */
  const validateText = async (
    text: string,
    identity?: { project: string; loop: string; role?: string },
  ): Promise<ValidationResult> => {
    const contract = COMMAND_SURFACE.validate.contract;
    const role = identity?.role;
    const args = role === undefined ? [cli, COMMAND_SURFACE.validate.flag, "-"] : [cli, COMMAND_SURFACE.validate.flag, "-", "--role", role];
    const command = `${bunPath} ${args.join(" ")}`;
    const result = await exec(bunPath, args, {
      cwd: cliDir,
      env: identity === undefined ? baseEnv : withLoop(identity.project, identity.loop),
      timeout,
      input: text,
    });
    // A role the runtime does not know prints usage to stderr and nothing to
    // stdout, which `parse` would call contract drift — a 500 for the caller's
    // own bad selector. Same guard as `readSchema`.
    const refusal = resolverMessage(result.stderr);
    if (result.code !== 0 && result.stdout.trim() === "" && /--role/.test(refusal)) {
      throw new LineupRequestError(refusal);
    }
    // `--validate` exits 1 for a rejected candidate and still prints its JSON,
    // so the exit status is not treated as a crash; only an unparseable or
    // unexpected response is.
    return narrowValidation(parse(contract, command, result), contract);
  };

  /**
   * Re-resolve candidate text through a temp file: `--json` takes a path, and
   * the editor must never write the candidate over the live file to preview it.
   * The temp lives in the OS directory, so the live checkout is untouched even
   * on the way through.
   */
  const resolveCandidateText = async (
    text: string,
    project: string,
    loop: string,
    role?: string,
  ): Promise<ResolvedLineup> => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-lineup-preview-"));
    const path = join(dir, "models.json");
    try {
      writeFileSync(path, text);
      return await readResolved(path, project, loop, role);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * The one-time move of a pre-project file's loop blocks under `loggd`, run
   * before the file is read for a view or merged into on save: a view of a
   * file still in the old shape would show no project's blocks. A no-op once
   * done; a file it cannot read is left for the read to report.
   */
  const migrate = async (path: string): Promise<void> => {
    await exec(bunPath, [cli, COMMAND_SURFACE.migrate.flag, path], { cwd: cliDir, env: baseEnv, timeout });
  };

  /**
   * The current file, or the resolver's own refusal of it.
   *
   * A file this process cannot read or parse is handed to `models.ts --json` at
   * its real path, so the operator sees the resolver's wording and its restore
   * guidance (keyed to that root's checkout) verbatim — never a paraphrase kept
   * in step by hand, which is how the two came to disagree.
   */
  const readConfig = async (path: string, project: string, loop: string): Promise<{ config: JsonObject; text: string }> => {
    await migrate(path);
    try {
      const text = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return { config: parsed, text };
    } catch {
      // Unreadable or unparseable: the resolver says why, below.
    }
    await readResolved(path, project, loop);
    // The resolver accepted what this process could not read as a JSON object:
    // the CLI's accepted input has drifted from the contract.
    throw new LineupContractError(
      COMMAND_SURFACE.read.contract,
      `accepted ${path}, which is not a readable JSON object`,
    );
  };

  /** The file a project's view makes: merged under that project's key into the file as it is now. */
  const fileFor = async (root: string, project: string, loop: string, view: JsonObject): Promise<JsonObject> => {
    const { config: current } = await readConfig(modelsPath(root), project, loop);
    return mergeProjectView(current, project, view);
  };

  const previewCandidate = async (
    root: string,
    project: string,
    loop: string,
    view: JsonObject,
    role?: string,
  ): Promise<LineupPreview> => {
    const text = serializeConfig(await fileFor(root, project, loop, view));
    const validation = await validateText(text, { project, loop, role });
    if (!validation.valid) {
      // No resolution to read a role off, so the caller's role if it named
      // one, else the coder's: the caller is being handed a refusal, not a
      // form to fill in.
      const runtimeSchema = await schema(role);
      return { root, project, loop, valid: false, problems: validation.problems, resolved: null, schema: runtimeSchema, shadows: [] };
    }
    const resolved = await resolveCandidateText(text, project, loop, role);
    // The role comes from the resolution, so the rules and the lineup describe
    // the same loop: a schema for another role would offer stages the resolved
    // lineup does not have.
    const runtimeSchema = await schema(resolved.role);
    return { root, project, loop, valid: true, problems: [], resolved, schema: runtimeSchema, shadows: computeShadows(baseEnv, resolved) };
  };

  /** `model-updates.ts` prefixes its refusals the way the resolver does; the operator wants the rest. */
  const updatesMessage = (stderr: string): string => stderr.trim().replace(/^model-updates:\s*/, "");
  const updatesCli = join(cliDir, COMMAND_SURFACE.updates.script);

  const updates = async (options: { root?: string; project?: string } = {}): Promise<ModelUpdatesView> => {
    const root = resolveRoot(options.root);
    const project = resolveProject(options.project);
    const path = modelsPath(root);
    // The same one-time move every read makes first: a pre-project file has
    // no project blocks for the report to find.
    await migrate(path);
    const contract = COMMAND_SURFACE.updates.contract;
    const args = [updatesCli, COMMAND_SURFACE.updates.flag, "--project", project, "--file", path];
    const command = `${bunPath} ${args.join(" ")}`;
    const result = await exec(bunPath, args, { cwd: cliDir, env: baseEnv, timeout });
    if (result.code !== 0) throw new LineupRefusedError(updatesMessage(result.stderr) || `${command} exited ${result.code}`);
    return narrowUpdates(parse(contract, command, result), { root, project }, contract);
  };

  const answerUpdate = async (input: {
    root?: string;
    project?: string;
    block?: string;
    fileDefault?: boolean;
    answer: ModelUpdateAnswer;
  }): Promise<ModelUpdateResult> => {
    const root = resolveRoot(input.root);
    const project = resolveProject(input.project);
    if (!(MODEL_UPDATE_ANSWERS as readonly string[]).includes(input.answer)) {
      throw new LineupRequestError(`'answer' must be one of ${MODEL_UPDATE_ANSWERS.join(", ")}`);
    }
    const block = input.block?.trim();
    if (input.fileDefault !== true && (block === undefined || block === "")) {
      throw new LineupRequestError("'block' names the models.json block the answer is for");
    }
    const path = modelsPath(root);
    await migrate(path);
    const contract = COMMAND_SURFACE.answer.contract;
    const where = input.fileDefault === true ? ["--file-default"] : ["--project", project, "--block", block!];
    const args = [updatesCli, COMMAND_SURFACE.answer.flag, input.answer, ...where, "--file", path];
    const command = `${bunPath} ${args.join(" ")}`;
    const result = await exec(bunPath, args, { cwd: cliDir, env: baseEnv, timeout });
    // A refusal — no such block, an edit the resolver would refuse — is the
    // CLI's own sentence, and the file is untouched.
    if (result.code !== 0) throw new LineupRefusedError(updatesMessage(result.stderr) || `${command} exited ${result.code}`);
    return narrowAnswer(parse(contract, command, result), root, contract);
  };

  return {
    roots,
    updates,
    answerUpdate,
    async read(options = {}): Promise<LineupRead> {
      const root = resolveRoot(options.root);
      const project = resolveProject(options.project);
      const loop = resolveLoop(options.loop);
      const path = modelsPath(root);
      // The config is read once and the resolver is run against THOSE bytes,
      // not against a second read of the path: a concurrent save must not leave
      // the returned `config` disagreeing with the returned `resolved`.
      const { config, text } = await readConfig(path, project, loop);
      // A loop configured BEFORE its role existed carries a complete five-stage
      // block, which the resolver rightly refuses for a triager — and a refusal
      // here has nowhere to go, because `LineupRead` carries no problems and a
      // non-null `resolved`. So the role-less resolution is the fallback: the
      // form opens exactly as it did before roles, and the refusal reaches the
      // operator the moment they preview or save, naming the stages to remove.
      const resolved = await resolveWithRoleFallback(text, project, loop, options.role);
      const runtimeSchema = await schema(resolved.role);
      return {
        root,
        project,
        loop,
        config: projectView(config, project),
        resolved,
        schema: runtimeSchema,
        shadows: computeShadows(baseEnv, resolved),
      };
    },
    async preview({ root: rootSelector, project: projectSelector, loop: loopSelector, config, role }): Promise<LineupPreview> {
      return previewCandidate(resolveRoot(rootSelector), resolveProject(projectSelector), resolveLoop(loopSelector), config, role);
    },
    async edit({ root: rootSelector, project: projectSelector, loop: loopSelector, config, edit, role }): Promise<LineupEdit> {
      const root = resolveRoot(rootSelector);
      const project = resolveProject(projectSelector);
      const loop = resolveLoop(loopSelector);
      // The stage list is the runtime's for THIS loop's role, so a new block is
      // complete by the resolver's definition of complete for it — and a stage
      // the role does not run is refused here rather than written and then
      // refused by the validator. The edit itself still holds no legality rule.
      const before = serializeConfig(await fileFor(root, project, loop, config));
      const { stages } = await schema(await roleOf(before, project, loop, role));
      const candidate = structuredClone(config);
      try {
        if (edit.kind === "stage") setStage(candidate, loop, edit.stage, edit.change, stages);
        else if (edit.kind === "create") createLoopBlock(candidate, loop, stages);
        else removeLoopBlock(candidate, loop);
      } catch (error) {
        throw new LineupRequestError(error instanceof Error ? error.message : String(error));
      }
      try {
        return { ...(await previewCandidate(root, project, loop, candidate, role)), config: candidate };
      } catch (error) {
        if (!(error instanceof LineupRefusedError)) throw error;
        // The candidate validated, but the resolver refused it under the live
        // environment — an override stranded on a stage the edit moved. The
        // edit is kept and the refusal reported in the resolver's own words,
        // so the operator sees why instead of losing the edit to a 400.
        return {
          root,
          project,
          loop,
          valid: false,
          problems: [error.message],
          resolved: null,
          // The role's rules, not the coder's: one refused edit must not flip
          // the form from three stages back to five.
          schema: await schema(role),
          shadows: [],
          config: candidate,
        };
      }
    },
    async save({ root: rootSelector, project: projectSelector, loop: loopSelector, config, role }): Promise<LineupSave> {
      const root = resolveRoot(rootSelector);
      const project = resolveProject(projectSelector);
      const loop = resolveLoop(loopSelector);
      // Merged into the file as it is at save time, so a concurrent save to
      // another project's keys is kept rather than overwritten.
      const text = serializeConfig(await fileFor(root, project, loop, config));
      // The same role the preview was judged under: a save that refused what
      // the form had just shown as valid would be the worse of the two bugs.
      const validation = await validateText(text, { project, loop, role });
      if (!validation.valid) {
        return { root, project, loop, valid: false, problems: validation.problems };
      }
      writeConfigAtomically(modelsPath(root), text);
      return { root, project, loop, valid: true, problems: [] };
    },
    catalog,
  };
}
