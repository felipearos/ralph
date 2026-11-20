// @vitest-environment node
/**
 * The lineup editor's pure layer, and the two calls it makes across a process
 * boundary: the CLI that validates a candidate and the atomic write that
 * commits one.
 *
 * These tests treat `models.ts` the way the editor must — as a process whose
 * JSON is the contract. Nothing here imports the resolver; a rule is asserted
 * by spawning `bun ralph/models.ts --validate` and reading its verdict, so the
 * layer is pinned to the thing that actually runs, not to a copy of its rules.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createLoopBlock,
  mergeProjectView,
  projectView,
  removeLoopBlock,
  saveConfig,
  serializeConfig,
  setStage,
  validateConfigText,
  writeConfigAtomically,
  type JsonObject,
  type StageChange,
  type ValidationResult,
} from './lineup-editor';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs the lineup editor through bash and bun');

const BUN = ((): string => {
  try {
    return execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
  } catch {
    return process.execPath;
  }
})();
const CLI = join(__dirname, 'models.ts');

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const scratch = (contents: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'loggd-lineup-editor-')), 'models.json');
  scratchRoots.push(join(path, '..'));
  writeFileSync(path, contents);
  return path;
};

// The runner's own environment may carry a RALPH_* one-off; these tests pin
// what the file says unless they set one deliberately.
const runCli = (args: string[], overrides: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('RALPH_') && !(key in overrides)) delete env[key];
  return spawnSync(BUN, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...overrides } });
};

interface StageNode {
  runner: string;
  model: string;
  effort?: string;
  fallback?: string | string[];
}
interface BlockShape {
  orchestrator: StageNode;
  executor: StageNode;
  mapper: StageNode;
  review: { standards: StageNode; spec: StageNode };
}
interface ConfigShape {
  default: BlockShape;
  [key: string]: unknown;
}
interface LineupShape {
  loop: string;
  stages: Record<string, StageNode & { source: string }>;
}
// `JSON.parse` is `any`; these are the shapes the CLI promises.
const parse = <T>(text: string): T => JSON.parse(text) as T;

/** The stage list the runtime exposes, not a copy kept in this file. */
const runtimeStages = (): string[] => parse<{ stages: string[] }>(runCli(['--schema']).stdout).stages;

const block = (): JsonObject => ({
  orchestrator: { runner: 'claude', model: 'claude-opus-5', effort: 'medium' },
  executor: { runner: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
  mapper: { runner: 'claude', model: 'sonnet' },
  review: {
    standards: { runner: 'claude', model: 'opus' },
    spec: { runner: 'claude', model: 'opus' },
  },
});

const config = (extra: JsonObject = {}): JsonObject => ({
  $comment: ['JSON cannot hold a comment, so a $-key does — and is not a loop.'],
  default: block(),
  $comment_loops: ['why the named loops differ from default'],
  ...extra,
});

/** A flat, edited view written back under `loggd`, as the adapter saves it. */
const asFile = (view: JsonObject): JsonObject => mergeProjectView(config(), 'loggd', view);

const resolveCandidate = (path: string, overrides: Record<string, string> = {}): LineupShape =>
  parse<LineupShape>(runCli(['--json', path], overrides).stdout);

describe('editing a stage', () => {
  it('serializes a per-stage change that reloads to the expected lineup', () => {
    const config0 = config();
    setStage(config0, 'default', 'executor', { runner: 'claude', model: 'claude-sonnet-5' }, runtimeStages());
    const text = serializeConfig(config0);

    expect(parse<ConfigShape>(text).default.executor).toEqual({ runner: 'claude', model: 'claude-sonnet-5' });
    expect(text.endsWith('\n')).toBe(true);

    const path = scratch(text);
    expect(resolveCandidate(path).stages).toMatchObject({
      executor: { model: 'claude-sonnet-5', runner: 'claude', source: 'default' },
    });
  });

  it('lets a field be removed, because a fallback or effort can stop applying', () => {
    const config0 = config();
    setStage(config0, 'default', 'orchestrator', { effort: null }, runtimeStages());
    setStage(config0, 'default', 'mapper', { runner: 'codex', model: 'gpt-5.6-terra', fallback: ['haiku'] }, runtimeStages());
    setStage(config0, 'default', 'mapper', { fallback: null }, runtimeStages());

    const parsed = parse<ConfigShape>(serializeConfig(config0));
    expect(parsed.default.orchestrator).not.toHaveProperty('effort');
    expect(parsed.default.mapper).not.toHaveProperty('fallback');
    expect(validateConfigText(serializeConfig(config0)).valid).toBe(true);
  });

  it('creates a named loop block with all five stages, ordered by the runtime list', () => {
    const config0 = config();
    setStage(config0, 'rafa', 'mapper', { model: 'haiku' }, runtimeStages());

    const rafa = config0.rafa as JsonObject;
    expect(Object.keys(rafa)).toEqual(['orchestrator', 'executor', 'mapper', 'review']);
    expect(Object.keys(rafa.review as JsonObject)).toEqual(['standards', 'spec']);
    expect(rafa.orchestrator).toEqual((config0.default as JsonObject).orchestrator);
    expect(rafa.mapper).toEqual({ runner: 'claude', model: 'haiku' });
  });

  it('completes a partial named block from default rather than leaving it refused', () => {
    const config0 = config({
      rafa: { executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' } },
    });
    setStage(config0, 'rafa', 'mapper', { model: 'sonnet' }, runtimeStages());

    expect(validateConfigText(serializeConfig(asFile(config0)))).toEqual({ valid: true, problems: [] });
  });

  it('appends a new loop block last', () => {
    const config0 = config();
    createLoopBlock(config0, 'rafa', runtimeStages());

    expect(Object.keys(config0)).toEqual(['$comment', 'default', '$comment_loops', 'rafa']);
  });

  it('completes an existing partial block without overwriting what it names', () => {
    const config0 = config({
      rafa: { executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' } },
    });
    createLoopBlock(config0, 'rafa', runtimeStages());

    const rafa = config0.rafa as JsonObject;
    // The operator's earlier edit survives; the stages it omitted are filled
    // from `default`, so the block the resolver reads is complete.
    expect(rafa.executor).toEqual({ runner: 'opencode', model: 'opencode-go/kimi-k3' });
    expect(Object.keys(rafa)).toEqual(['executor', 'orchestrator', 'mapper', 'review']);
    expect(validateConfigText(serializeConfig(asFile(config0)))).toEqual({ valid: true, problems: [] });
  });

  it('refuses a stage the runtime does not know, which validation would not catch', () => {
    // The resolver reads only the stages it knows, so a typo written here
    // would validate clean and leave the old stage silently in place.
    expect(() => setStage(config(), 'default', 'executer', { model: 'x' }, runtimeStages())).toThrow(
      /unknown stage 'executer'/,
    );
  });

  it('removes a named loop block so the loop falls back to default', () => {
    const config0 = config();
    setStage(config0, 'rafa', 'mapper', { model: 'haiku' }, runtimeStages());
    removeLoopBlock(config0, 'rafa');

    expect(config0.rafa).toBeUndefined();
    const resolved = resolveCandidate(scratch(serializeConfig(config0)), { RALPH_LOOP_NAME: 'rafa' });
    expect(resolved.loop).toBe('rafa');
    expect(resolved.stages).toMatchObject({ mapper: { model: 'sonnet', source: 'default' } });
  });

  it('refuses to remove the default block, which every other loop falls back to', () => {
    expect(() => removeLoopBlock(config(), 'default')).toThrow(/cannot be removed/);
  });

  it('round-trips the commentary keys and the existing key order', () => {
    const config0 = config();
    const before = parse<ConfigShape>(serializeConfig(config0));
    setStage(config0, 'default', 'executor', { model: 'opencode-go/kimi-k3' }, runtimeStages());
    const after = parse<ConfigShape>(serializeConfig(config0));

    expect(after.$comment).toEqual(before.$comment);
    expect(after.$comment_loops).toEqual(before.$comment_loops);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });
});

describe('one project at a time', () => {
  const own = (model: string): JsonObject => ({ ...block(), orchestrator: { runner: 'claude', model } });
  const file = (): JsonObject =>
    config({ loggd: { ralph: own('claude-sonnet-5') }, other: { ralph: own('claude-haiku-4-5'), default: own('claude-fable-5-1') } });

  it("views a project's loops beside the default they fall back to", () => {
    expect(projectView(file(), 'loggd')).toEqual({ default: block(), ralph: own('claude-sonnet-5') });
    expect(projectView(file(), 'other')).toEqual({ default: own('claude-fable-5-1'), ralph: own('claude-haiku-4-5') });
    expect(projectView(file(), 'fresh')).toEqual({ default: block() });
  });

  it("writes an edited view back under the project's key, touching nothing else", () => {
    const view = projectView(file(), 'loggd');
    setStage(view, 'rafa', 'mapper', { model: 'haiku' }, runtimeStages());
    setStage(view, 'ralph', 'mapper', { model: 'opus' }, runtimeStages());
    const merged = mergeProjectView(file(), 'loggd', view);

    expect(Object.keys(merged)).toEqual(['$comment', 'default', '$comment_loops', 'loggd', 'other']);
    expect(merged.default).toEqual(block());
    expect(merged.other).toEqual(file().other);
    // The inherited default stays inherited: the project gains no copy of it.
    expect(Object.keys(merged.loggd as JsonObject)).toEqual(['ralph', 'rafa']);
    expect(validateConfigText(serializeConfig(merged))).toEqual({ valid: true, problems: [] });
  });

  it("gives the project a default of its own only when the edit changes it", () => {
    const view = projectView(file(), 'fresh');
    setStage(view, 'default', 'mapper', { model: 'haiku' }, runtimeStages());
    const merged = mergeProjectView(file(), 'fresh', view);
    expect(merged.default).toEqual(block());
    expect(((merged.fresh as JsonObject).default as JsonObject).mapper).toEqual({ runner: 'claude', model: 'haiku' });

    const path = scratch(serializeConfig(merged));
    expect(resolveCandidate(path, { RALPH_PROJECT_ID: 'fresh', RALPH_LOOP_NAME: 'nova' }).stages.mapper).toMatchObject({
      model: 'haiku',
      source: 'project',
    });
    expect(resolveCandidate(path, { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'nova' }).stages.mapper).toMatchObject({
      model: 'sonnet',
      source: 'default',
    });
  });

  it('drops a project whose last block is removed', () => {
    const view = projectView(file(), 'loggd');
    removeLoopBlock(view, 'ralph');
    expect(mergeProjectView(file(), 'loggd', view)).not.toHaveProperty('loggd');
  });
});

describe('the CLI validator', () => {
  const validate = (mutate: (config: JsonObject) => void): ValidationResult => {
    const config0 = config();
    mutate(config0);
    return validateConfigText(serializeConfig(config0));
  };

  it('accepts the baseline it is built from', () => {
    expect(validateConfigText(serializeConfig(config()))).toEqual({ valid: true, problems: [] });
  });

  const rejected: Array<[string, (config: JsonObject) => void, RegExp]> = [
    [
      'a runner the stage cannot use',
      (c) => ((c.default as JsonObject).orchestrator = { runner: 'opencode', model: 'gpt-5.6-terra' }),
      /cannot run 'orchestrator'/,
    ],
    [
      'an alias on opencode',
      (c) => ((c.default as JsonObject).executor = { runner: 'opencode', model: 'opus' }),
      /means nothing to the 'opencode' runner/,
    ],
    [
      'a provider/model on codex',
      (c) => ((c.default as JsonObject).mapper = { runner: 'codex', model: 'openai/gpt-5.6-terra' }),
      /codex names a model without a provider prefix/,
    ],
    [
      'an alias for the executor on claude',
      (c) => ((c.default as JsonObject).executor = { runner: 'claude', model: 'sonnet' }),
      /is 'sonnet', an Agent-tool alias/,
    ],
    [
      'a non-Claude id on a claude Agent-tool stage',
      (c) => ((c.default as JsonObject).mapper = { runner: 'claude', model: 'gpt-5.6-terra' }),
      /is a named Claude agent, whose model is one of/,
    ],
    [
      'effort on a stage that takes none',
      (c) => ((c.default as JsonObject).mapper = { runner: 'opencode', model: 'opencode-go/x', effort: 'high' }),
      /sets 'effort' on 'mapper'/,
    ],
    [
      'fallback on a non-read-only stage',
      (c) => ((c.default as JsonObject).executor = { runner: 'opencode', model: 'opencode-go/x', fallback: 'opus' }),
      /sets 'fallback' on 'executor'/,
    ],
    [
      'fallback on a claude-runner stage',
      (c) => ((c.default as JsonObject).mapper = { runner: 'claude', model: 'sonnet', fallback: 'opus' }),
      /runner is already 'claude'/,
    ],
    [
      'fallback naming a non-alias',
      (c) => ((c.default as JsonObject).mapper = { runner: 'codex', model: 'gpt-5.6-terra', fallback: 'claude-opus-5' }),
      /fallback.*opus, sonnet, haiku, fable/s,
    ],
    [
      'a model id with illegal characters',
      (c) => ((c.default as JsonObject).executor = { runner: 'opencode', model: 'opencode-go/a|b' }),
      /characters a model id cannot/,
    ],
    [
      'an incomplete named block',
      (c) => (c.loggd = { rafa: { executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' } } }),
      /models\.json 'loggd\.rafa' is missing 'orchestrator'/,
    ],
    [
      'a loop block outside any project',
      (c) => (c.rafa = block()),
      /models\.json 'rafa' is a loop block outside any project/,
    ],
  ];

  it.each(rejected)('rejects %s with the resolver’s own wording', (_label, mutate, pattern) => {
    const result = validate(mutate);

    expect(result.valid).toBe(false);
    expect(result.problems.join('\n')).toMatch(pattern);
  });

  it('reports every problem at once, not the first', () => {
    const result = validate((c) => {
      const block0 = c.default as JsonObject;
      block0.orchestrator = { runner: 'opencode', model: 'gpt-5.6-terra' };
      block0.executor = { runner: 'opencode', model: 'opus' };
      block0.mapper = { runner: 'claude', model: 'gpt-5.6-terra' };
    });

    expect(result.problems).toHaveLength(3);
  });

  it('fails loudly when the CLI does not answer with its JSON shape', () => {
    // Consume stdin before replying so an early exit cannot race the writer
    // and turn this malformed-response check into a platform-dependent EPIPE.
    const cli = join(dirname(scratch('')), 'invalid-validator.ts');
    writeFileSync(cli, "await Bun.stdin.text(); console.log('not-json');\n");
    expect(() => validateConfigText('{}', { bun: BUN, cli })).toThrow(
      /did not return JSON|unexpected shape/,
    );
  });
});

describe('the atomic writer', () => {
  const change = (mutate: (config: JsonObject) => void): JsonObject => {
    const config0 = config();
    mutate(config0);
    return config0;
  };

  it('commits a validated candidate and leaves no temp file behind', () => {
    const path = scratch(serializeConfig(config()));
    const edited = change((c) => ((c.default as JsonObject).executor = { runner: 'opencode', model: 'opencode-go/kimi-k3' }));

    expect(saveConfig(path, edited)).toEqual({ valid: true, problems: [] });
    expect(resolveCandidate(path).stages).toMatchObject({ executor: { model: 'opencode-go/kimi-k3' } });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('leaves the original intact when validation fails', () => {
    const path = scratch(serializeConfig(config()));
    const before = readFileSync(path, 'utf8');
    const invalid = change((c) => ((c.default as JsonObject).orchestrator = { runner: 'opencode', model: 'gpt-5.6-terra' }));

    const result = saveConfig(path, invalid);

    expect(result.valid).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  // Root bypasses directory permissions, so the failure this test induces
  // would not happen there.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)('leaves the original intact when the temp write fails', () => {
    // A read-only directory is how a full disk or a bad permission fails: the
    // temp file cannot be created, and the original must not be touched.
    const path = scratch(serializeConfig(config()));
    const dir = dirname(path);
    const before = readFileSync(path, 'utf8');
    chmodSync(dir, 0o500);

    try {
      expect(() => writeConfigAtomically(path, '{"default":{}}')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('the change type', () => {
  it('is the form’s vocabulary: the four fields a stage can carry', () => {
    const change: StageChange = { runner: 'claude', model: 'claude-sonnet-5', effort: null, fallback: ['opus'] };
    expect(Object.keys(change)).toEqual(['runner', 'model', 'effort', 'fallback']);
  });
});

describe("a role's stage set reaches the editor through the schema", () => {
  const roleStages = (role: string): string[] =>
    parse<{ stages: string[] }>(runCli(['--schema', '--role', role]).stdout).stages;

  it('builds a new block over exactly the role stages the runtime reports', () => {
    const stages = roleStages('triager');
    expect(stages).toEqual(['orchestrator', 'mapper', 'review.spec']);

    const config0 = config();
    createLoopBlock(config0, 'tria', stages);
    // Complete by the triager's definition of complete, which is what the
    // validator holds a `@triager` or a triager loop's block to.
    expect(Object.keys(config0.tria as JsonObject)).toEqual(['orchestrator', 'mapper', 'review']);
    expect(Object.keys((config0.tria as { review: JsonObject }).review)).toEqual(['spec']);
  });

  it("offers a verifier its orchestrator alone (felipearos/ralph#561)", () => {
    const stages = roleStages('verifier');
    expect(stages).toEqual(['orchestrator']);
    const config0 = config();
    createLoopBlock(config0, 'sent', stages);
    expect(Object.keys(config0.sent as JsonObject)).toEqual(['orchestrator']);
  });

  it('refuses a stage outside the set it was given', () => {
    // The editor holds no legality rule of its own — this is the list the
    // runtime handed it, so a form that offered `executor` to a triager would
    // be refused here rather than writing a block the validator then rejects.
    expect(() => setStage(config(), 'tria', 'executor', { model: 'x' }, roleStages('triager')))
      .toThrow(/unknown stage 'executor'/);
    expect(() => setStage(config(), 'ralph', 'executor', { model: 'opencode-go/x' }, roleStages('coder')))
      .not.toThrow();
  });
});

describe("a project's @role default is not a loop", () => {
  const roleBlock = (): JsonObject => ({
    orchestrator: { runner: 'claude', model: 'claude-sonnet-5' },
    mapper: { runner: 'claude', model: 'haiku' },
    review: { spec: { runner: 'claude', model: 'opus' } },
  });

  it('is left out of a project view and carried through a merge unchanged', () => {
    const file = config({ loggd: { '@triager': roleBlock(), ralph: block() } });
    const view = projectView(file, 'loggd');
    // Not offered as a loop: it is complete over the TRIAGER's stages, so a
    // form would edit it against the wrong set.
    expect(Object.keys(view).sort()).toEqual(['default', 'ralph']);

    const merged = mergeProjectView(file, 'loggd', view) as { loggd: JsonObject };
    expect(merged.loggd['@triager']).toEqual(roleBlock());
    expect(Object.keys(merged.loggd)).toContain('ralph');
  });

  it('cannot be created or completed as a loop block', () => {
    expect(() => createLoopBlock(config(), '@triager', runtimeStages()))
      .toThrow(/role's default lineup, not a loop/);
  });
});
