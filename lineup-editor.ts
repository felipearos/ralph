/**
 * The lineup editor's pure edit/serialize layer, plus the two boundary calls
 * around it: the CLI that judges a candidate, and the write that commits one.
 *
 * This module is deliberately extractable from the Ralph runtime, so it never
 * imports `ralph/models.ts` (or any other `ralph/*.ts`). It knows the *shape*
 * of `models.json` and nothing about its legality: runner capabilities, the
 * Agent-tool alias set, and the model-id rules all live in the resolver, which
 * is reached only by spawning `bun ralph/models.ts --validate` and reading the
 * JSON it prints. A candidate this layer produces is therefore checked by the
 * same rules the supervisor would check it with, not by a second copy that
 * could drift.
 *
 * `models.json` keys loop blocks by project. A form edits one project at a
 * time through `projectView`, a flat document with that project's loops and
 * the `default` they fall back to, which `mergeProjectView` writes back under
 * the project's key alone. The edits below take that flat shape.
 *
 * The edits mutate the parsed object in place. `JSON.parse` preserves key
 * insertion order, so mutating is what makes a round trip keep the file's
 * `$comment`/`$comment_loops` and the ordering of everything already there,
 * while a newly created loop block is appended last, its stage keys inserted
 * in the order the runtime's schema names them.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RALPH_DIR = dirname(fileURLToPath(import.meta.url));

export type JsonObject = Record<string, unknown>;

/** The fields a form can set on one stage. */
export interface StageChange {
  runner?: string;
  model?: string;
  /** `null` removes the key; an absent field leaves it untouched. */
  effort?: string | null;
  /** `null` removes the key; an absent field leaves it untouched. */
  fallback?: string[] | null;
  fallbackEfforts?: Record<string, string> | null;
}

/** The verdict `models.ts --validate` prints. */
export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The CLI's JSON is a contract, not a hint: a response that does not match the
 * expected shape is an error naming the command and the output, never a value
 * coerced into a plausible-looking result.
 */
const isValidationResult = (value: unknown): value is ValidationResult =>
  isPlainObject(value) &&
  typeof value.valid === 'boolean' &&
  Array.isArray(value.problems) &&
  value.problems.every((problem) => typeof problem === 'string');

/** `review.standards` → `['review', 'standards']`. */
const stageParts = (stage: string): string[] => stage.split('.');

/** The node for a dotted stage, or undefined when the block does not have it. */
function readStageNode(block: JsonObject, stage: string): JsonObject | undefined {
  let node: unknown = block;
  for (const part of stageParts(stage)) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return isPlainObject(node) ? node : undefined;
}

/**
 * The node for a dotted stage, creating the intermediate objects a nested
 * stage needs (`review.standards` needs a `review` object). Insertion order is
 * the caller's: `stages` is walked in order when a block is built, so a new
 * block reads top to bottom the way the runtime lists its stages.
 */
function ensureStageNode(block: JsonObject, stage: string): JsonObject {
  let node = block;
  for (const part of stageParts(stage)) {
    const next = node[part];
    if (!isPlainObject(next)) node[part] = {};
    node = node[part] as JsonObject;
  }
  return node;
}

/** Copy one stage's fields into a block that does not have the stage yet. */
function copyStage(from: JsonObject, to: JsonObject, stage: string): void {
  const source = readStageNode(from, stage);
  if (source === undefined) return;
  const target = ensureStageNode(to, stage);
  for (const [key, value] of Object.entries(source)) target[key] = value;
}

/**
 * Create or complete a named loop's block, all five stages.
 *
 * A named loop's block is a COMPLETE lineup — the resolver replaces `default`
 * with it rather than merging, so a partial block leaves the loop with no
 * model for the stages it omitted. A loop without a block is built from
 * `default`, with stage keys ordered by `stages`; an existing block keeps
 * every stage it already names and is filled from `default` for the rest, so
 * completing one never overwrites an operator's earlier per-stage edit.
 *
 * `stages` is the runtime's list — read from `models.ts --schema` by the
 * caller — rather than a copy hardcoded here, so a stage added to the runtime
 * reaches a new block without a second edit in this file.
 */
export function createLoopBlock(config: JsonObject, loop: string, stages: readonly string[]): JsonObject {
  if (loop === 'default') {
    throw new Error("the 'default' block is not created — edit it in place.");
  }
  // `@triager` is a ROLE's default lineup, not a loop (`ralph/models.ts`), and
  // it is complete over that role's stages rather than over the ones this call
  // was handed. Editing one as a loop is how a triager's default acquires an
  // executor the resolver then refuses.
  if (loop.startsWith('@')) {
    throw new Error(`'${loop}' is a role's default lineup, not a loop — edit it in models.json.`);
  }
  const base = config.default;
  if (!isPlainObject(base)) {
    throw new Error("models.json has no 'default' block to complete a named loop from.");
  }
  const existing = config[loop];
  // A block that is absent or not an object is replaced; one that is an object
  // is completed stage by stage, so a partial block keeps what it already has.
  if (!isPlainObject(existing)) {
    const block: JsonObject = {};
    for (const stage of stages) copyStage(base, block, stage);
    config[loop] = block;
    return config;
  }
  for (const stage of stages) {
    if (readStageNode(existing, stage) === undefined) copyStage(base, existing, stage);
  }
  return config;
}

function applyChange(node: JsonObject, change: StageChange): void {
  if (change.runner !== undefined) node.runner = change.runner;
  if (change.model !== undefined) node.model = change.model;
  if (change.effort !== undefined) {
    if (change.effort === null) delete node.effort;
    else node.effort = change.effort;
  }
  if (change.fallbackEfforts !== undefined) {
    if (change.fallbackEfforts === null) delete node.fallbackEfforts;
    else node.fallbackEfforts = { ...change.fallbackEfforts };
  }
  if (change.fallback !== undefined) {
    if (change.fallback === null) delete node.fallback;
    else node.fallback = change.fallback;
    if (isPlainObject(node.fallbackEfforts)) {
      const kept = Object.fromEntries(Object.entries(node.fallbackEfforts)
        .filter(([id]) => change.fallback?.includes(id)));
      if (Object.keys(kept).length) node.fallbackEfforts = kept;
      else delete node.fallbackEfforts;
    }
  }
}

/**
 * Set a stage's runner/model/effort/fallback in the `default` block or a named
 * loop's.
 *
 * Editing a named loop creates or completes its block first (see
 * `createLoopBlock`), so a runner change arrives with the model that runner
 * needs instead of the resolver's "runner override stranded the block's
 * model" refusal.
 */
export function setStage(
  config: JsonObject,
  loop: string,
  stage: string,
  change: StageChange,
  stages: readonly string[],
): JsonObject {
  // A stage the runtime does not know must be refused here: the resolver reads
  // only the stages it knows, so a typo like `executer` would be written,
  // validate clean, and leave the old executor silently in place.
  if (!stages.includes(stage)) {
    throw new Error(`unknown stage '${stage}'; the runtime knows: ${stages.join(', ')}.`);
  }
  if (loop !== 'default') createLoopBlock(config, loop, stages);
  const block = config[loop];
  if (!isPlainObject(block)) {
    throw new Error(`models.json '${loop}' is not an object holding a complete lineup.`);
  }
  applyChange(ensureStageNode(block, stage), change);
  return config;
}

/**
 * Remove a named loop's block so the loop falls back to `default`. The
 * `default` block itself is not removable — it is what every loop without a
 * block resolves to.
 */
export function removeLoopBlock(config: JsonObject, loop: string): JsonObject {
  if (loop === 'default') {
    throw new Error("the 'default' block cannot be removed — every loop falls back to it.");
  }
  delete config[loop];
  return config;
}

/**
 * One project's lineup as a flat document of the shape the edits above take:
 * `default` is the block the project's loops fall back to — its own
 * `default` when it has one, else the file's — and every other key is one of
 * its loop blocks. Loop names repeat across projects, so a form edits this
 * view rather than the file: it cannot reach another project's blocks.
 */
export function projectView(config: JsonObject, project: string): JsonObject {
  const block = isPlainObject(config[project]) ? config[project] : {};
  const view: JsonObject = { default: isPlainObject(block.default) ? block.default : config.default };
  for (const [loop, value] of Object.entries(block)) {
    // `@<role>` keys are role default lineups, not loops: they are complete over
    // their own role's stages, so a view that offered them as loops would edit
    // them against the wrong set. Left out here and carried through unchanged
    // by `mergeProjectView`, exactly like the `$` commentary keys.
    if (loop !== 'default' && !loop.startsWith('@')) view[loop] = value;
  }
  return structuredClone(view);
}

/**
 * Write an edited view back into the file under the project's key, and
 * nowhere else: every other key — the file's `default`, other projects,
 * commentary — is carried over as it was.
 *
 * The view's `default` becomes the project's own only when the project
 * already had one or the edit changed it; an untouched inherited `default`
 * stays inherited. A project left with no blocks loses its key.
 */
export function mergeProjectView(config: JsonObject, project: string, view: JsonObject): JsonObject {
  const next = structuredClone(config);
  const current = isPlainObject(config[project]) ? config[project] : {};
  const wanted: JsonObject = {};
  const inherited = JSON.stringify(view.default) === JSON.stringify(config.default);
  if ('default' in current || !inherited) wanted.default = view.default;
  for (const [loop, value] of Object.entries(view)) {
    if (loop !== 'default' && !loop.startsWith('$') && !loop.startsWith('@')) wanted[loop] = value;
  }
  // The project's existing order first, then anything new, so a save moves
  // nothing a reviewer has to diff past.
  const block: JsonObject = {};
  for (const [key, value] of Object.entries(current)) {
    // Commentary and role defaults (`@triager`) are carried over as they were:
    // the view never held them, so an edited view must not be read as deleting
    // them.
    if (key.startsWith('$') || key.startsWith('@')) block[key] = value;
    else if (key in wanted) block[key] = wanted[key];
  }
  for (const [key, value] of Object.entries(wanted)) if (!(key in block)) block[key] = value;
  if (Object.keys(block).length === 0) delete next[project];
  else next[project] = block;
  return next;
}

/**
 * The config as the file's text: two-space JSON and a trailing newline, the
 * form `git diff` and a POSIX file are expected to have.
 */
export function serializeConfig(config: JsonObject): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface ValidatorOptions {
  /** The interpreter to run `models.ts` with. Defaults to `bun` on PATH. */
  bun?: string;
  /** The `models.ts` to run. Defaults to the one beside this module. */
  cli?: string;
}

/**
 * Validate a candidate config by handing it to the real resolver through the
 * CLI, never by restating a rule here.
 *
 * The candidate travels on stdin, so nothing touches disk before the verdict.
 * `models.ts --validate` exits 1 for a rejected candidate and still prints its
 * JSON, so the exit status is not treated as a crash; only an unparseable or
 * unexpected response is.
 */
export function validateConfigText(text: string, options: ValidatorOptions = {}): ValidationResult {
  const bun = options.bun ?? 'bun';
  const cli = options.cli ?? join(RALPH_DIR, 'models.ts');
  const command = `${bun} ${cli} --validate -`;
  const result = spawnSync(bun, [cli, '--validate', '-'], { input: text, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`cannot run the models validator (${command}): ${result.error.message}`);
  }
  const stdout = result.stdout ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `the models validator did not return JSON.\n` +
        `  command: ${command}\n` +
        `  status:  ${result.status}\n` +
        `  stdout:  ${JSON.stringify(stdout)}\n` +
        `  stderr:  ${JSON.stringify(result.stderr ?? '')}`,
    );
  }
  if (!isValidationResult(parsed)) {
    throw new Error(
      `the models validator returned an unexpected shape.\n` +
        `  command: ${command}\n` +
        `  stdout:  ${JSON.stringify(stdout)}`,
    );
  }
  return parsed;
}

/** Remove the temp file, swallowing a failure so the real error survives. */
function discardTemp(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // Nothing to clean up, or the failure was the temp path itself.
  }
}

let tempSequence = 0;

/**
 * A temp path in the target's own directory, unique per call and per process.
 *
 * The directory has to match for the rename to be atomic; the name has to be
 * unique so two overlapping saves — the HTTP adapter can serve them — do not
 * truncate and write through one shared inode, one renaming it out from under
 * the other.
 */
const tempPathFor = (path: string): string => `${path}.${process.pid}.${tempSequence++}.tmp`;

/**
 * Commit serialized config text to `path` as a temp file in the SAME directory
 * followed by an atomic rename, so a crash or a partial write can never become
 * the one config the loop refuses to start without.
 *
 * The write is looped rather than a single call because `writeSync` may write
 * fewer bytes than it was handed (a short write) without throwing; treating a
 * prefix as the whole file and renaming it would defeat the guarantee exactly
 * when storage is tight. A failure before the rename removes the temp file and
 * leaves the original untouched; a failure at the rename leaves the original
 * untouched too, since `rename` either replaces it wholly or does not happen.
 */
export function writeConfigAtomically(path: string, text: string): void {
  const temp = tempPathFor(path);
  try {
    const fd = openSync(temp, 'w', 0o644);
    try {
      const bytes = Buffer.from(text, 'utf8');
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written, bytes.length - written);
      }
      // Flushed before the rename: the rename is atomic against a crashed
      // process, but not against a write the kernel had not yet persisted.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    discardTemp(temp);
    throw error;
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    discardTemp(temp);
    throw error;
  }
}

/**
 * The save path a caller uses: serialize the candidate, let the CLI judge it,
 * and write only when it is accepted. A rejected candidate returns the CLI's
 * complete problem list and leaves the file exactly as it was.
 */
export function saveConfig(path: string, config: JsonObject, options: ValidatorOptions = {}): ValidationResult {
  const text = serializeConfig(config);
  const result = validateConfigText(text, options);
  if (!result.valid) return result;
  writeConfigAtomically(path, text);
  return result;
}
