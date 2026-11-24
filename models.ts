#!/usr/bin/env bun
/**
 * Which model runs which stage of the loop.
 *
 * Five stages spend tokens, and until now each one named its model somewhere
 * else: the orchestrator nowhere at all (`claude -p` took the account
 * default while `prompt.md` merely *asserted* Opus), the executor in three
 * places that could disagree (`delegate.sh`, and twice in `opencode-executor.jsonc`),
 * and the two review axes plus the mapper in English prose inside a 34K
 * prompt. Switching a model meant editing four files and hoping the prose and
 * the flag still agreed.
 *
 * So the lineup lives in `ralph/models.json` and this file is the only thing
 * that reads it:
 *
 *   orchestrator      Claude Code or Codex (ralph.sh)
 *   executor          a process `delegate.sh` starts, on the stage's runner
 *   mapper            a named `Agent`, or a process `inspect.sh` starts
 *   review.standards  the same
 *   review.spec       the same
 *   review.correctness  the same; optional in a block (see BUILT_IN_STAGES)
 *
 * A stage names a RUNNER as well as a model, because a model is only reachable
 * through a harness that can host it. On the `claude` runner the three
 * read-only stages are named subagents the supervisor defines per run
 * (`claudeAgents` below), so the definition — not the Agent call — carries the
 * model and the effort; on any other runner they are a process. The
 * orchestrator runs on Claude Code or Codex; stage instructions are rendered for
 * the selected harness.
 *
 * Loop blocks nest under the project they belong to, because loop names
 * repeat across projects and two projects' `ralph`s must not share a lineup:
 *
 *   { "default": {…}, "loggd": { "ralph": {…}, "default": {…} } }
 *
 * Resolution, highest first:
 *
 *   1. the environment             RALPH_MODEL_<STAGE>, RALPH_RUNNER_<STAGE>
 *   2. this loop's block           models.json[$RALPH_PROJECT_ID][$RALPH_LOOP_NAME]
 *   3. this project's default      models.json[$RALPH_PROJECT_ID].default
 *   4. the default block           models.json.default
 *
 * The project id is `RALPH_PROJECT_ID` (the supervisor exports it from
 * `project-config.ts`), else the id of the project this is run from.
 *
 * Before project keys the loop blocks sat at the top level. The first read of
 * such a file moves them under `loggd` (`LEGACY_PROJECT`), values unchanged,
 * and writes it back; after that a bare top-level loop block is refused.
 *
 * A block REPLACES the ones below it rather than merging into them: `rafa`
 * names all five stages or it is refused. Merging would make a lineup something you
 * reconstruct by diffing two blocks, and the question this file exists to
 * answer — "what ran that ticket?" — has to be answerable by reading one.
 *
 * Structural problems are fatal. A typo'd stage can silently run a different
 * model everywhere. Token accounting accepts any model id, so the lineup does
 * not depend on a catalogue that must be kept in sync.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectRoot } from './paths';
import { loadProjectConfig, ProjectConfigError, type MergeMethod, type ProjectConfig } from './project-config';
import { currentProjectId, LEGACY_PROJECT, PROJECT_ID } from './project-id';
import {
  DEFAULT_ROLE,
  isRole,
  roleDescriptor,
  ROLES,
  sectionRole,
  STAGES,
  stagesFor,
  type Role,
  type Stage,
} from './roles';
import {
  rosterBlock,
  rosterBranchGlobs,
  rosterCapitals,
  rosterHeadBranches,
  rosterProvenance,
} from './roster-prompt';

const RALPH_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The environment as this file reads it. Deliberately not `NodeJS.ProcessEnv`:
 * the app augments that type with its own required variables, and this file
 * wants any string map — the tests pass a three-key object.
 */
export type Env = Record<string, string | undefined>;

/**
 * The stages, re-exported: they are declared in `roles.ts`, because a role's
 * set has to be a typed subset of them and this module already imports that one
 * (the import back would be a cycle). Everything else reads them from here,
 * where the rules that judge a stage's model and runner live.
 */
export { STAGES, stagesFor, type Stage };

/**
 * `review.standards` → `REVIEW_STANDARDS`, the tail every variable shares;
 * `code-context` → `CODE_CONTEXT`, since a shell name cannot hold a hyphen.
 */
const varTail = (stage: Stage): string => stage.replace(/[.-]/g, '_').toUpperCase();

/** `review.standards` → `RALPH_MODEL_REVIEW_STANDARDS`. */
export const envNameFor = (stage: Stage): string => `RALPH_MODEL_${varTail(stage)}`;

/** `review.standards` → `RALPH_RUNNER_REVIEW_STANDARDS`. */
export const runnerEnvNameFor = (stage: Stage): string => `RALPH_RUNNER_${varTail(stage)}`;

/**
 * The harnesses a stage can run on. Not a free-form string: each one is a
 * different command with different rails, and a name nothing dispatches on is
 * a stage that silently does not run.
 */
export const RUNNERS = ['claude', 'opencode', 'codex'] as const;
export type Runner = (typeof RUNNERS)[number];

export interface ResolvedStage {
  model: string;
  /** The harness that runs this stage. */
  runner: Runner;
  /** Claude session or named-agent effort, or reasoning effort for any Codex stage. */
  effort?: string;
  /**
   * Ordered model ids tried after the primary external route exits 2
   * (unavailable) or 4 (failed). Provider-qualified ids use OpenCode, bare ids
   * use Codex, and Agent aliases are an ad-hoc Agent call. Only read-only stages whose
   * primary runner is not `claude` carry the chain.
   */
  fallback?: string[];
  /** Per-model reasoning effort for Codex routes in the ordered fallback chain. */
  fallbackEfforts?: Record<string, string>;
  /**
   * Where the value came from, for the lineup line in the supervisor log:
   * the environment, the loop's own block, its project's block for the loop's
   * ROLE (`@triager`), its project's `default`, or the file's `default`.
   */
  source: 'env' | 'loop' | 'role' | 'project' | 'default';
}

/**
 * One loop's resolved stages — the stages its ROLE has, and no others
 * (`roles.ts` `stages`). A triager's lineup holds no `executor` at all, so a
 * reader loops over `STAGES` and skips what is absent rather than reading a
 * model the role never runs.
 *
 * `orchestrator` is required because every role runs a session, which is what
 * lets the supervisor and the preflight reach it without a guard.
 */
export type Lineup = Partial<Record<Stage, ResolvedStage>> & { orchestrator: ResolvedStage };

/** The stages a lineup actually holds, in `STAGES` order. */
export const lineupStages = (lineup: Lineup): Stage[] => STAGES.filter((stage) => lineup[stage] !== undefined);

export class ModelConfigError extends Error {}

/**
 * The `Agent` tool's `model` parameter is an ENUM of these four aliases, not a
 * model id — `model: "claude-opus-5"` comes back as
 * `InputValidationError: expected one of "sonnet"|"opus"|"haiku"|"fable"`.
 * A Claude fallback is such an ad-hoc call, so it is fenced to these keys. A
 * named agent's definition takes either an alias or a full `claude-…` id.
 *
 * The values are what Claude Code resolves each alias to today, for the lineup
 * editor's labels and as `model-updates.ts`'s fallback answer to "which id is
 * the latest of its family" when no installed Claude Code binary can be read
 * (the binary's own `latest_per_family` wins whenever it can). The usage
 * ledger does not read them: it books each turn under the model its
 * transcript record names.
 */
const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-2',
};

/** A copy of `ALIASES`, for a module that must not be able to change it. */
export const aliasTargets = (): Record<string, string> => ({ ...ALIASES });

/**
 * What a non-`claude` read-only stage degrades to by default.
 *
 * `inspect.sh` exits 2 when its harness is missing or unauthenticated, and the
 * A configured chain may try other OpenCode or Codex models first. It ends in
 * an Agent alias by default so a missing external harness does not skip the
 * review. The chain is rendered into the invocation sentence, leaving no
 * mid-iteration model choice to the orchestrator.
 *
 * Opus rather than something cheap: this path is the last resort when external
 * routes are unavailable or fail, and it is the difference between the review
 * running and being skipped. A loop may name a longer chain in `fallback`.
 */
const DEFAULT_FALLBACKS = ['opus'] as const;

/** The model-id rules make a fallback's harness unambiguous. */
function fallbackRunner(model: string): Runner {
  if (model in ALIASES || model.startsWith('claude-')) return 'claude';
  return model.includes('/') ? 'opencode' : 'codex';
}

/** Every advertised runner has a stage-specific dispatch and permission boundary. */
const RUNNERS_FOR: Record<Stage, readonly Runner[]> = {
  orchestrator: ['claude', 'codex'],
  executor: ['opencode', 'claude', 'codex'],
  mapper: RUNNERS,
  'review.standards': RUNNERS,
  'review.spec': RUNNERS,
  'review.correctness': RUNNERS,
  // `claude` only: the code-context session runs under the clerk's rails
  // (`clerk/orchestrator-settings.json`), and only a `claude -p` session can be
  // handed a settings file. A codex one would read the application code with
  // approvals bypassed and nothing fencing its network.
  'code-context': ['claude'],
};

/**
 * Stages the orchestrator runs through the `Agent` tool — but only while their
 * runner is `claude`, and then as the NAMED agent below rather than an ad-hoc
 * call. The ad-hoc call's `model` is an alias enum and it has no effort at all;
 * a named agent's definition carries a full id and an effort, and its effort
 * overrides the session's. On any other runner these stages are a process
 * `inspect.sh` starts, and take that harness's own model ids.
 */
const AGENT_TOOL_STAGES = new Set<Stage>(['mapper', 'review.standards', 'review.spec', 'review.correctness']);
const isAgentToolCall = (stage: Stage, runner: Runner): boolean =>
  runner === 'claude' && AGENT_TOOL_STAGES.has(stage);

/** `review.standards` → `ralph-review-standards`: the `subagent_type` the prompt names. */
const AGENT_NAMES: Partial<Record<Stage, string>> = Object.fromEntries(
  [...AGENT_TOOL_STAGES].map((stage) => [stage, `ralph-${stage.replace(/\./g, '-')}`]),
);

/**
 * A full Claude id, as a named agent's definition and `claude --model` take it.
 * Published in `--schema` so a form checks the same prefix.
 */
const CLAUDE_ID_PREFIX = 'claude-';
const isClaudeId = (model: string): boolean => model.startsWith(CLAUDE_ID_PREFIX) && !model.includes('/');

/**
 * Which runners pass an `effort` on to each stage. Refused elsewhere: opencode
 * has no effort knob, and `delegate.sh` hands a `claude -p` executor none, so
 * an effort there would be a setting that silently does nothing.
 */
const EFFORT_RUNNERS_FOR: Record<Stage, readonly Runner[]> = {
  orchestrator: ['claude', 'codex'],
  executor: ['codex'],
  mapper: ['claude', 'codex'],
  'review.standards': ['claude', 'codex'],
  'review.spec': ['claude', 'codex'],
  'review.correctness': ['claude', 'codex'],
  'code-context': ['claude'],
};
const takesEffort = (stage: Stage, runner: Runner): boolean => EFFORT_RUNNERS_FOR[stage].includes(runner);

/**
 * Stages a block may leave out, and what they run when it does.
 *
 * Every other stage has to be named, because a block is a complete lineup.
 * `code-context` (felipearos/ralph#499) is the exception on purpose: it was
 * added after every `@clerk` block was written, and a clerk whose lineup
 * predates it must keep starting rather than be refused for a stage it has
 * never been asked about. Opus at high effort, because the session is a one-shot
 * read of an unfamiliar codebase whose comment a person acts on, and one per
 * filed ticket is few enough that the cheaper model saves little.
 *
 * `review.correctness` is the second, for the same reason: the third review
 * axis came after every coder, ci-doctor and pr-medic block, including the
 * hand-edited ones on a live host, and a deploy must not refuse them all.
 * Opus at high effort because it is the one pre-PR stage that hunts bugs: the
 * Codex PR reviewer that used to catch them after the push is gone, and a
 * reviewer weaker than the diff finds nothing the author did not.
 *
 * A block that DOES name the stage replaces this wholly, like any other.
 */
const BUILT_IN_STAGES: Partial<Record<Stage, { model: string; runner: Runner; effort?: string }>> = {
  'review.correctness': { runner: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  'code-context': { runner: 'claude', model: 'claude-opus-5-5', effort: 'high' },
};

/**
 * What a model id may contain.
 *
 * The value travels into three syntaxes this file does not control — an `eval`
 * of generated shell, a `{{…}}` substitution into the prompt, and opencode's
 * `{env:…}` — so it is fenced at the source rather than escaped three times.
 * Everything real is in here: `claude-opus-5`, `opencode-go/deepseek-v4-flash`,
 * `claude-opus-5[1m]`, a dated `claude-sonnet-5-20260514`.
 */
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]+$/;

/**
 * How each runner spells a model id's provider.
 *
 * `opencode` addresses a model as `provider/model`; `codex` takes a bare id
 * with no provider at all; `claude --model` accepts either form. Data rather
 * than a pair of `if` branches so the machine-readable schema can project the
 * same rule the validator enforces, instead of a form restating it.
 */
const PROVIDER_PREFIX: Record<Runner, 'required' | 'forbidden' | 'optional'> = {
  claude: 'optional',
  opencode: 'required',
  codex: 'forbidden',
};

/**
 * Why this value cannot be that stage's model, or null when it can.
 *
 * One function rather than a check beside each caller: the config path and the
 * environment path enforce the SAME two rules, and a second copy of them drifts
 * — which is the whole reason this file exists in the first place.
 */
function whyNotAModelFor(
  stage: Stage,
  model: string,
  runner: Runner,
  route: 'primary' | 'fallback' = 'primary',
): string | null {
  if (!MODEL_ID.test(model)) {
    return `has characters a model id cannot: ${JSON.stringify(model)}.`;
  }
  // A Claude fallback is an ad-hoc Agent call, whose model is the alias enum.
  // It stays one rather than becoming a second named agent per chain entry: it
  // is the last resort when every external route failed, and an alias is
  // enough to keep the review from being skipped.
  if (isAgentToolCall(stage, runner) && route === 'fallback' && !(model in ALIASES)) {
    return (
      `is '${model}', but a Claude fallback is an Agent call, whose model is one of: ` +
      `${Object.keys(ALIASES).join(', ')}. A full id is refused there — name it as the stage's own model instead.`
    );
  }
  if (isAgentToolCall(stage, runner) && !(model in ALIASES) && !isClaudeId(model)) {
    return (
      `is '${model}', but on the 'claude' runner that stage is a named Claude agent, whose model is one of: ` +
      `${Object.keys(ALIASES).join(', ')}, or a full 'claude-…' id.`
    );
  }
  if (stage === 'executor' && runner === 'claude' && model in ALIASES) {
    // The executor on `claude` is a `claude -p` process, not an Agent call.
    // The CLI would accept the alias — the orchestrator takes one, by design —
    // but the usage ledger books what this process spent under the id it was
    // given, and `usage.py` knows no context window for 'sonnet', so the
    // lineup names the executor's model the way the ledger will.
    return (
      `is '${model}', an Agent-tool alias, but the executor on the 'claude' runner is a ` +
      `\`claude -p\` process the usage ledger attributes by full id. Name it: ` +
      `${ALIASES[model]}.`
    );
  }
  if (runner !== 'claude' && model in ALIASES) {
    // The aliases are the Agent tool's enum, not model ids. `opus` reaches
    // opencode as a model no provider has, and the run dies at the harness.
    return (
      `is '${model}', which is one of the Agent tool's aliases — it means nothing to the ` +
      `'${runner}' runner. Name a model that runner has.`
    );
  }
  if (PROVIDER_PREFIX[runner] === 'required' && !model.includes('/')) {
    return `is '${model}', but ${runner} names a model 'provider/model'. Run \`opencode models\` for the list.`;
  }
  if (PROVIDER_PREFIX[runner] === 'forbidden' && model.includes('/')) {
    return `is '${model}', but ${runner} names a model without a provider prefix.`;
  }
  return null;
}

/** Why this harness cannot run that stage, or null when it can. */
function whyNotARunnerFor(stage: Stage, runner: string): string | null {
  if (!(RUNNERS as readonly string[]).includes(runner)) {
    return `is '${runner}', which is not a harness this loop knows: ${RUNNERS.join(', ')}.`;
  }
  if (!RUNNERS_FOR[stage].includes(runner as Runner)) {
    return (
      `is '${runner}', which cannot run '${stage}'. That stage runs on: ` +
      `${RUNNERS_FOR[stage].join(', ')}.`
    );
  }
  return null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Pull one stage out of a block, collecting every problem rather than throwing
 * on the first: an operator editing this file wants the whole list, not one
 * round trip per typo.
 */
function readStage(
  block: Record<string, unknown>,
  stage: Stage,
  where: string,
  problems: string[],
  stages: readonly Stage[],
): { model: string; runner: Runner; effort?: string; fallback?: string[]; fallbackEfforts?: Record<string, string> } | null {
  const [head, tail] = stage.split('.');
  let node: unknown = block[head!];
  if (tail) {
    if (!isPlainObject(node)) {
      // Phrased like every other missing stage — an operator scanning the list
      // should not have to notice that one of them is nested.
      problems.push(`${where} is missing '${stage}' (there is no '${head}' section).`);
      return null;
    }
    node = node[tail];
  }
  // Absent, not malformed: a stage with a built-in default runs that, and the
  // caller tells the two apart by whether a problem was recorded.
  if (node === undefined && BUILT_IN_STAGES[stage] !== undefined) return null;
  if (!isPlainObject(node)) {
    problems.push(`${where} is missing '${stage}'. A block is a complete lineup — name all ${stages.length} stages.`);
    return null;
  }
  // The runner is read first because it decides what a legal model even is:
  // the same string is a fine opencode id and a refused Agent-tool one.
  const runner = node.runner;
  if (typeof runner !== 'string' || runner.trim() === '') {
    problems.push(
      `${where} '${stage}.runner' must be a non-empty string — the harness that runs it: ` +
        `${RUNNERS_FOR[stage].join(', ')}.`,
    );
    return null;
  }
  const badRunner = whyNotARunnerFor(stage, runner.trim());
  if (badRunner) {
    problems.push(`${where} '${stage}.runner' ${badRunner}`);
    return null;
  }
  const model = node.model;
  if (typeof model !== 'string' || model.trim() === '') {
    problems.push(`${where} '${stage}.model' must be a non-empty string.`);
    return null;
  }
  const wrong = whyNotAModelFor(stage, model.trim(), runner.trim() as Runner);
  if (wrong) {
    problems.push(`${where} '${stage}.model' ${wrong}`);
    return null;
  }
  const effort = node.effort;
  if (effort !== undefined) {
    if (!takesEffort(stage, runner.trim() as Runner)) {
      problems.push(
        `${where} sets 'effort' on '${stage}', but nothing passes an effort to it on '${runner.trim()}'. ` +
          `That stage takes one on: ${EFFORT_RUNNERS_FOR[stage].join(', ')}.`,
      );
    } else if (typeof effort !== 'string' || effort.trim() === '') {
      problems.push(`${where} '${stage}.effort' must be a non-empty string.`);
    }
  }
  // Refused where it would do nothing, on the same grounds as `effort`: a
  // setting that is silently ignored is worse than one that is rejected. A
  // `claude`-runner stage already runs in-session, while the orchestrator and
  // executor have no read-only inspection route to retry.
  const fallback = node.fallback;
  let fallbacks: string[] | undefined;
  if (fallback !== undefined) {
    if (!AGENT_TOOL_STAGES.has(stage)) {
      problems.push(
        `${where} sets 'fallback' on '${stage}'. Ordered fallback routes belong only to ` +
          `${[...AGENT_TOOL_STAGES].join(', ')}.`,
      );
    } else if (runner.trim() === 'claude') {
      // Still true with named agents: the stage runs in-session, so there is
      // no harness that can be missing and no process exit to fall back on.
      problems.push(
        `${where} sets 'fallback' on '${stage}', whose runner is already 'claude'. ` +
          `That stage IS the in-session Agent call — there is nothing to fall back from.`,
      );
    } else {
      // A scalar remains accepted so existing checkouts keep loading. New
      // edits write the ordered array form.
      const raw = typeof fallback === 'string' ? [fallback] : fallback;
      if (!Array.isArray(raw) || raw.length === 0 || raw.some((value) => typeof value !== 'string' || value.trim() === '')) {
        problems.push(`${where} '${stage}.fallback' must be a non-empty model id or an ordered, non-empty array of model ids.`);
      } else {
        fallbacks = raw.map((value) => (value as string).trim());
        const seen = new Set<string>();
        for (const candidate of fallbacks) {
          if (seen.has(candidate)) {
            problems.push(`${where} '${stage}.fallback' repeats '${candidate}'. Each fallback route must be unique.`);
            continue;
          }
          seen.add(candidate);
          const fallbackRoute = fallbackRunner(candidate);
          const wrongFallback = whyNotAModelFor(stage, candidate, fallbackRoute, 'fallback');
          if (wrongFallback) problems.push(`${where} '${stage}.fallback' entry '${candidate}' ${wrongFallback}`);
          if (candidate === model.trim() && fallbackRoute === runner.trim()) {
            problems.push(`${where} '${stage}.fallback' repeats its primary route '${candidate}' on '${fallbackRoute}'.`);
          }
        }
      }
    }
  }
  let fallbackEfforts: Record<string, string> | undefined;
  if (node.fallbackEfforts !== undefined) {
    if (!isPlainObject(node.fallbackEfforts)) {
      problems.push(`${where} '${stage}.fallbackEfforts' must map Codex fallback model ids to non-empty efforts.`);
    } else {
      fallbackEfforts = {};
      for (const [id, value] of Object.entries(node.fallbackEfforts)) {
        if (!fallbacks?.includes(id) || fallbackRunner(id) !== 'codex') {
          problems.push(`${where} '${stage}.fallbackEfforts' names '${id}', which is not a configured Codex fallback.`);
        } else if (typeof value !== 'string' || !/^[a-z]+$/.test(value.trim())) {
          problems.push(`${where} '${stage}.fallbackEfforts' for '${id}' must be a non-empty effort name.`);
        } else {
          fallbackEfforts[id] = value.trim();
        }
      }
    }
  }
  return {
    model: model.trim(),
    runner: runner.trim() as Runner,
    effort: typeof effort === 'string' ? effort.trim() : undefined,
    fallback: fallbacks,
    fallbackEfforts,
  };
}

type Configured = { model: string; runner: Runner; effort?: string; fallback?: string[]; fallbackEfforts?: Record<string, string> };

/**
 * Whether a block names a stage at all, dotted stages included.
 *
 * Presence, not shape: `executor: "opencode-go/x"` — the likeliest way an extra
 * stage is written by hand — is a stage this block names, and a check that
 * looked for a well-formed object would let exactly the malformed ones through
 * silently. Whether the node is usable is `readStage`'s question, and it is
 * only asked of stages the role actually runs.
 */
function namesStage(block: Record<string, unknown>, stage: Stage): boolean {
  const [head, tail] = stage.split('.');
  if (!tail) return head! in block;
  const node = block[head!];
  return isPlainObject(node) && tail in node;
}

/**
 * Read one block as the lineup of a loop in `role`: every stage the role has,
 * and — when the block belongs to that role alone — none it does not.
 *
 * A stage outside the role's set is refused rather than ignored, on the same
 * grounds as a loop block outside a project (`isBareLoopBlock` below): it is a
 * model the operator believes is in use — chosen, kept current and paid for —
 * and nothing would ever resolve it. The refusal names the role's stages,
 * because the alternative is an operator deleting whichever key looked wrong.
 *
 * `shared` turns that half off, and a `default` block is what it is for: every
 * role falls back to it, so it names every stage on purpose and a triager
 * reading it takes the three it runs and leaves the rest. Only a block written
 * FOR one role — a loop's own, or a `@role` default — can have a stage in it
 * that is nobody's.
 */
function readBlock(
  block: Record<string, unknown>,
  where: string,
  role: Role,
  problems: string[],
  shared = false,
): Map<Stage, Configured | null> {
  const stages = stagesFor(role);
  const read = new Map<Stage, Configured | null>();
  for (const stage of stages) {
    read.set(stage, readStage(block, stage, where, problems, stages));
  }
  if (shared) return read;
  for (const stage of STAGES) {
    if (stages.includes(stage) || !namesStage(block, stage)) continue;
    problems.push(
      `${where} names '${stage}', which a ${role} loop does not run. Its stages are: ${stages.join(', ')}.`,
    );
  }
  return read;
}

/**
 * The role a key inside a project block declares, the reason it is not one, or
 * null when the key is an ordinary loop name.
 *
 * `@triager` is the project's default lineup for every triager it runs, so a
 * second loop of that role needs no block of its own. The `@` is what keeps
 * such a key from colliding with a loop actually named `triager`.
 */
function roleKey(key: string): { role: Role } | { problem: string } | null {
  if (!key.startsWith('@')) return null;
  const named = key.slice(1);
  if (isRole(named)) return { role: named };
  // The sentence after the block's name, so the caller places it: every other
  // refusal in this file opens with the key it is about.
  return { problem: `names no role. A role default is one of: ${ROLES.map((role) => `@${role}`).join(', ')}.` };
}

/**
 * Parse a config document that has already been read, with `label` naming it
 * in every refusal. Shared by the file path and the candidate text a caller
 * hands to `--validate` through stdin, so a malformed document is refused the
 * same way whichever door it came through.
 */
function parseConfigObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ModelConfigError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ModelConfigError(`${label} must be a JSON object keyed by project id, with a 'default' block.`);
  }
  return parsed;
}

/** The top-level keys a lineup block has; a project block has loop names instead. */
const STAGE_HEADS = [...new Set(STAGES.map((stage) => stage.split('.')[0]!))];

/**
 * A lineup block sitting at the top level, where only project blocks go now.
 * Told apart by its keys: a lineup names stages, a project names loops.
 */
const isBareLoopBlock = (value: unknown): boolean =>
  isPlainObject(value) && STAGE_HEADS.some((head) => head in value);

/** The top-level keys that are neither commentary nor `default`. */
const namedKeys = (config: Record<string, unknown>): string[] =>
  Object.keys(config).filter((key) => !key.startsWith('$') && key !== 'default');

/**
 * The file with its bare top-level loop blocks moved under `loggd`, or null
 * when there is nothing to move.
 *
 * Only a file wholly in the old shape is migrated — bare loop blocks and no
 * `loggd` block yet. Once `loggd` exists the migration has run, and a bare
 * block beside it is refused by the validator rather than silently moved.
 * Every other key keeps its place; the moved blocks keep their order and
 * their values exactly, sitting where the first of them was.
 */
export function migrateConfig(config: Record<string, unknown>): Record<string, unknown> | null {
  const bare = namedKeys(config).filter((key) => isBareLoopBlock(config[key]));
  if (bare.length === 0 || LEGACY_PROJECT in config) return null;
  const moved: Record<string, unknown> = {};
  for (const key of bare) moved[key] = config[key];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === bare[0]) out[LEGACY_PROJECT] = moved;
    else if (!bare.includes(key)) out[key] = value;
  }
  return out;
}

/** Write through a temp file and a rename, so a reader never sees half a file. */
export function writeConfigFile(path: string, config: Record<string, unknown>): void {
  const temp = `${path}.${process.pid}.write.tmp`;
  const fd = openSync(temp, 'w', 0o644);
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    // Flushed before the rename, like the lineup editor's writer: the loops
    // refuse to start without this file.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * Read a `models.json`. A file still in the pre-project shape is migrated in
 * place first (`migrateConfig`) unless `migrate` is false — a candidate being
 * validated is judged as written, never rewritten.
 */
export function loadConfig(path = join(RALPH_DIR, 'models.json'), migrate = true): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ModelConfigError(
      `cannot read ${path}.\n` +
        `       It is the model lineup for every stage; the loop will not guess one.\n` +
        `       Restore it from git: git -C ${dirname(path)} checkout -- models.json`,
    );
  }
  const config = parseConfigObject(raw, path);
  if (!migrate) return config;
  const migrated = migrateConfig(config);
  if (migrated === null) return config;
  writeConfigFile(path, migrated);
  return migrated;
}

/**
 * Each project's loops by role, as a caller that can read the roster supplies
 * them: `{ loggd: { tria: 'triager' } }`.
 *
 * The validator judges a whole document, including projects whose checkout is
 * not on this host, so the roster cannot be read here. A loop this map does not
 * name is judged as a coder — which is exactly how every block was judged
 * before roles existed, and is why the `@role` keys exist: those say their role
 * in the document itself.
 */
export type RolesByProject = Readonly<Record<string, Readonly<Record<string, Role>>>>;

/**
 * The complete collected problem list for a candidate config, or `[]` when it
 * is valid.
 *
 * Every block is read — the `default` block once and each named loop in turn —
 * rather than only the loop this process would resolve. The editor saves the
 * whole document, so a block it did not resolve must not be allowed to reach
 * disk broken and only fail at the next loop start.
 *
 * The rules are not restated here: `readStage` is the same function the
 * resolver reads through, so a candidate the validator accepts is one the
 * resolver would accept.
 */
export function collectProblems(config: unknown, roles?: RolesByProject): string[] {
  if (!isPlainObject(config)) {
    return [`models.json must be a JSON object keyed by project id, with a 'default' block.`];
  }
  const problems: string[] = [];
  const defaultBlock = config.default;
  if (!isPlainObject(defaultBlock)) {
    // Collected, not returned: a malformed `default` says nothing about the
    // named blocks, and the caller asked for every problem in one pass.
    problems.push(`models.json has no 'default' block. Every loop falls back to it.`);
  } else {
    // The `default` blocks — the file's and a project's — are judged as the
    // coder's full lineup whatever roles the project runs, because every role
    // falls back to them: a `default` narrowed to a triager's three stages
    // would leave a coder with no executor and no standards review.
    readBlock(defaultBlock, "models.json 'default'", DEFAULT_ROLE, problems);
  }
  // `$`-prefixed keys are commentary (`$comment`, `$comment_loops`) and
  // `default` was read above; everything else is a project.
  for (const project of namedKeys(config)) {
    const block = config[project];
    if (isBareLoopBlock(block)) {
      problems.push(
        `models.json '${project}' is a loop block outside any project. Loop blocks nest under ` +
          `their project's id: { "${LEGACY_PROJECT}": { "${project}": {…} } }.`,
      );
      continue;
    }
    if (!PROJECT_ID.test(project)) {
      problems.push(`models.json '${project}' is not a project id (lowercase, a-z0-9 . _ -).`);
      continue;
    }
    if (!isPlainObject(block)) {
      problems.push(`models.json '${project}' must be an object of loop blocks.`);
      continue;
    }
    for (const loop of Object.keys(block)) {
      if (loop.startsWith('$')) continue;
      const keyed = roleKey(loop);
      if (keyed !== null && 'problem' in keyed) {
        problems.push(`models.json '${project}.${loop}' ${keyed.problem}`);
        continue;
      }
      const loopBlock = block[loop];
      if (!isPlainObject(loopBlock)) {
        problems.push(`models.json '${project}.${loop}' must be an object holding a complete lineup.`);
        continue;
      }
      // A `@role` key says its own role. A loop key's role is the roster's, and
      // the roster is the caller's to supply: this function is handed a config
      // document and nothing else, and a project whose checkout is not on this
      // host has no roster to read. Unknown means coder, which is what keeps a
      // file written before roles existed judged exactly as it was.
      const role = keyed !== null && 'role' in keyed
        ? keyed.role
        : (loop === 'default' ? DEFAULT_ROLE : roles?.[project]?.[loop] ?? DEFAULT_ROLE);
      readBlock(loopBlock, `models.json '${project}.${loop}'`, role, problems);
    }
  }
  return problems;
}

export interface ValidationResult {
  valid: boolean;
  problems: string[];
}

/** The verdict `--validate` prints, as a value rather than an exit code. */
export function validateConfig(config: unknown, roles?: RolesByProject): ValidationResult {
  const problems = collectProblems(config, roles);
  return { valid: problems.length === 0, problems };
}

/**
 * The resolved lineup as the stable JSON shape a process-boundary consumer
 * reads (`--json`), rather than the human text `--list` prints.
 *
 * A flat map keyed by the dotted stage names keeps this projectable straight
 * from `Lineup`; a field is present only when the stage has it, so a consumer
 * tells "no effort" from "effort: ''" without a second lookup.
 */
export function lineupJson(
  lineup: Lineup,
  loopName: string,
  project?: string,
  role: Role = DEFAULT_ROLE,
): Record<string, unknown> {
  const stages: Record<string, unknown> = {};
  // Only the stages the lineup holds, which are the role's: a consumer reads
  // the set it must render from the answer rather than from a list of every
  // stage with holes in it.
  for (const stage of lineupStages(lineup)) {
    const { model, runner, effort, fallback, fallbackEfforts, source } = lineup[stage]!;
    stages[stage] = {
      model,
      runner,
      ...(effort !== undefined ? { effort } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
      ...(fallbackEfforts !== undefined ? { fallbackEfforts } : {}),
      source,
    };
  }
  // The role is reported, not merely used: a consumer handed three stages has
  // to be able to tell "a triager's lineup" from "a coder's with two missing",
  // and the lineup editor asks `--schema --role` with this answer.
  return { ...(project === undefined ? {} : { project }), loop: loopName, role, stages };
}

/**
 * The resolver's rules as JSON (`--schema`), so a form constrains its choices
 * from the same data the validator enforces instead of importing this module
 * or hardcoding a capability map, an alias list, or a model-id shape.
 */
export function schemaJson(role: Role = DEFAULT_ROLE): Record<string, unknown> {
  // The role's stages, not every stage: the lineup editor builds a new block
  // from this list, so a form shown all five would write a triager a block the
  // validator then refuses — and offer the operator a model to pick for a stage
  // that will never run.
  const stages = stagesFor(role);
  return {
    role,
    stages: [...stages],
    runners: [...RUNNERS],
    runnersFor: Object.fromEntries(stages.map((stage) => [stage, [...RUNNERS_FOR[stage]]])),
    effortRunnersFor: Object.fromEntries(stages.map((stage) => [stage, [...EFFORT_RUNNERS_FOR[stage]]])),
    agentToolStages: [...AGENT_TOOL_STAGES].filter((stage) => stages.includes(stage)),
    /**
     * The named agent each Agent-tool stage runs as on `claude`. Its presence
     * tells a form that those stages take a full `claude-…` id, not only an alias.
     */
    agentNames: { ...AGENT_NAMES },
    /** The prefix a full id carries where a named agent takes one (no provider '/'). */
    claudeIdPrefix: CLAUDE_ID_PREFIX,
    aliases: Object.keys(ALIASES),
    /** What each Agent-tool alias stands for today, so a form can say so. */
    aliasTargets: { ...ALIASES },
    defaultFallback: DEFAULT_FALLBACKS[0],
    defaultFallbacks: [...DEFAULT_FALLBACKS],
    modelId: {
      pattern: MODEL_ID.source,
      providerPrefix: { ...PROVIDER_PREFIX },
    },
  };
}

/**
 * The lineup for one loop.
 *
 * `env` is passed in rather than read from `process.env` so the tests drive it
 * the way the supervisor does — through the environment — instead of through a
 * seam only the tests use.
 */
export function resolveLineup(options: {
  config: Record<string, unknown>;
  env?: Env;
  loopName?: string;
  /** The project whose blocks apply; defaults to `RALPH_PROJECT_ID`, and none means `default` only. */
  project?: string;
  /**
   * The loop's role, which decides both which stages are resolved at all and
   * which `@role` block it falls back to. The roster's, never the caller's
   * guess: `ralph.sh` reads it with `project-config.ts --role-of`.
   */
  role?: Role;
}): Lineup {
  const env = options.env ?? process.env;
  const loopName = options.loopName ?? env.RALPH_LOOP_NAME ?? 'ralph';
  const project = options.project ?? (env.RALPH_PROJECT_ID?.trim() || undefined);
  const role = options.role ?? DEFAULT_ROLE;
  const stages = stagesFor(role);
  const problems: string[] = [];

  const defaultBlock = options.config.default;
  if (!isPlainObject(defaultBlock)) {
    throw new ModelConfigError(`models.json has no 'default' block. Every loop falls back to it.`);
  }
  // A bare loop block is refused even when this loop would not read it: it is
  // a lineup the operator believes applies somewhere, and it applies nowhere.
  const bare = namedKeys(options.config).filter((key) => isBareLoopBlock(options.config[key]));
  if (bare.length > 0) {
    throw new ModelConfigError(
      `models.json has loop blocks outside any project: ${bare.join(', ')}. ` +
        `Loop blocks nest under their project's id, e.g. { "${LEGACY_PROJECT}": { "${bare[0]}": {…} } }.`,
    );
  }
  // `$`-prefixed keys are commentary (`$comment`, `$schema`): JSON cannot hold
  // a comment and this repo explains its decisions where they live.
  const projectBlock = project === undefined || project.startsWith('$') ? undefined : options.config[project];
  if (projectBlock !== undefined && !isPlainObject(projectBlock)) {
    throw new ModelConfigError(`models.json '${project}' must be an object of loop blocks.`);
  }
  const pick = (key: string): { block: Record<string, unknown>; where: string } | undefined => {
    if (projectBlock === undefined || key.startsWith('$')) return undefined;
    const block = projectBlock[key];
    if (block === undefined) return undefined;
    if (!isPlainObject(block)) {
      throw new ModelConfigError(`models.json '${project}.${key}' must be an object holding a complete lineup.`);
    }
    return { block, where: `models.json '${project}.${key}'` };
  };
  // A `@role` key that names no role is refused even when this loop would not
  // read it, for the same reason a bare loop block is: it is a default the
  // operator believes applies to a role, and it applies to nothing.
  if (projectBlock !== undefined) {
    for (const key of Object.keys(projectBlock)) {
      const keyed = roleKey(key);
      if (keyed !== null && 'problem' in keyed) {
        throw new ModelConfigError(`models.json '${project}.${key}' ${keyed.problem}`);
      }
    }
  }
  // The order a lineup resolves in: this loop's own block, then its project's
  // default for the loop's ROLE, then the project's `default`, then the file's.
  // The role step is what lets a project run a second triager without an edit
  // here — and it sits below the loop's own block, so a loop that names one
  // stage differently still overrides its role's default wholly, the way it
  // always overrode `default` wholly.
  const own = pick(loopName);
  const roleDefault = own === undefined ? pick(`@${role}`) : undefined;
  const projectDefault = own === undefined && roleDefault === undefined ? pick('default') : undefined;
  const named = own ?? roleDefault ?? projectDefault;
  const namedSource: ResolvedStage['source'] =
    own !== undefined ? 'loop' : roleDefault !== undefined ? 'role' : 'project';

  const fromDefault = new Map<Stage, Configured | null>();
  const fromNamed = new Map<Stage, Configured | null>();
  for (const stage of stages) {
    // Only the role's stages, and only from the role's own point of view: the
    // file's `default` is a coder's complete lineup, and a triager reading it
    // takes the three stages it runs out of it and leaves the rest.
    fromDefault.set(stage, readStage(defaultBlock, stage, "models.json 'default'", problems, stages));
  }
  if (named) {
    // The project's `default` is shared by every role; a loop's own block and a
    // `@role` default are this role's alone, so a stage in them that the role
    // does not run is refused.
    const shared = named === projectDefault;
    for (const [stage, configured] of readBlock(named.block, named.where, role, problems, shared)) {
      fromNamed.set(stage, configured);
    }
  }
  if (problems.length > 0) {
    throw new ModelConfigError(problems.join('\n       '));
  }

  const lineup = {} as Lineup;
  for (const stage of stages) {
    // Null only for a stage the block left out that has a built-in default:
    // every other null recorded a problem, and those were thrown above.
    const fromBlock = named ? fromNamed.get(stage) : fromDefault.get(stage);
    const builtIn = fromBlock === null || fromBlock === undefined;
    const configured: Configured = builtIn ? { ...BUILT_IN_STAGES[stage]! } : fromBlock;
    // `RALPH_CODER_MODEL` is what the executor knob was called before this file
    // existed; README documented it and a loop may still be running with it
    // exported. Kept as the lower-priority alias so an old start line keeps
    // meaning what it meant.
    const overrides = stage === 'executor'
      ? [env[envNameFor(stage)], env.RALPH_CODER_MODEL]
      : [env[envNameFor(stage)]];
    const override = overrides.find((value) => value !== undefined && value.trim() !== '');

    // The runner resolves BEFORE the model, for the same reason the block reads
    // it first: it decides which model ids are legal. A one-off that moves a
    // stage to another harness therefore has to move its model too, and the
    // refusal says so rather than letting an alias reach opencode.
    const runnerOverrideRaw = env[runnerEnvNameFor(stage)];
    const runnerOverride =
      runnerOverrideRaw !== undefined && runnerOverrideRaw.trim() !== ''
        ? runnerOverrideRaw.trim()
        : undefined;
    if (runnerOverride !== undefined) {
      const bad = whyNotARunnerFor(stage, runnerOverride);
      if (bad) throw new ModelConfigError(`${runnerEnvNameFor(stage)} ${bad}`);
    }
    const runner = (runnerOverride ?? configured.runner) as Runner;

    if (override !== undefined) {
      const wrong = whyNotAModelFor(stage, override.trim(), runner);
      if (wrong) throw new ModelConfigError(`${envNameFor(stage)} ${wrong}`);
    } else if (runnerOverride !== undefined) {
      // The block's model was legal for the block's runner; it need not be
      // legal for this one. Checked here rather than left to the harness,
      // because the harness reports it as an unknown model hours later.
      const wrong = whyNotAModelFor(stage, configured.model, runner);
      if (wrong) {
        throw new ModelConfigError(
          `${runnerEnvNameFor(stage)}='${runner}' leaves '${stage}' on a model it cannot run: ` +
            `'${stage}.model' ${wrong}\n       Set ${envNameFor(stage)} too.`,
        );
      }
    }
    // Unlike a model, an effort has a meaningful empty value: "run this model
    // with no --effort at all". Set-but-empty therefore CLEARS rather than
    // falling back, because otherwise a one-off model override cannot reach a
    // model that takes no effort — `RALPH_MODEL_ORCHESTRATOR=claude-haiku-4-5`
    // would inherit the block's `medium` and Haiku 4.5 errors on being handed
    // one (docs/research/agent-orchestration/model-selection.md). An unset
    // variable still means "the operator said nothing", so the block stands.
    const effortOverride = env[`${envNameFor(stage)}_EFFORT`];

    lineup[stage] = {
      model: (override ?? configured.model).trim(),
      runner,
      effort: takesEffort(stage, runner)
        ? (effortOverride !== undefined ? (effortOverride.trim() || undefined) : configured.effort)
        : undefined,
      // Filled in for every stage that can degrade, whether or not the block
      // named one — including a stage moved onto another harness by a
      // `RALPH_RUNNER_<STAGE>` one-off, which is the case with no config line
      // to carry a fallback at all. The block's own `fallback` is refused on a
      // `claude` runner, so an override that moves a stage BACK to `claude`
      // drops it rather than rendering a setting that means nothing there.
      fallbackEfforts: runner !== 'claude' ? configured.fallbackEfforts : undefined,
      fallback:
        AGENT_TOOL_STAGES.has(stage) && runner !== 'claude'
          ? (configured.fallback ?? [...DEFAULT_FALLBACKS])
          : undefined,
      source:
        override !== undefined || runnerOverride !== undefined
          ? 'env'
          : named && !builtIn
            ? namedSource
            : 'default',
    };
  }
  return lineup;
}

/**
 * The prompt, with `{{RALPH_MODEL_…}}` replaced by this run's lineup.
 *
 * Here rather than in a `sed` in `ralph.sh`, which is where it started: a
 * model id is substituted into a `s|…|…|` expression, so `|`, `&` and `\` in a
 * value are sed syntax rather than text, and the exit status of a command
 * substitution under `set -uo pipefail` is not checked — a sed that aborted
 * left an EMPTY prompt that the placeholder guard then happily passed. The
 * charset fence above closes the first hole; doing the substitution here
 * closes the second and drops the hand-maintained list of placeholders that
 * had to be kept level with `STAGES`.
 */
/**
 * How the iteration is to invoke one read-only stage, as a sentence.
 *
 * Rendered rather than described, because the alternative is a conditional in
 * the prompt — "if the runner is claude, an Agent call, otherwise a script" —
 * and a 34K prompt full of branches the run has already decided is how a stage
 * ends up invoked the way the model guessed rather than the way the lineup
 * says.
 */
function howToInvoke(stage: Stage, resolved: ResolvedStage, orchestrator: Runner): string {
  if (resolved.runner === 'claude' && orchestrator === 'claude') {
    // "No `model`" is said outright: an Agent call's own `model` argument
    // overrides the definition's, and would put the stage back on an alias.
    const name = AGENT_NAMES[stage]!;
    const effort = resolved.effort ? ` at effort ${resolved.effort}` : '';
    return (
      `the \`${name}\` agent: an \`Agent\` call with \`subagent_type: "${name}"\` and no \`model\` ` +
      `(it runs ${resolved.model}${effort})`
    );
  }
  // No sentence-ending punctuation in either branch: this renders mid-sentence
  // in `prompt.md`, and a full stop here reads as one there.
  //
  // The complete chain is rendered into the sentence. External routes need
  // explicit runner/model overrides, while an Agent fallback needs an alias;
  // leaving either implicit would make the orchestrator choose mid-iteration.
  const fallbacks = resolved.runner === 'claude' ? [] : resolved.fallback ?? [...DEFAULT_FALLBACKS];
  const routes = [
    `\`"$RALPH_HOME/inspect.sh" ${stage} <brief-file>\` (${resolved.model} on ${resolved.runner})`,
    ...fallbacks.map((model) => {
      const runner = fallbackRunner(model);
      if (runner === 'claude' && orchestrator === 'claude') return `an \`Agent\` call with \`model: "${model}"\``;
      // Set on every route that reads an effort, so the primary's exported one
      // is not inherited: a Codex `xhigh` means nothing to a Claude fallback.
      const effortOverride = takesEffort(stage, runner)
        ? `RALPH_MODEL_${varTail(stage)}_EFFORT=${shellQuote(runner === 'codex' ? resolved.fallbackEfforts?.[model] ?? '' : '')} `
        : '';
      return (
        `\`RALPH_RUNNER_${varTail(stage)}=${runner} RALPH_MODEL_${varTail(stage)}=${model} ` +
        effortOverride + `"$RALPH_HOME/inspect.sh" ${stage} <brief-file>\` (${model} on ${runner})`
      );
    }),
  ];
  return (
    `these routes in order: ${routes.map((route, index) => `${index + 1}. ${route}`).join('; ')}. ` +
    `Move to the next route when an inspect process exits 2 (unavailable) or 4 (failed); ` +
    (orchestrator === 'claude' ? `an \`Agent\` call is already in-session` : `if every route fails, report the stage blocked; do not skip it`)
  );
}

/**
 * The project half of a render: its fragments (by kind) and the config values
 * the generic text may name. Absent when the caller renders no project text —
 * any `{{PROJECT_…}}` or project value placeholder is then refused.
 */
export interface ProjectRender {
  /** Fragment file contents, keyed by kind: `PROMPT`, `CODER`. */
  fragments: Partial<Record<FragmentKind, string>>;
  /** Extra `{{RALPH_…}}` values, e.g. `RALPH_PROJECT_OWNER`. */
  values: Record<string, string>;
}

export const FRAGMENT_KINDS = ['PROMPT', 'CODER'] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

const SECTION_MARKER = /^<!--\s*ralph:section\s+([A-Z0-9_]+)\s*-->\s*$/;

/**
 * A fragment file split into named sections.
 *
 * Text before the first `<!-- ralph:section NAME -->` marker is the default
 * section (key `''`), spliced by `{{PROJECT_<KIND>}}`; each marker opens the
 * section spliced by `{{PROJECT_<KIND>_<NAME>}}`. Sections let one file place
 * project guidance at several points of the generic prompt, in the order the
 * prompt reads. Surrounding blank lines are trimmed. A repeated name is
 * refused: the second would silently shadow the first.
 */
export function parseFragmentSections(text: string, kind: FragmentKind = 'PROMPT'): Map<string, string> {
  const sections = new Map<string, string>();
  let name = '';
  let lines: string[] = [];
  const flush = () => {
    if (sections.has(name)) {
      throw new ModelConfigError(`the project ${kind.toLowerCase()} fragment defines section '${name}' twice.`);
    }
    sections.set(name, lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, ''));
  };
  for (const line of text.split('\n')) {
    const marker = SECTION_MARKER.exec(line);
    if (marker) {
      flush();
      name = marker[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Splice project fragments into generic text.
 *
 * Refuses, loudly: a `{{PROJECT_…}}` placeholder of an unknown kind; any
 * project placeholder when there is no project; and a fragment section the text
 * never places — that is project guidance silently dropped, which is exactly
 * what moving it out of the harness must not do. A placeholder whose section the
 * project does not define renders empty: a project with nothing to say at that
 * point says nothing.
 *
 * `role` is whose template this is, and it narrows that last refusal: one
 * fragment file holds every role's guidance (`roles.ts` `fragmentSection`), so
 * a coder's render walks past the triager's sections and a triager's walks past
 * the coder's. Each role still refuses its OWN unplaced sections, which is what
 * the check is for, and a template that places ANOTHER role's section is
 * refused outright.
 *
 * What the narrowing gives up, deliberately: a section under a prefix no loop
 * on the roster holds — `TRIAGER_VERIFY` on a project running only coders, a
 * mistyped prefix — reaches no model and no longer says so, because the render
 * that would refuse it never runs. It cannot be caught here: this function is
 * handed one template and one role, not the roster. It belongs to the role
 * preflight (felipearos/ralph#136), which reads the roster and can compare the
 * fragment's prefixes against it.
 */
export function spliceProject(text: string, project?: ProjectRender, role: Role = DEFAULT_ROLE): string {
  const placeholder = /\{\{PROJECT_([A-Z0-9]+)(?:_([A-Z0-9_]+))?\}\}/g;
  const used = new Map<FragmentKind, Set<string>>();
  const parsed = new Map<FragmentKind, Map<string, string>>();
  const out = text.replace(placeholder, (whole, rawKind: string, section: string | undefined) => {
    if (!(FRAGMENT_KINDS as readonly string[]).includes(rawKind)) {
      throw new ModelConfigError(`the prompt has a placeholder of unknown kind: ${whole}.`);
    }
    const kind = rawKind as FragmentKind;
    const source = project?.fragments[kind];
    if (source === undefined) {
      throw new ModelConfigError(
        `the prompt has ${whole}, but no project ${kind.toLowerCase()} fragment was loaded.\n` +
          '       Run from inside a project worktree with a valid .ralph/config.json.',
      );
    }
    if (!parsed.has(kind)) parsed.set(kind, parseFragmentSections(source, kind));
    const name = section ?? '';
    // A template places its OWN role's sections. The refusal below is
    // role-scoped, so a triager template naming `{{PROJECT_PROMPT_VERIFY}}`
    // would quietly splice the coder's guidance into a prompt that never runs
    // a coder's gate — and the coder's render would then walk past it as
    // "placed", losing its refusal too.
    if (sectionRole(name) !== role) {
      throw new ModelConfigError(
        `the ${role} prompt has ${whole}, which is the ${sectionRole(name)}'s section.\n` +
          `       A role's template places its own sections; ${role === DEFAULT_ROLE ? 'the coder\'s carry no prefix' : `the ${role}'s carry \`${roleDescriptor(role).fragmentSection}\``}.`,
      );
    }
    if (!used.has(kind)) used.set(kind, new Set());
    used.get(kind)!.add(name);
    return parsed.get(kind)!.get(name) ?? '';
  });
  for (const [kind, sections] of parsed) {
    const unplaced = [...sections.entries()]
      .filter(([name, body]) => !used.get(kind)!.has(name) && (name !== '' || body.trim() !== ''))
      .filter(([name]) => sectionRole(name) === role)
      .map(([name]) => (name === '' ? `{{PROJECT_${kind}}}` : `{{PROJECT_${kind}_${name}}}`));
    if (unplaced.length > 0) {
      throw new ModelConfigError(
        `the project ${kind.toLowerCase()} fragment has guidance the prompt never places: ${unplaced.join(', ')}.\n` +
          '       Rename the section to one the prompt uses, or add its placeholder.',
      );
    }
  }
  return out;
}

/** The `{{RALPH_…}}` values a project config contributes. */
export function projectValues(config: ProjectConfig): Record<string, string> {
  const humanMerges = config.merge === "human";
  return {
    RALPH_PROJECT_REPO: config.repo,
    RALPH_PROJECT_OWNER: config.owner,
    RALPH_BASE_BRANCH: config.baseBranch,
    RALPH_PROJECT_DISPLAY_NAME: config.displayName,
    // Generated rather than written out in the template: a prompt that names
    // four loops to a project that runs one is teaching the claim fence off a
    // roster that does not exist (`roster-prompt.ts`).
    RALPH_ROSTER: rosterBlock(config.roster),
    // §1 and §5.3's loop lists, generated for the same reason and from the same
    // roster — but naming every entry whatever its role, because they are about
    // whose work a reader may encounter rather than who its peers are.
    RALPH_ROSTER_BRANCH_GLOBS: rosterBranchGlobs(config.roster),
    RALPH_ROSTER_PROVENANCE: rosterProvenance(config.roster),
    RALPH_ROSTER_HEAD_BRANCHES: rosterHeadBranches(config.roster),
    RALPH_ROSTER_CAPITALS: rosterCapitals(config.roster),
    // Rendered from `clerk.pwaAgents`, the key the plan validator reads, so the
    // clerk's prompt never tells the session an app has agents that the
    // validator then overrules (or the other way round).
    RALPH_CLERK_AGENT_APPS: clerkAgentApps(config.clerk?.pwaAgents === true),
    // Rendered from `merge`, the key `ralph.sh` also reads to deny the session
    // `gh pr merge`, so the prompt and the rail never disagree on who merges.
    RALPH_MERGE_HANDOFF: mergeHandoff(config.merge),
    // Rendered from `mergeMethod`, the key `pr-wait.ts` reads to decide what a
    // merge wait watches, so the commands the prompt gives and the signal the
    // supervisor waits on never disagree. Absent renders as today.
    // On `merge: "human"` the session never merges, whatever the method: no
    // paragraph after the hand-off may tell it to run `gh pr merge`.
    RALPH_MERGE_ROUTE: mergeRoute(humanMerges ? undefined : config.mergeMethod),
    RALPH_MERGE_ENQUEUE: mergeEnqueue(humanMerges ? undefined : config.mergeMethod),
    RALPH_MERGE_REQUEUE: mergeRequeue(humanMerges ? undefined : config.mergeMethod),
  };
}

/**
 * Step 6's paragraph on how the base branch takes a merge. Absent and
 * `mergify` get the merge-queue paragraph every prompt carried before
 * `mergeMethod` existed, byte for byte.
 */
export function mergeRoute(method: MergeMethod | undefined): string {
  if (method === "github-queue") {
    return [
      "   The base branch merges only through GitHub's merge queue, and that",
      "   changes what \"merge\" means here. `gh pr merge <pr>` with no strategy",
      "   flag is how the PR enters the queue (the queue's own settings pick the",
      "   strategy); **never pass `--admin`**, which merges around the queue. The",
      "   queue builds base-plus-your-PR before the merge lands. The",
      "   queue is what proves the combination, so being behind",
      "   `origin/$RALPH_BASE_BRANCH` is no longer a reason to rebase — a rebase",
      "   re-runs CI on the PR for nothing. Rebase only for a real textual",
      "   conflict.",
    ].join("\n");
  }
  if (method === "direct") {
    return [
      "   The base branch has no merge queue on this project (`mergeMethod:",
      "   \"direct\"`): once the three conditions above hold, you merge the PR",
      "   yourself with `gh pr merge <pr> --squash`. Rebase only for a real",
      "   textual conflict. What follows about the queue — the `queued` label,",
      "   the queue's build, re-queueing — does not apply here: a **dequeued**",
      "   wait outcome means the merge did not land.",
    ].join("\n");
  }
  return [
    "   The base branch merges only through the merge queue, and that changes what",
    "   \"merge\" means here. **Never run `gh pr merge`**: on this project it merges",
    "   at once, around the queue, and the project's hook refuses it. You enqueue",
    "   instead, and the queue builds base-plus-your-PR on a temporary branch",
    "   before the merge lands. The queue is what proves the combination, so being",
    "   behind `origin/$RALPH_BASE_BRANCH` is no longer a reason to rebase — a",
    "   rebase re-runs CI on the PR for nothing. Rebase only for a real textual",
    "   conflict.",
  ].join("\n");
}

/**
 * Step 6's enqueue command for the project's merge method, placed after the
 * project fragment's own `ENQUEUE` section. Empty when no method is set, so
 * a project whose fragment carries the command reads as it did.
 */
export function mergeEnqueue(method: MergeMethod | undefined): string {
  if (method === undefined) return "";
  const block = (command: string): string[] => ["", "", "     ```bash", `     ${command}`, "     ```", ""];
  if (method === "mergify") {
    return [
      ...block('gh pr comment <pr> --body "@mergifyio queue"'),
      "     That comment is Mergify's enqueue: it replies on the PR and adds the",
      "     `queued` label, swapped for `dequeued` after a failed attempt.",
    ].join("\n");
  }
  if (method === "github-queue") {
    return [
      ...block("gh pr merge <pr>"),
      "     That is GitHub's enqueue. GitHub's queue puts no label on the PR; this",
      "     reads whether the PR is in it:",
      "",
      "     ```bash",
      "     gh api graphql -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue autoMergeRequest{enabledAt}}}}' -F owner='{owner}' -F name='{repo}' -F number=<pr>",
      "     ```",
      "",
      "     On this project, read \"carries `queued`\" below as `isInMergeQueue`",
      "     being `true` or `autoMergeRequest` being set: `gh pr merge` enables",
      "     auto-merge instead while GitHub waits on a requirement of its own.",
    ].join("\n");
  }
  return [
    ...block("gh pr merge <pr> --squash"),
    "     A refusal from `gh` means one of the three conditions does not hold — a",
    "     check that is not green is §5.4's problem, a conflict is the rebase",
    "     case — and is never a reason to retry it or to pass `--admin`. Once it",
    "     succeeds, still end with `<ralph>AWAIT_PR <pr> merge</ralph>`, so step",
    "     7's cleanup runs only after the supervisor has seen the merge land.",
  ].join("\n");
}

/**
 * The `dequeued` branch's re-queue command for the project's merge method,
 * placed before the fragment-neutral sentence that uses it. Empty when no
 * method is set and on `direct`, which has no queue to re-enter.
 */
export function mergeRequeue(method: MergeMethod | undefined): string {
  if (method === "mergify") return 'Here the re-queue command is `gh pr comment <pr> --body "@mergifyio requeue"`.';
  if (method === "github-queue") {
    return [
      "Here the re-queue command is `gh pr merge <pr>`, the same command that",
      "         enqueues: GitHub's queue leaves no check of its own red on the head,",
      "         so the rule against re-running the enqueue command does not hold",
      "         here.",
    ].join("\n");
  }
  return "";
}

/**
 * Step 6's hand-off to a person on a `merge: "human"` project, or nothing.
 * Empty for `loop`, so every other project's prompt reads as it did.
 */
export function mergeHandoff(merge: "loop" | "human"): string {
  if (merge === "loop") return "";
  return [
    "",
    "   **On this project a person merges, never you** (`merge: \"human\"` in",
    "   `.ralph/config.json`). `gh pr merge` is denied to this session, and",
    "   what follows about enqueueing, merge waits and step 7 does not apply.",
    "   Judge the three conditions above exactly as written, and work any that",
    "   does not hold as below: fix CI, rebase, answer every thread, within the",
    "   same two-round cap. Once all three hold, hand the PR to a person:",
    "",
    "   ```bash",
    "   bun \"$RALPH_HOME/tracker.ts\" handoff <n> --pr <pr-url>",
    "   ```",
    "",
    "   `--pr` is the PR's URL, recorded in the speed ledger as the moment the",
    "   ticket was handed off. It removes the claim and `ready-for-agent`, adds `$RALPH_LOOP_NAME-done`",
    "   and moves the ticket to the project's review state when it names one.",
    "   The ticket stays open: a person merges and closes it. A warning on",
    "   stderr that the state move failed is journalled and carried on from, as",
    "   in step 7. Then comment the token footer",
    "   (`\"$RALPH_HOME/usage.py\" --step \"handed off #<n>\" --md`) on the PR,",
    "   then mark it as waiting on a person, in a call of its own:",
    "   `gh pr edit <pr> --add-label ready-for-review` (if the label is missing,",
    "   `gh label create ready-for-review --color 0E8A16 --description",
    "   \"Esperando revisión humana\"` first). That label is what the team",
    "   filters on, but a failure here is journalled and carried on from, never",
    "   a reason to skip the next write. Last, and only if the footer comment",
    "   succeeded, make `gh pr edit <pr> --add-label",
    "   $RALPH_LOOP_NAME-done` the final remote write: it is what tells §1 and",
    "   the supervisor's gate the PR is no longer yours to shepherd. Detach with",
    "   `git fetch origin && git switch --detach \"origin/$RALPH_BASE_BRANCH\"`,",
    "   journal, and end with `<ralph>DONE</ralph>`. Never end with",
    "   `AWAIT_PR <pr> merge`: nobody in this loop will merge it.",
    "",
  ].join("\n");
}

/** The clerk prompt's sentence on which apps an agent project works. */
export function clerkAgentApps(pwaAgents: boolean): string {
  return pwaAgents
    ? 'Agent projects work both `Backoffice` and `pwa` (a `none` report is filed under `Backoffice`), so no single app forces `person`.'
    : 'An agent project works `Backoffice` only (a `none` report is filed under it); `pwa` has none, so a `pwa` report goes to a person.';
}

export function renderPrompt(text: string, lineup: Lineup, project?: ProjectRender, role: Role = DEFAULT_ROLE): string {
  // Fragments first, so project guidance may itself name lineup values
  // (`{{RALPH_HOWTO_REVIEW_SPEC}}`) and have them filled by the pass below.
  text = spliceProject(text, project, role);
  const stages = lineupStages(lineup);
  const values = new Map<string, string>(stages.map((stage) => [envNameFor(stage), lineup[stage]!.model]));
  for (const [name, value] of Object.entries(project?.values ?? {})) values.set(name, value);
  for (const stage of stages) {
    values.set(runnerEnvNameFor(stage), lineup[stage]!.runner);
  }
  // A stage this role does not run renders no invocation sentence, and its
  // template names none — an unrendered `{{RALPH_HOWTO_…}}` is refused below,
  // which is what turns a role's prompt naming a stage it lacks into a refusal
  // at render rather than a model id the iteration invents for itself.
  for (const stage of AGENT_TOOL_STAGES) {
    const resolved = lineup[stage];
    if (resolved === undefined) continue;
    values.set(`RALPH_HOWTO_${varTail(stage)}`, howToInvoke(stage, resolved, lineup.orchestrator.runner));
  }
  // An absent effort is a phrase here and an `unset` in `exportLines`, and that
  // is not two spellings of one thing: the prompt is a sentence a model reads
  // ("effort **the CLI default**"), while the export feeds a `[ -n … ]` that
  // decides whether `--effort` is passed at all. An empty substitution would
  // leave the prompt reading "effort **** ".
  values.set('RALPH_MODEL_ORCHESTRATOR_EFFORT', lineup.orchestrator.effort ?? 'the CLI default');

  const rendered = text.replace(/\{\{(RALPH_[A-Z0-9_]+)\}\}/g, (whole, name: string) =>
    values.has(name) ? values.get(name)! : whole,
  );

  // Anything still in `{{RALPH_…}}` form is a placeholder nothing here
  // knows about. Scoped to that prefix rather than to every `{{TOKEN}}`: the
  // prompt is 34K of markdown that may quote other tools' template syntax, and
  // aborting a run over somebody else's braces is not this file's business.
  // Refused rather than passed through: reaching the model as literal
  // `{{RALPH_MODEL_JUDGE}}` is how a stage silently loses its configuration —
  // the iteration reads a name that is not a model and picks one itself.
  const left = [...new Set(rendered.match(/\{\{RALPH_[A-Z0-9_]*\}\}/g) ?? [])];
  if (left.length > 0) {
    throw new ModelConfigError(
      `the prompt has ${left.length === 1 ? 'a placeholder' : 'placeholders'} nothing renders: ` +
        `${left.join(', ')}.\n       Add the stage to models.json (or the value to the project config), or remove it from the prompt.`,
    );
  }
  return rendered;
}

/** Single-quoted for `eval`, with the one escape that form needs. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function exportLines(lineup: Lineup): string[] {
  const stages = lineupStages(lineup);
  const lines = stages.flatMap((stage) => [
    `export ${envNameFor(stage)}=${shellQuote(lineup[stage]!.model)}`,
    `export ${runnerEnvNameFor(stage)}=${shellQuote(lineup[stage]!.runner)}`,
  ]);
  // Clear inherited values too, preserving absence through child resolution.
  for (const stage of stages) {
    const variable = `${envNameFor(stage)}_EFFORT`;
    lines.push(lineup[stage]!.effort
      ? `export ${variable}=${shellQuote(lineup[stage]!.effort!)}`
      : `unset ${variable}`);
  }
  // The rosters, so the supervisor's completeness check loops over lists this
  // file generates instead of a second copy of `STAGES` written out in bash.
  // Two of them rather than one interleaved list: a stage with no runner is as
  // unrunnable as one with no model, so the check wants both — but the log
  // line pairs them, and pairing is what an interleaved roster makes the
  // supervisor reconstruct by string surgery.
  // The rosters name the stages this lineup HAS, so the supervisor's
  // completeness check passes for a role that runs three of them instead of
  // failing on two variables nothing was ever going to export.
  lines.push(`export RALPH_MODEL_STAGE_VARS=${shellQuote(stages.map(envNameFor).join(' '))}`);
  lines.push(`export RALPH_RUNNER_STAGE_VARS=${shellQuote(stages.map(runnerEnvNameFor).join(' '))}`);
  return lines;
}

/**
 * What the named agents may use: reading, and a shell for `git diff` and
 * `git log`. Bash, unlike the external route, because in-session there is no
 * wrapper to hand the stage its diff; the preamble below says the shell's
 * read-only use is a rail the agent keeps, not one a permission layer enforces.
 */
const AGENT_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'] as const;

/**
 * Put in front of `inspector.md`, which is written for `inspect.sh`: there the
 * brief follows the rails and the harness denies writes. Here neither is true,
 * and rails that misdescribe their own enforcement are rails a model discounts.
 */
const NAMED_AGENT_PREAMBLE = [
  '> You run as a named subagent inside the orchestrator\'s own session. The brief',
  '> is the prompt of the Agent call that started you, not text below these rails.',
  '> Your tools are Read, Glob, Grep and Bash. Edits and writes are not among them;',
  '> Bash is not fenced for you, so use it only for read-only git (`diff`, `log`,',
  '> `show`, `blame`, `status`, `rev-parse`, `merge-base`, `ls-files`) and plain',
  '> file listing. Where the rails below say a write is denied, here it is yours',
  '> not to make.',
  '',
  '',
].join('\n');

const AGENT_DESCRIPTIONS: Partial<Record<Stage, string>> = {
  mapper: 'Ralph mapping stage: maps the code a brief names, read-only.',
  'review.standards': "Ralph standards-axis review: reviews a change against the repo's documented standards, read-only.",
  'review.spec': "Ralph spec-axis review: reviews a change against its issue's requirements, read-only.",
  'review.correctness':
    'Ralph correctness-axis review: hunts the bugs in a change (races, failure paths, missing checks), read-only.',
};

export interface AgentDefinition {
  description: string;
  prompt: string;
  tools: string[];
  model: string;
  effort?: string;
}

/**
 * The named subagents a Claude-hosted run defines, keyed by name — the object
 * `claude --agents` takes. One per Agent-tool stage on the `claude` runner;
 * none under a Codex orchestrator, which reaches Claude through `inspect.sh`.
 *
 * `rails` is `inspector.md`, the same text `inspect.sh` puts in front of an
 * external inspection's brief, so a stage reads one set of rules whichever
 * harness runs it. An absent effort is an absent key, and the session's own
 * then applies.
 */
export function claudeAgents(lineup: Lineup, rails: string): Record<string, AgentDefinition> {
  if (lineup.orchestrator.runner !== 'claude') return {};
  const agents: Record<string, AgentDefinition> = {};
  for (const stage of AGENT_TOOL_STAGES) {
    // A stage outside this role's set defines no agent: the `subagent_type` a
    // triager's prompt never names must not exist for it to reach for.
    const resolved = lineup[stage];
    if (resolved === undefined) continue;
    const { runner, model, effort } = resolved;
    if (runner !== 'claude') continue;
    agents[AGENT_NAMES[stage]!] = {
      description: AGENT_DESCRIPTIONS[stage]!,
      prompt: NAMED_AGENT_PREAMBLE + rails,
      tools: [...AGENT_TOOLS],
      model,
      ...(effort ? { effort } : {}),
    };
  }
  return agents;
}

/**
 * The definitions as one shell assignment for `ralph.sh` to eval and pass as
 * `claude --agents "$RALPH_CLAUDE_AGENTS"`.
 *
 * A flag rather than agent files in a run-scoped directory: `.claude/agents/`
 * in the project is committed, so writing there would dirty every worktree,
 * and any other directory Claude Code reads agents from is shared by every
 * session on the machine. The flag is scoped to exactly the process it is
 * handed to, and a resumed turn gets the same definitions because it is handed
 * the same flag. Not exported: nothing below the orchestrator reads it.
 */
export function agentsExportLine(lineup: Lineup, rails: string): string {
  const agents = claudeAgents(lineup, rails);
  return `RALPH_CLAUDE_AGENTS=${shellQuote(Object.keys(agents).length ? JSON.stringify(agents) : '')}`;
}

export function listLines(lineup: Lineup): string[] {
  const stages = lineupStages(lineup);
  const width = Math.max(...stages.map((stage) => stage.length));
  const runnerWidth = Math.max(...stages.map((stage) => lineup[stage]!.runner.length));
  return stages.map((stage) => {
    const { model, runner, effort, fallback, source } = lineup[stage]!;
    const notes = [
      ...(effort ? [`effort: ${effort}`] : []),
      ...(fallback ? [`falls back to: ${fallback.join(' → ')}`] : []),
    ];
    const suffix = notes.length ? ` (${notes.join('; ')})` : '';
    return `${stage.padEnd(width)}  ${runner.padEnd(runnerWidth)}  ${model}${suffix}  [${source}]`;
  });
}

/**
 * The project half of a CLI render, loaded only when the text asks for it —
 * a template with no project placeholders renders without a project. Fragment
 * paths come from the project's `.ralph/config.json`, relative to its root; an
 * unreadable fragment is refused, never rendered as nothing.
 */
function projectRenderFor(text: string): ProjectRender | undefined {
  const kinds = FRAGMENT_KINDS.filter((kind) => new RegExp(`\\{\\{PROJECT_${kind}(?:_[A-Z0-9_]+)?\\}\\}`).test(text));
  const wantsValues = /\{\{RALPH_(?:PROJECT_[A-Z_]+|BASE_BRANCH|ROSTER)\}\}/.test(text);
  if (kinds.length === 0 && !wantsValues) return undefined;
  const root = projectRoot();
  const config = loadProjectConfig(root);
  const fragments: ProjectRender['fragments'] = {};
  for (const kind of kinds) {
    const relative = kind === 'PROMPT' ? config.promptFragment : config.coderFragment;
    const path = join(root, relative);
    try {
      fragments[kind] = readFileSync(path, 'utf8');
    } catch (error) {
      throw new ModelConfigError(`cannot read the project ${kind.toLowerCase()} fragment ${path}: ${(error as Error).message}`);
    }
  }
  return { fragments, values: projectValues(config) };
}

/**
 * This checkout's project and the roles of its loops, for the validator, or
 * undefined when the checkout cannot answer.
 *
 * Best effort on purpose: `--validate` judges a candidate that may not be the
 * live file, and is the one command that must work with the project config
 * broken. Without the roster every block is judged as a coder's, which is the
 * pre-roles behaviour and never a false refusal — a role's own stages are
 * reachable through an `@role` key, which says its role in the document.
 */
function rosterRoles(): RolesByProject | undefined {
  try {
    const root = projectRoot();
    // Keyed by the project this checkout IS, never by the one the environment
    // asked about. They disagree whenever a caller resolves another project's
    // loop from a checkout that is not that project's — the dashboard does it
    // on every read — and filing one roster under the other's id does not
    // return "unknown" there: it returns the WRONG role for any loop name the
    // two rosters happen to share, and a role decides which stages exist.
    const project = currentProjectId(root);
    const asked = process.env.RALPH_PROJECT_ID?.trim();
    if (asked !== undefined && asked !== '' && asked !== project) return undefined;
    const loops: Record<string, Role> = {};
    for (const entry of loadProjectConfig(root).roster) loops[entry.name] = entry.role;
    return { [project]: loops };
  } catch {
    return undefined;
  }
}

/**
 * The role the roster gives `loop` in `project`, or undefined when this
 * checkout cannot say.
 *
 * The roster is the authority on a loop's role — `ralph.sh` reads it with
 * `project-config.ts --role-of` and passes `--role` — and this is the same
 * answer for a hand run that passed no flag. Undefined rather than `coder`, so
 * the caller decides what silence means: for a dashboard resolving another
 * project's loop from a checkout that is not that project's, silence is all
 * this can honestly return.
 */
function rosterRole(project: string, loop: string): Role | undefined {
  return rosterRoles()?.[project]?.[loop];
}

/**
 * The roles the validator judges loop blocks by: the roster's, with this run's
 * loop pinned to `role` when the caller named one.
 *
 * Pinned rather than merely defaulted, because `--role` is how a caller states
 * a role the roster cannot tell it — the dashboard validates another project's
 * document from the harness checkout, where that project's roster is not
 * readable at all (#139).
 */
function rolesForValidation(role: Role | undefined): RolesByProject | undefined {
  const roster = rosterRoles();
  if (role === undefined) return roster;
  const project = process.env.RALPH_PROJECT_ID?.trim() || (() => {
    try {
      return currentProjectId(projectRoot());
    } catch {
      return undefined;
    }
  })();
  if (project === undefined || project === '') return roster;
  const loop = process.env.RALPH_LOOP_NAME?.trim() || 'ralph';
  return { ...roster, [project]: { ...roster?.[project], [loop]: role } };
}

/**
 * `--role R` wherever a command takes one, with the flag and its value removed
 * from the arguments so a positional path still reads as the first of them.
 *
 * One parser for every command rather than `--render-prompt`'s own, because a
 * role now decides which stages exist at all: a caller that passed `--role` to
 * the wrong subcommand would get a coder's lineup and no complaint.
 */
function takeRole(args: string[]): { role?: Role; rest: string[] } | { problem: string } {
  const at = args.indexOf('--role');
  if (at < 0) return { rest: args };
  const named = args[at + 1];
  if (named === undefined || !isRole(named)) {
    return {
      problem: `models: --role takes one of ${ROLES.join(', ')}${named === undefined ? '' : `, not '${named}'`}.`,
    };
  }
  return { role: named, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const usage = [
    'usage: bun "$RALPH_HOME/models.ts" <stage>            # print one model',
    '       bun "$RALPH_HOME/models.ts" <stage> --runner  # print the harness that runs it',
    '       bun "$RALPH_HOME/models.ts" --export           # eval-able exports for the supervisor',
    '       bun "$RALPH_HOME/models.ts" --render-prompt F  # F with its {{…}} placeholders filled in (project fragments from .ralph/config.json)',
    '       bun "$RALPH_HOME/models.ts" --render-prompt [F] --role R  # as R (default coder): F, or R\'s own template when F is left out',
    '       bun "$RALPH_HOME/models.ts" --list             # the resolved lineup, readable',
    '       bun "$RALPH_HOME/models.ts" --json [F]         # the resolved lineup as JSON (F defaults to models.json)',
    '       bun "$RALPH_HOME/models.ts" --schema           # the resolver’s rules as JSON',
    '       --role R on --list, --json, --export, --schema, --validate, --render-prompt and a',
    '       stage query: resolve as R — its stages, and its project default block (@R) between',
    '       the loop\'s own and the project\'s. Without it, the roster answers for this loop.',
    '       bun "$RALPH_HOME/models.ts" --migrate [F]      # move pre-project loop blocks under \'loggd\' (F defaults to models.json)',
    "       bun \"$RALPH_HOME/models.ts\" --validate F       # validate a candidate config; F is a path or '-' for stdin",
    `stages: ${STAGES.join(', ')}`,
  ].join('\n');

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return args.length === 0 ? 2 : 0;
  }

  const taken = takeRole(args);
  if ('problem' in taken) {
    console.error(`${taken.problem}\n${usage}`);
    return 1;
  }
  // Absent means "ask the roster", below: the flag is how the supervisor states
  // a role it has already read, not the only way one can be known.
  const explicitRole = taken.role;
  const rest = taken.rest;
  const [command] = rest;

  // The machine-readable surfaces the line-up editor consumes across a process
  // boundary. Handled before the live config is resolved, because `--schema`
  // needs no config at all and `--validate` judges a candidate that may not be
  // the one on disk — a broken live file must not stop a caller from asking
  // whether a different candidate is valid.
  if (command === '--schema') {
    // No config and no roster: `--schema` answers for the role the caller named
    // and the coder otherwise, which is what makes it the one command a broken
    // project config cannot stop.
    console.log(JSON.stringify(schemaJson(explicitRole), null, 2));
    return 0;
  }
  if (command === '--validate') {
    const source = rest[1];
    if (source === undefined) {
      console.error(`models: --validate needs a path, or '-' for stdin.\n${usage}`);
      return 2;
    }
    let candidate: Record<string, unknown>;
    try {
      candidate = source === '-' ? parseConfigObject(readFileSync(0, 'utf8'), '(stdin)') : loadConfig(source, false);
    } catch (error) {
      if (error instanceof ModelConfigError) {
        // A document that will not parse is a rejected candidate, not an
        // operational failure: the caller wants the reason in the same JSON
        // shape as every other refusal.
        console.log(JSON.stringify({ valid: false, problems: [error.message] }, null, 2));
        return 1;
      }
      throw error;
    }
    // `--role` names the role of the loop being validated (`RALPH_LOOP_NAME`),
    // and it OVERRIDES what the roster says about it. Accepting the flag and
    // then judging that block as a coder's is the failure this closes: a
    // correct three-stage triager block came back "missing 'executor'", and the
    // refusal told the operator to add the very stage the resolver then
    // refuses. A caller that names no role still gets the roster's answer.
    const result = validateConfig(candidate, rolesForValidation(explicitRole));
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  if (command === '--migrate') {
    const path = rest[1] ?? join(RALPH_DIR, 'models.json');
    try {
      const before = loadConfig(path, false);
      const migrated = migrateConfig(before);
      if (migrated === null) {
        console.log(`models: ${path} is already keyed by project; nothing to move.`);
      } else {
        writeConfigFile(path, migrated);
        console.log(`models: moved ${Object.keys(migrated[LEGACY_PROJECT] as object).join(', ')} under '${LEGACY_PROJECT}' in ${path}.`);
      }
    } catch (error) {
      if (error instanceof ModelConfigError) {
        console.error(`models: ${error.message}`);
        return 1;
      }
      throw error;
    }
    return 0;
  }

  // The project this loop belongs to, for its block. The supervisor exports
  // it; a hand run is resolved from the checkout it is run in.
  let project: string;
  try {
    project = process.env.RALPH_PROJECT_ID?.trim() || currentProjectId(projectRoot());
  } catch (error) {
    console.error(`models: ${(error as Error).message}`);
    return 1;
  }

  const loopName = process.env.RALPH_LOOP_NAME ?? 'ralph';
  // The role this loop is resolved as: the caller's flag, else the roster's
  // answer for this loop, else the coder — which is what every loop was before
  // roles existed.
  const role = explicitRole ?? rosterRole(project, loopName) ?? DEFAULT_ROLE;

  if (command === '--json') {
    const source = rest[1];
    try {
      const config = loadConfig(source);
      const resolved = resolveLineup({ config, env: process.env, loopName, project, role });
      console.log(JSON.stringify(lineupJson(resolved, loopName, project, role), null, 2));
    } catch (error) {
      if (error instanceof ModelConfigError) {
        console.error(`models: ${error.message}`);
        return 1;
      }
      throw error;
    }
    return 0;
  }

  let lineup: Lineup;
  try {
    lineup = resolveLineup({ config: loadConfig(), project, loopName, role });
  } catch (error) {
    if (error instanceof ModelConfigError) {
      console.error(`models: ${error.message}`);
      return 1;
    }
    throw error;
  }

  if (command === '--export') {
    let rails: string;
    try {
      rails = readFileSync(join(RALPH_DIR, 'inspector.md'), 'utf8');
    } catch (error) {
      console.error(`models: cannot read the stage rails ${join(RALPH_DIR, 'inspector.md')}: ${(error as Error).message}`);
      return 1;
    }
    console.log([...exportLines(lineup), agentsExportLine(lineup, rails)].join('\n'));
    return 0;
  }
  if (command === '--render-prompt') {
    // The role decides three things: which stages the lineup above holds,
    // which template to render when the caller names none, and whose fragment
    // sections the splice holds to. The supervisor passes the role alone, so
    // `roles.ts` stays the one place a role's template is named.
    const files = rest.slice(1);
    // A file or a role, never neither: defaulting a bare `--render-prompt` to
    // the coder's template would turn a caller that lost its `"$TEMPLATE"`
    // into a full prompt printed with exit 0.
    if (files.length === 0 && explicitRole === undefined) {
      console.error(`models: --render-prompt needs a file, or --role to take the role's own.\n${usage}`);
      return 1;
    }
    const file = files[0] ?? join(RALPH_DIR, roleDescriptor(role).prompt);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      console.error(`models: cannot read ${file}: ${(error as Error).message}`);
      return 1;
    }
    try {
      // No trailing newline of our own: the caller captures this in a command
      // substitution, which strips them anyway.
      process.stdout.write(renderPrompt(text, lineup, projectRenderFor(text), role));
    } catch (error) {
      if (error instanceof ModelConfigError || error instanceof ProjectConfigError) {
        console.error(`models: ${error.message}`);
        return 1;
      }
      throw error;
    }
    return 0;
  }
  if (command === '--list') {
    console.log(listLines(lineup).join('\n'));
    return 0;
  }
  // A stage name. `review-standards` and `review_standards` are accepted for
  // the same reason the env vars use underscores: nobody should have to
  // remember which separator this file chose.
  const wanted = command!.replace(/[-_]/g, '.').toLowerCase();
  const stage = STAGES.find((candidate) => candidate === wanted);
  if (!stage) {
    console.error(`models: unknown stage '${command}'.\n${usage}`);
    return 1;
  }
  const resolved = lineup[stage];
  // A real stage this loop's role does not run. Refused rather than answered
  // from `default`: the caller is a script about to run that stage, and an
  // executor model printed for a triager is a delegation that should not happen.
  if (resolved === undefined) {
    console.error(
      `models: the ${role} role does not run '${stage}'. Its stages: ${lineupStages(lineup).join(', ')}.`,
    );
    return 1;
  }
  // `--runner` rather than a second subcommand: `inspect.sh` asks for the pair,
  // and a stage argument that means one thing in one position and another in
  // the next is how a caller ends up passing a runner to `-m`.
  if (rest[1] === '--effort') {
    console.log(resolved.effort ?? '');
    return 0;
  }
  if (rest[1] === '--runner') {
    console.log(resolved.runner);
    return 0;
  }
  if (rest.length > 1) {
    console.error(`models: unknown option '${rest[1]}'.\n${usage}`);
    return 1;
  }
  console.log(resolved.model);
  return 0;
}

// `import.meta.main` is bun's; under vitest it is undefined, so importing this
// module never runs the CLI.
// `process.exitCode`, never `process.exit()`: stdout to a pipe is written
// asynchronously, and exiting at once cut the rendered prompt that `ralph.sh`
// captures with `$( )` at the first 12–16 KiB, so every iteration began from
// the top third of its instructions.
if (import.meta.main) {
  process.exitCode = main(process.argv);
}
