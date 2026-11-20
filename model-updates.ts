#!/usr/bin/env bun
/**
 * Which agents run an older Claude model than the latest of its family, and
 * what the operator said about it (#851).
 *
 * `models.json` names a full id per stage, so a loop pinned to
 * `claude-opus-5` keeps running it after `claude-opus-5-5` ships: testo and
 * tria did, for about 15k turns, and nothing said so. This module finds those
 * stages and records the operator's answer per agent — one `models.json`
 * block — in that block's `updates` object:
 *
 *   "updates": { "policy": "ask" | "auto" | "pinned", "skip": [ids], "snoozedUntil": iso | null }
 *
 * A block with no `updates` is `ask`. A malformed one is read as `pinned`: an
 * object nobody can read must never be the reason a model changed.
 *
 * Nothing here waits on an answer. The dashboard asks (`--json`, `--answer`);
 * `ralph.sh` applies `auto` blocks at loop start (`--apply-auto`), best
 * effort, before the lineup is resolved; an unanswered question leaves the
 * model as it is.
 *
 * "Latest" is the installed Claude Code's own `latest_per_family` map — what
 * `--model opus` means on this host — over `models.ts`'s `ALIASES`, which
 * answers only when no binary can be read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readClaudeLatest } from './harness-catalog';
import { aliasTargets, collectProblems, loadConfig, ModelConfigError, writeConfigFile } from './models';

const RALPH_DIR = dirname(fileURLToPath(import.meta.url));

export const POLICIES = ['ask', 'auto', 'pinned'] as const;
export type Policy = (typeof POLICIES)[number];

export const ANSWERS = ['update', 'snooze', 'skip', 'pin', 'auto', 'ask'] as const;
export type Answer = (typeof ANSWERS)[number];

/** How long "Not now" holds the question back. */
export const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export class ModelUpdatesError extends Error {}

export interface UpdatePolicy {
  policy: Policy;
  /** Latest ids the operator said not to be asked about again. */
  skip: string[];
  snoozedUntil: string | null;
  /** The block's `updates` could not be read; `policy` is then `pinned`. */
  malformed: boolean;
}

export interface OutdatedStage {
  /** Dotted, as `models.ts` names stages: `orchestrator`, `review.spec`. */
  stage: string;
  model: string;
  /** The id this stage would move to: the family's latest, with the stage's suffix kept. */
  latest: string;
}

export interface AgentUpdates extends UpdatePolicy {
  /** Null for the file's own `default` block, which belongs to no project. */
  project: string | null;
  block: string;
  outdated: OutdatedStage[];
  /** Whether the operator should be asked now: `ask`, not snoozed, and an outdated stage not skipped. */
  ask: boolean;
}

export interface UpdatesReport {
  latest: Record<string, string>;
  /** Where `latest` came from, for the operator: a binary's path, or `models.ts`. */
  latestSource: string;
  agents: AgentUpdates[];
}

export interface StageChange {
  project: string | null;
  block: string;
  stage: string;
  from: string;
  to: string;
}

/** Where a block lives: a project's key, or the file's own `default` when `project` is null. */
export interface BlockAddress {
  project: string | null;
  block: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `claude-<family>-<version>` with an optional snapshot date and context
 * suffix: `claude-haiku-4-5-20251001`, `claude-opus-5[1m]`. Anything else —
 * an alias, another provider's id, the old `claude-3-5-sonnet` order — is not
 * a Claude id this module will ever move.
 */
const CLAUDE_ID = /^claude-([a-z]+)-(\d{1,3}(?:-\d{1,3})*)(-\d{8})?(\[[^\]]*\])?$/;

export function parseClaudeId(id: string): { family: string; version: number[]; suffix: string } | null {
  const match = CLAUDE_ID.exec(id);
  if (match === null) return null;
  return { family: match[1]!, version: match[2]!.split('-').map(Number), suffix: match[4] ?? '' };
}

const compareVersions = (a: number[], b: number[]): number => {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/**
 * The id `model` should move to, or null when it is current, newer, not a
 * Claude id, or of a family the map does not name. Never a downgrade: a host
 * whose Claude Code is older than the lineup leaves the lineup alone.
 */
export function newerFor(model: string, latest: Record<string, string>): string | null {
  const parsed = parseClaudeId(model);
  if (parsed === null) return null;
  const target = latest[parsed.family];
  if (target === undefined) return null;
  const head = parseClaudeId(target);
  if (head === null || head.family !== parsed.family) return null;
  if (compareVersions(parsed.version, head.version) >= 0) return null;
  // The context suffix is the operator's choice of window, not part of the
  // version: `claude-opus-5[1m]` moves to `claude-opus-5-5[1m]`.
  return `${target}${parsed.suffix}`;
}

export function readPolicy(value: unknown): UpdatePolicy {
  const fallback: UpdatePolicy = { policy: 'ask', skip: [], snoozedUntil: null, malformed: false };
  if (value === undefined) return fallback;
  const pinned: UpdatePolicy = { policy: 'pinned', skip: [], snoozedUntil: null, malformed: true };
  if (!isPlainObject(value)) return pinned;
  const policy = value.policy ?? 'ask';
  if (typeof policy !== 'string' || !(POLICIES as readonly string[]).includes(policy)) return pinned;
  const skip = value.skip ?? [];
  if (!Array.isArray(skip) || skip.some((entry) => typeof entry !== 'string')) return pinned;
  const snoozed = value.snoozedUntil ?? null;
  if (snoozed !== null && (typeof snoozed !== 'string' || Number.isNaN(Date.parse(snoozed)))) return pinned;
  return { policy: policy as Policy, skip: skip as string[], snoozedUntil: snoozed as string | null, malformed: false };
}

/**
 * Every `claude`-runner stage of a block with an older id, in the block's
 * order. Read by shape rather than against the role's stage list: a block is
 * judged by the validator elsewhere, and this only has to find model ids.
 */
export function outdatedStages(block: Record<string, unknown>, latest: Record<string, string>): OutdatedStage[] {
  const found: OutdatedStage[] = [];
  const visit = (node: Record<string, unknown>, stage: string) => {
    if (node.runner !== 'claude' || typeof node.model !== 'string') return;
    const to = newerFor(node.model.trim(), latest);
    if (to !== null) found.push({ stage, model: node.model.trim(), latest: to });
  };
  for (const [key, value] of Object.entries(block)) {
    if (key === 'updates' || key.startsWith('$') || !isPlainObject(value)) continue;
    if ('model' in value || 'runner' in value) {
      visit(value, key);
      continue;
    }
    for (const [tail, nested] of Object.entries(value)) {
      if (isPlainObject(nested)) visit(nested, `${key}.${tail}`);
    }
  }
  return found;
}

/** Every block the file holds, the file's `default` first, each with where it lives. */
function blocksOf(config: Record<string, unknown>, project?: string): { address: BlockAddress; block: Record<string, unknown> }[] {
  const out: { address: BlockAddress; block: Record<string, unknown> }[] = [];
  if (isPlainObject(config.default)) out.push({ address: { project: null, block: 'default' }, block: config.default });
  for (const [key, value] of Object.entries(config)) {
    if (key === 'default' || key.startsWith('$') || !isPlainObject(value)) continue;
    if (project !== undefined && key !== project) continue;
    for (const [name, block] of Object.entries(value)) {
      if (name.startsWith('$') || !isPlainObject(block)) continue;
      out.push({ address: { project: key, block: name }, block });
    }
  }
  return out;
}

/**
 * Each block's outdated stages and its policy. `project` narrows the report to
 * that project's blocks; the file's `default` is always in it, because every
 * project falls back to it.
 */
export function updatesReport(
  config: Record<string, unknown>,
  latest: { latest: Record<string, string>; source: string },
  now: number,
  project?: string,
): UpdatesReport {
  const agents = blocksOf(config, project).map(({ address, block }): AgentUpdates => {
    const policy = readPolicy(block.updates);
    const outdated = outdatedStages(block, latest.latest);
    const snoozed = policy.snoozedUntil !== null && Date.parse(policy.snoozedUntil) > now;
    const ask =
      policy.policy === 'ask' && !snoozed && outdated.some((stage) => !policy.skip.includes(stage.latest));
    return { ...address, ...policy, outdated, ask };
  });
  return { latest: { ...latest.latest }, latestSource: latest.source, agents };
}

function findBlock(config: Record<string, unknown>, address: BlockAddress): Record<string, unknown> {
  const holder = address.project === null ? config : config[address.project];
  const block = isPlainObject(holder) ? holder[address.project === null ? 'default' : address.block] : undefined;
  if (address.project === null && address.block !== 'default') {
    throw new ModelUpdatesError(`the file's own blocks are 'default' only, not '${address.block}'.`);
  }
  if (!isPlainObject(block)) {
    const where = address.project === null ? "the file's 'default'" : `'${address.project}.${address.block}'`;
    throw new ModelUpdatesError(`models.json has no block ${where}.`);
  }
  return block;
}

/** Move every outdated stage of `block` to its latest, in place. */
function moveStages(block: Record<string, unknown>, address: BlockAddress, latest: Record<string, string>): StageChange[] {
  const changes: StageChange[] = [];
  for (const stage of outdatedStages(block, latest)) {
    const [head, tail] = stage.stage.split('.');
    const node = (tail === undefined ? block[head!] : (block[head!] as Record<string, unknown>)[tail]) as Record<string, unknown>;
    node.model = stage.latest;
    changes.push({ ...address, stage: stage.stage, from: stage.model, to: stage.latest });
  }
  return changes;
}

const writePolicy = (block: Record<string, unknown>, policy: Omit<UpdatePolicy, 'malformed'>): void => {
  block.updates = { policy: policy.policy, skip: policy.skip, snoozedUntil: policy.snoozedUntil };
};

/**
 * The operator's answer for one block, applied to a copy of the file.
 *
 * - `update`: every outdated stage moves now; the policy stays as it is.
 * - `snooze`: asked again after `SNOOZE_MS`.
 * - `skip`: not asked again about these latest ids; a newer one asks again.
 * - `pin`: never asked again about this block.
 * - `auto`: moved now, and at every loop start from now on.
 * - `ask`: back to asking, the snooze cleared — how a pin or `auto` is undone.
 */
export function applyAnswer(
  config: Record<string, unknown>,
  address: BlockAddress,
  answer: Answer,
  latest: Record<string, string>,
  now: number,
): { config: Record<string, unknown>; changes: StageChange[] } {
  const next = structuredClone(config);
  const block = findBlock(next, address);
  const current = readPolicy(block.updates);
  // A malformed object is replaced by the answer, starting from `ask`'s
  // defaults rather than the `pinned` it was read as.
  const base = current.malformed ? { policy: 'ask' as Policy, skip: [], snoozedUntil: null } : current;
  let changes: StageChange[] = [];
  switch (answer) {
    case 'update':
      changes = moveStages(block, address, latest);
      break;
    case 'snooze':
      writePolicy(block, { ...base, snoozedUntil: new Date(now + SNOOZE_MS).toISOString() });
      break;
    case 'skip': {
      const skip = [...base.skip];
      for (const stage of outdatedStages(block, latest)) if (!skip.includes(stage.latest)) skip.push(stage.latest);
      writePolicy(block, { ...base, skip });
      break;
    }
    case 'pin':
      writePolicy(block, { ...base, policy: 'pinned' });
      break;
    case 'auto':
      writePolicy(block, { ...base, policy: 'auto', snoozedUntil: null });
      changes = moveStages(block, address, latest);
      break;
    case 'ask':
      writePolicy(block, { ...base, policy: 'ask', snoozedUntil: null });
      break;
  }
  return { config: next, changes };
}

/**
 * Every `auto` block of `project`, and the file's `default` when it is
 * `auto`, moved to the latest — what `ralph.sh` runs at loop start.
 */
export function applyAuto(
  config: Record<string, unknown>,
  project: string,
  latest: Record<string, string>,
): { config: Record<string, unknown>; changes: StageChange[] } {
  const next = structuredClone(config);
  const changes: StageChange[] = [];
  for (const { address, block } of blocksOf(next, project)) {
    const policy = readPolicy(block.updates);
    if (policy.policy !== 'auto' || policy.malformed) continue;
    changes.push(...moveStages(block, address, latest));
  }
  return { config: next, changes };
}

/**
 * The validator's problems the edit ADDED, which refuse the write.
 *
 * Not "the file must be valid": the validator is run here without the
 * project's roster, so it judges a triager's own three-stage block as a
 * coder's and refuses it — on a file the loops run happily. Swapping one
 * Claude id for a newer one cannot make a valid block invalid, but this is
 * the check that says so rather than assuming it.
 */
export function problemsAdded(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const known = new Set(collectProblems(before));
  return collectProblems(after).filter((problem) => !known.has(problem));
}

/**
 * The latest ids, and whether they came from the installed Claude Code.
 *
 * The binary's map alone when it can be read — never filled in from
 * `ALIASES`, because an id this Claude Code does not know is a loop that
 * fails every turn. `ALIASES` answers only when no binary can be read, and
 * then `fromBinary` is false: the dashboard may still show the report, but
 * `--apply-auto` moves nothing on it.
 */
export function readLatest(env: NodeJS.ProcessEnv = process.env): { latest: Record<string, string>; source: string; fromBinary: boolean } {
  const fromBinary = readClaudeLatest(env);
  if (fromBinary !== null) return { latest: { ...fromBinary.latest }, source: fromBinary.source, fromBinary: true };
  return { latest: aliasTargets(), source: 'models.ts ALIASES (no Claude Code binary could be read)', fromBinary: false };
}

/** The file as bytes and as an object, from ONE read, so a later compare means something. */
function readSnapshot(file: string): { text: string; config: Record<string, unknown> } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // The resolver's own refusal, with its restore guidance.
    return { text: '', config: loadConfig(file, false) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { text, config: loadConfig(file, false) };
  }
  return { text, config: parsed as Record<string, unknown> };
}

/**
 * Apply `edit` to the file and write it, unless the file changed underneath.
 *
 * Every loop on the host shares `models.json`, and a lineup save, an answer
 * and another loop's start can all write it. A plain load-edit-write would
 * drop whichever landed in between, so the bytes are compared just before the
 * rename and the edit is re-applied to the new file when they moved. Only a
 * file that keeps moving gives up, writing nothing.
 */
export function commit(
  file: string,
  edit: (config: Record<string, unknown>) => { config: Record<string, unknown>; changes: StageChange[]; write: boolean },
): { config: Record<string, unknown>; changes: StageChange[] } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = readSnapshot(file);
    const result = edit(before.config);
    if (!result.write) return result;
    const added = problemsAdded(before.config, result.config);
    if (added.length > 0) throw new ModelUpdatesError(`refusing to write a lineup the resolver would refuse:\n  ${added.join('\n  ')}`);
    let now: string | null;
    try {
      now = readFileSync(file, 'utf8');
    } catch {
      now = null;
    }
    if (now !== before.text) continue;
    writeConfigFile(file, result.config);
    return result;
  }
  throw new ModelUpdatesError(`${file} kept changing while this edit was being written; nothing was written.`);
}

const describeChange = (change: StageChange): string =>
  `${change.project === null ? 'default' : `${change.project}.${change.block}`} ${change.stage}: ${change.from} → ${change.to}`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new ModelUpdatesError(`${name} needs a value.`);
  return value;
}

const USAGE = [
  'usage: bun model-updates.ts --json [--project P] [--file F]',
  '         every block of P (and the file\'s default) with its outdated stages and policy, as JSON',
  '       bun model-updates.ts --answer A --project P --block B [--file F]',
  '       bun model-updates.ts --answer A --file-default [--file F]',
  `         record A (${ANSWERS.join(', ')}) for one block; prints the changes as JSON`,
  '       bun model-updates.ts --apply-auto --project P [--file F]',
  '         move every auto block of P to the latest; one line per change',
].join('\n');

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): number {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  try {
    const file = flag(args, '--file') ?? join(RALPH_DIR, 'models.json');
    const project = flag(args, '--project');
    // Before the file is read: scanning the binary takes a while, and the
    // file should be read as close to its write as it can be.
    const latest = readLatest(env);

    if (args.includes('--json')) {
      // Never migrated here: a pre-project file is the lineup editor's to move.
      console.log(JSON.stringify(updatesReport(readSnapshot(file).config, latest, now, project), null, 2));
      return 0;
    }

    if (args.includes('--apply-auto')) {
      if (project === undefined) throw new ModelUpdatesError('--apply-auto needs --project.');
      if (!latest.fromBinary) {
        // Unattended, the only safe latest is the one the loop's own Claude
        // Code will accept. Said once, when it holds an auto block back.
        const pending = applyAuto(readSnapshot(file).config, project, latest.latest).changes;
        if (pending.length > 0) {
          console.log('model-updates: auto updates wait for a readable Claude Code binary; nothing was moved.');
        }
        return 0;
      }
      const { changes } = commit(file, (config) => {
        const moved = applyAuto(config, project, latest.latest);
        return { ...moved, write: moved.changes.length > 0 };
      });
      for (const change of changes) console.log(`model-updates: ${describeChange(change)} (auto)`);
      return 0;
    }

    const answer = flag(args, '--answer');
    if (answer !== undefined) {
      if (!(ANSWERS as readonly string[]).includes(answer)) {
        throw new ModelUpdatesError(`--answer takes one of ${ANSWERS.join(', ')}, not '${answer}'.`);
      }
      const fileDefault = args.includes('--file-default');
      const block = flag(args, '--block');
      if (fileDefault === (block !== undefined) || (!fileDefault && project === undefined)) {
        throw new ModelUpdatesError('--answer needs --project P --block B, or --file-default.');
      }
      const address: BlockAddress = fileDefault ? { project: null, block: 'default' } : { project: project!, block: block! };
      const { config: next, changes } = commit(file, (config) => ({
        ...applyAnswer(config, address, answer as Answer, latest.latest, now),
        write: true,
      }));
      const after = updatesReport(next, latest, now, address.project ?? undefined).agents.find(
        (agent) => agent.project === address.project && agent.block === address.block,
      );
      console.log(JSON.stringify({ ...address, answer, changes, agent: after ?? null }, null, 2));
      return 0;
    }
    console.error(`model-updates: no command.\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof ModelUpdatesError || error instanceof ModelConfigError) {
      console.error(`model-updates: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

// `process.exitCode`, never `process.exit()`, as in `models.ts`: stdout to a
// pipe is written asynchronously.
if (import.meta.main) {
  process.exitCode = main(process.argv);
}
