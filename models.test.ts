// @vitest-environment node
/**
 * The rules the model lineup resolves by.
 *
 * `ralph.test.ts` pins the supervisor's half — that it asks, refuses without
 * an answer, and applies what it gets. This file pins the answer itself, and
 * the three rules that decide it:
 *
 *   - *A loop block replaces the default, it does not merge into it.* Merging
 *     would make "what ran that ticket?" a question you answer by diffing two
 *     blocks; an incomplete block is refused so one block is always the whole
 *     lineup.
 *   - *The environment wins.* A one-off experiment must not need a commit —
 *     and `RALPH_CODER_MODEL`, the executor knob's old name, must keep
 *     meaning what it meant to a start line written before this existed.
 *   - *Structural problems are fatal.* A typo'd stage can silently run the
 *     wrong model everywhere. Usage accounting accepts every model id.
 */
import { describe, expect, it } from 'vitest';

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ModelConfigError,
  collectProblems,
  loadConfig,
  lineupJson,
  listLines,
  migrateConfig,
  renderPrompt,
  schemaJson,
  stagesFor,
  RUNNERS,
  STAGES,
  envNameFor,
  agentsExportLine,
  claudeAgents,
  exportLines,
  resolveLineup,
  runnerEnvNameFor,
  validateConfig,
  type Env,
  type Lineup,
} from './models';
import { type Role } from './roles';
import { loopsProblems } from './project-config';
import { scratchDir } from './test-scratch';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs the models CLI through bash and bun');

const LOGGD_LOOPS = ['ralph', 'rafa', 'remo', 'rulo'] as const;

const DEFAULT_BLOCK = {
  orchestrator: { runner: 'claude', model: 'claude-opus-5', effort: 'medium' },
  executor: { runner: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
  mapper: { runner: 'claude', model: 'sonnet' },
  review: {
    standards: { runner: 'claude', model: 'opus' },
    spec: { runner: 'claude', model: 'opus' },
  },
};

const config = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  $comment: 'JSON cannot hold a comment, so a $-key does — and is not a loop.',
  default: structuredClone(DEFAULT_BLOCK),
  ...extra,
});

const resolve = (options: { config?: Record<string, unknown>; env?: Env } = {}): Lineup =>
  resolveLineup({ config: options.config ?? config(), env: options.env ?? {} });

describe('the default block', () => {
  it('is what a loop without its own block runs', () => {
    const lineup = resolve({ env: { RALPH_LOOP_NAME: 'ralph' } });

    expect(lineup.orchestrator).toMatchObject({ model: 'claude-opus-5', effort: 'medium', source: 'default' });
    expect(lineup.executor!.model).toBe('opencode-go/deepseek-v4-flash');
    expect(lineup['review.spec']!.model).toBe('opus');
  });

  it('is required — nothing falls back to a built-in lineup', () => {
    expect(() => resolveLineup({ config: { rafa: DEFAULT_BLOCK }, env: {} })).toThrow(ModelConfigError);
  });

  it('is not confused by the $-prefixed keys that carry the file’s commentary', () => {
    expect(() => resolve({ env: { RALPH_LOOP_NAME: '$comment' } })).not.toThrow();
  });
});

describe('a loop block', () => {
  it('replaces the default rather than merging into it', () => {
    const lineup = resolve({
      config: config({
        loggd: {
          rafa: {
            orchestrator: { runner: 'claude', model: 'claude-sonnet-5' },
            executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' },
            mapper: { runner: 'claude', model: 'haiku' },
            review: {
              standards: { runner: 'claude', model: 'sonnet' },
              spec: { runner: 'claude', model: 'sonnet' },
            },
          },
        },
      }),
      env: { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'rafa' },
    });

    expect(lineup.orchestrator.model).toBe('claude-sonnet-5');
    expect(lineup.orchestrator.source).toBe('loop');
    // Not inherited from `default`: rafa's block said it, so rafa's block is
    // readable on its own.
    expect(lineup.mapper!.model).toBe('haiku');
    // `effort` is the orchestrator's and rafa did not set one, so there is
    // none — the default block's `medium` does not leak across.
    expect(lineup.orchestrator.effort).toBeUndefined();
  });

  it('is refused when it names only some of the stages', () => {
    expect(() =>
      resolve({
        config: config({ loggd: { rafa: { executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' } } } }),
        env: { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'rafa' },
      }),
    ).toThrow(/missing 'orchestrator'/);
  });

  it('names every missing stage at once, not one per run', () => {
    try {
      resolve({
        config: config({ loggd: { rafa: { orchestrator: { runner: 'claude', model: 'claude-opus-5' } } } }),
        env: { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'rafa' },
      });
      expect.unreachable('an incomplete block must be refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("missing 'executor'");
      expect(message).toContain("missing 'mapper'");
      expect(message).toContain("missing 'review.standards'");
    }
  });
});

describe('project blocks', () => {
  const lineup = (model: string) => ({
    orchestrator: { runner: 'claude', model },
    executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' },
    mapper: { runner: 'claude', model: 'haiku' },
    review: { standards: { runner: 'claude', model: 'sonnet' }, spec: { runner: 'claude', model: 'sonnet' } },
  });
  const keyed = config({
    loggd: { ralph: lineup('claude-sonnet-5'), default: lineup('claude-haiku-4-5') },
    other: { ralph: lineup('claude-fable-5-1') },
  });

  it('resolve project.loop, then project.default, then default', () => {
    const at = (project: string, loop: string) =>
      resolveLineup({ config: keyed, env: { RALPH_PROJECT_ID: project, RALPH_LOOP_NAME: loop } }).orchestrator;
    expect(at('loggd', 'ralph')).toMatchObject({ model: 'claude-sonnet-5', source: 'loop' });
    expect(at('loggd', 'rafa')).toMatchObject({ model: 'claude-haiku-4-5', source: 'project' });
    expect(at('other', 'rafa')).toMatchObject({ model: 'claude-opus-5', source: 'default' });
    expect(at('third', 'ralph')).toMatchObject({ model: 'claude-opus-5', source: 'default' });
  });

  it('let two projects run a loop of the same name on different lineups', () => {
    const ralph = (project: string) => resolveLineup({ config: keyed, env: {}, loopName: 'ralph', project }).orchestrator.model;
    expect(ralph('loggd')).toBe('claude-sonnet-5');
    expect(ralph('other')).toBe('claude-fable-5-1');
  });

  it('still lose to the environment', () => {
    const resolved = resolveLineup({
      config: keyed,
      env: { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'ralph', RALPH_MODEL_ORCHESTRATOR: 'claude-opus-5-5' },
    });
    expect(resolved.orchestrator).toMatchObject({ model: 'claude-opus-5-5', source: 'env' });
    expect(resolved.mapper).toMatchObject({ model: 'haiku', source: 'loop' });
  });

  it('refuse a bare loop block beside them, from the resolver and the validator', () => {
    const mixed = config({ loggd: { ralph: lineup('claude-sonnet-5') }, rafa: lineup('claude-sonnet-5') });
    expect(() => resolveLineup({ config: mixed, env: { RALPH_PROJECT_ID: 'loggd' } })).toThrow(/outside any project: rafa/);
    expect(collectProblems(mixed)).toEqual([expect.stringContaining("models.json 'rafa' is a loop block outside any project")]);
  });

  it('are judged whole, whichever project this process would resolve', () => {
    const problems = collectProblems(config({ other: { rafa: { executor: lineup('x').executor } }, 'Not Ok': {} }));
    expect(problems.join('\n')).toContain("models.json 'other.rafa' is missing 'orchestrator'");
    expect(problems.join('\n')).toContain("models.json 'Not Ok' is not a project id");
  });
});

describe('loop names', () => {
  it('may not be a stage head, or a project block would read as a lineup', () => {
    for (const head of new Set(STAGES.map((stage) => stage.split('.')[0]!))) {
      // `code-context` can never be a loop name at all (one lowercase word),
      // so it is refused by the name rule before the stage rule is asked.
      const why = /^[a-z][a-z0-9]*$/.test(head) ? 'names a stage in models.json' : 'must be one lowercase word';
      expect(loopsProblems([head]), head).toEqual([expect.stringContaining(why)]);
    }
  });
});

describe('the one-time migration', () => {
  const block = (model: string) => ({
    orchestrator: { runner: 'claude', model, effort: 'high' },
    executor: { runner: 'codex', model: 'gpt-6-luna', effort: 'xhigh' },
    mapper: { runner: 'codex', model: 'gpt-6-luna', fallback: ['gpt-6-sol', 'opus'], fallbackEfforts: { 'gpt-6-sol': 'medium' } },
    review: { standards: { runner: 'claude', model: 'opus' }, spec: { runner: 'claude', model: 'opus' } },
  });
  const legacy = {
    $comment: ['keep me'],
    default: structuredClone(DEFAULT_BLOCK),
    $comment_loops: ['and me'],
    ralph: block('claude-opus-5-5'),
    rafa: block('claude-sonnet-5'),
    remo: block('claude-opus-5'),
    rulo: block('claude-haiku-4-5'),
  };
  const scratchFile = (value: unknown): string => {
    const path = join(scratchDir('loggd-models-migrate-'), 'models.json');
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };

  it('moves the top-level loop blocks under loggd, values and order preserved', () => {
    const migrated = migrateConfig(structuredClone(legacy))!;
    expect(Object.keys(migrated)).toEqual(['$comment', 'default', '$comment_loops', 'loggd']);
    expect(migrated.loggd).toEqual({ ralph: legacy.ralph, rafa: legacy.rafa, remo: legacy.remo, rulo: legacy.rulo });
    expect(Object.keys(migrated.loggd as object)).toEqual(['ralph', 'rafa', 'remo', 'rulo']);
    expect(migrated.default).toEqual(legacy.default);
    // Byte for byte in value: each moved block serializes exactly as it did.
    for (const loop of ['ralph', 'rafa', 'remo', 'rulo'] as const) {
      expect(JSON.stringify((migrated.loggd as Record<string, unknown>)[loop])).toBe(JSON.stringify(legacy[loop]));
    }
  });

  it('happens on the first read, on disk, and re-running it is a no-op', () => {
    const path = scratchFile(legacy);
    const first = loadConfig(path);
    const written = readFileSync(path, 'utf8');
    expect(JSON.parse(written)).toEqual(first);
    expect(migrateConfig(first)).toBeNull();

    expect(loadConfig(path)).toEqual(first);
    expect(readFileSync(path, 'utf8')).toBe(written);
    // The lineup each loop ran before is the lineup it runs after.
    for (const loop of ['ralph', 'rafa', 'remo', 'rulo']) {
      const after = resolveLineup({ config: first, env: {}, loopName: loop, project: 'loggd' });
      expect(after.orchestrator.model).toBe((legacy as Record<string, any>)[loop].orchestrator.model);
      expect(after.orchestrator.source).toBe('loop');
    }
  });

  it('leaves a file that already has a loggd block to the validator', () => {
    const mixed = { ...structuredClone(legacy), loggd: {} };
    expect(migrateConfig(mixed)).toBeNull();
    expect(collectProblems(mixed).join('\n')).toContain("models.json 'ralph' is a loop block outside any project");
  });

  it('is what --migrate does, once, and --validate never does', () => {
    const BUN = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
    const CLI = join(__dirname, 'models.ts');
    const path = scratchFile(legacy);
    const before = readFileSync(path, 'utf8');

    const verdict = spawnSync(BUN, [CLI, '--validate', path], { encoding: 'utf8' });
    expect(JSON.parse(verdict.stdout).problems.join('\n')).toContain('outside any project');
    expect(readFileSync(path, 'utf8')).toBe(before);

    const moved = spawnSync(BUN, [CLI, '--migrate', path], { encoding: 'utf8' });
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toContain("moved ralph, rafa, remo, rulo under 'loggd'");
    const again = spawnSync(BUN, [CLI, '--migrate', path], { encoding: 'utf8' });
    expect(again.stdout).toContain('nothing to move');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(migrateConfig(JSON.parse(before)));
  });

  it("resolves --json for the project named by RALPH_PROJECT_ID", () => {
    const BUN = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
    const path = scratchFile(legacy);
    const out = spawnSync(BUN, [join(__dirname, 'models.ts'), '--json', path], {
      encoding: 'utf8',
      env: { ...process.env, RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'rafa' },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ project: 'loggd', loop: 'rafa', stages: { orchestrator: { model: 'claude-sonnet-5', source: 'loop' } } });
  });
});

describe('effort', () => {
  it.each(['orchestrator', 'executor', 'mapper', 'review.standards', 'review.spec'] as const)(
    'resolves, exports and overrides Codex effort for %s independently', (stage) => {
      const file = config();
      const block = file.default as Record<string, unknown>;
      const parts = stage.split('.');
      const parent = parts.length === 2 ? block.review as Record<string, unknown> : block;
      parent[parts.at(-1)!] = { runner: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh' };
      const variable = `RALPH_MODEL_${stage.replaceAll('.', '_').toUpperCase()}_EFFORT`;
      const lineup = resolve({ config: file });
      expect(lineup[stage]!.effort).toBe('xhigh');
      expect(exportLines(lineup)).toContain(`export ${variable}='xhigh'`);
      expect(resolve({ config: file, env: { [variable]: 'high' } })[stage]!.effort).toBe('high');
      expect(resolve({ config: file, env: { [variable]: '' } })[stage]!.effort).toBeUndefined();
    },
  );

  it('renders independent Codex fallback effort and clears primary effort for a default fallback', () => {
    const file = config();
    (file.default as Record<string, unknown>).mapper = {
      runner: 'codex', model: 'gpt-5.6-terra', effort: 'high',
      fallback: ['gpt-5.6-luna', 'gpt-5.6-sol', 'opus'],
      fallbackEfforts: { 'gpt-5.6-luna': 'xhigh' },
    };
    const lineup = resolve({ config: file });
    expect(lineup.mapper!.fallbackEfforts).toEqual({ 'gpt-5.6-luna': 'xhigh' });
    const prompt = renderPrompt('{{RALPH_HOWTO_MAPPER}}', lineup);
    expect(prompt).toContain("RALPH_MODEL_MAPPER=gpt-5.6-luna RALPH_MODEL_MAPPER_EFFORT='xhigh'");
    expect(prompt).toContain("RALPH_MODEL_MAPPER=gpt-5.6-sol RALPH_MODEL_MAPPER_EFFORT=''");
  });

  it.each([
    { 'opus': 'high' },
    { 'gpt-5.6-sol': 'high' },
    { 'gpt-5.6-luna': '' },
    { 'gpt-5.6-luna': 'xhigh; echo unsafe' },
  ])('refuses invalid fallback effort metadata %j', (fallbackEfforts) => {
    const file = config();
    (file.default as Record<string, unknown>).mapper = {
      runner: 'opencode', model: 'opencode-go/test',
      fallback: ['gpt-5.6-luna', 'opus'], fallbackEfforts,
    };
    expect(validateConfig(file).valid).toBe(false);
  });

  it.each(['mapper', 'review.standards', 'review.spec'] as const)(
    'takes effort on the claude runner for %s, because the named agent carries it', (stage) => {
      const file = config();
      const block = file.default as Record<string, unknown>;
      const parts = stage.split('.');
      const parent = parts.length === 2 ? block.review as Record<string, unknown> : block;
      parent[parts.at(-1)!] = { runner: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
      const variable = `RALPH_MODEL_${stage.replaceAll('.', '_').toUpperCase()}_EFFORT`;

      expect(validateConfig(file)).toEqual({ valid: true, problems: [] });
      const lineup = resolve({ config: file });
      expect(lineup[stage]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
      expect(exportLines(lineup)).toContain(`export ${variable}='medium'`);
      expect(resolve({ config: file, env: { [variable]: 'high' } })[stage]!.effort).toBe('high');
    },
  );

  it('refuses effort where nothing would pass it on', () => {
    // opencode has no effort knob, and `delegate.sh` hands a claude executor
    // none — a setting that silently does nothing is refused, not ignored.
    const onOpencode = config();
    (onOpencode.default as Record<string, unknown>).mapper = {
      runner: 'opencode', model: 'opencode-go/deepseek-v4-flash', effort: 'high',
    };
    expect(() => resolve({ config: onOpencode })).toThrow(/sets 'effort' on 'mapper'/);

    const onExecutor = config();
    (onExecutor.default as Record<string, unknown>).executor = {
      runner: 'claude', model: 'claude-opus-5-5', effort: 'high',
    };
    expect(() => resolve({ config: onExecutor })).toThrow(/sets 'effort' on 'executor'/);
  });

  it('clears the primary effort on a Claude fallback route', () => {
    // The route runs through inspect.sh with the stage's variables moved; an
    // inherited Codex `xhigh` must not ride along to the Claude model.
    const file = config();
    (file.default as Record<string, unknown>).mapper = {
      runner: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh', fallback: ['opus'],
    };
    const codexHosted = resolve({ config: file, env: { RALPH_RUNNER_ORCHESTRATOR: 'codex', RALPH_MODEL_ORCHESTRATOR: 'gpt-5.6-sol' } });
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', codexHosted))
      .toContain("RALPH_RUNNER_MAPPER=claude RALPH_MODEL_MAPPER=opus RALPH_MODEL_MAPPER_EFFORT=''");
  });

  it('is overridable on its own, without restating the model', () => {
    const lineup = resolve({ env: { RALPH_MODEL_ORCHESTRATOR_EFFORT: 'high' } });

    expect(lineup.orchestrator.model).toBe('claude-opus-5');
    expect(lineup.orchestrator.effort).toBe('high');
  });

  it('is cleared by an empty override, because some models take none', () => {
    // Haiku 4.5 has no effort parameter and errors on being handed one, so
    // inheriting the block's `medium` would make the environment layer unable
    // to reach it — the one-off switch this layer exists for.
    const lineup = resolve({
      env: { RALPH_MODEL_ORCHESTRATOR: 'claude-haiku-4-5', RALPH_MODEL_ORCHESTRATOR_EFFORT: '' },
    });

    expect(lineup.orchestrator).toMatchObject({ model: 'claude-haiku-4-5', effort: undefined });
  });

  it('still comes from the block when the variable is unset', () => {
    // Only a variable the operator actually set clears it; an absent one is
    // not an opinion.
    expect(resolve({ env: { RALPH_MODEL_ORCHESTRATOR: 'claude-sonnet-5' } }).orchestrator.effort)
      .toBe('medium');
  });
});

describe('the runner', () => {
  it('is required, because a model is only reachable through a harness', () => {
    const broken = config();
    delete (broken.default as Record<string, Record<string, unknown>>).mapper!.runner;

    expect(() => resolve({ config: broken })).toThrow(/'mapper.runner' must be a non-empty string/);
  });

  it('is refused when the stage cannot run on it', () => {
    // The orchestrator is not a model call but a prompt written against this
    // harness's skills, hooks and tools, so it has exactly one runner.
    const broken = config();
    (broken.default as Record<string, Record<string, unknown>>).orchestrator!.runner = 'opencode';

    expect(() => resolve({ config: broken })).toThrow(/cannot run 'orchestrator'/);
  });

  it('is refused when it is not a harness at all', () => {
    const broken = config();
    (broken.default as Record<string, Record<string, unknown>>).mapper!.runner = 'cluade';

    expect(() => resolve({ config: broken })).toThrow(/not a harness this loop knows/);
  });

  it('decides which models are legal, so an alias is refused off the Agent tool', () => {
    // `opus` is the Agent tool's enum, not a model id: it reaches opencode as
    // a model no provider has, and the run dies at the harness.
    const broken = config();
    const block = broken.default as Record<string, Record<string, Record<string, unknown>>>;
    block.review!.standards = { runner: 'opencode', model: 'opus' };

    expect(() => resolve({ config: broken })).toThrow(/means nothing to the 'opencode' runner/);
  });

  it('takes a provider-qualified model on opencode, and a bare one on codex', () => {
    const broken = config();
    const block = broken.default as Record<string, Record<string, unknown>>;

    block.mapper = { runner: 'opencode', model: 'ox-alpha-free' };
    expect(() => resolve({ config: broken })).toThrow(/opencode names a model 'provider\/model'/);

    block.mapper = { runner: 'codex', model: 'openai/gpt-5.6-terra' };
    expect(() => resolve({ config: broken })).toThrow(/codex names a model without a provider prefix/);
  });

  it('lets a stage move harness for one run, model and all', () => {
    const lineup = resolve({
      env: { RALPH_RUNNER_REVIEW_SPEC: 'codex', RALPH_MODEL_REVIEW_SPEC: 'gpt-5.6-terra' },
    });

    expect(lineup['review.spec']).toMatchObject({
      runner: 'codex',
      model: 'gpt-5.6-terra',
      source: 'env',
    });
    // And only that stage moves.
    expect(lineup['review.standards']).toMatchObject({ runner: 'claude', model: 'opus' });
  });

  it('refuses a runner override that strands the block\u2019s model', () => {
    // The likeliest half-done one-off: moving a stage to another harness and
    // leaving it on a model that harness has never heard of. Refused here
    // rather than hours later, at the harness, in someone else's error format.
    expect(() => resolve({ env: { RALPH_RUNNER_MAPPER: 'opencode' } }))
      .toThrow(/leaves 'mapper' on a model it cannot run/);
  });

  it('names its variables after the stages, as the models do', () => {
    expect(STAGES.map(runnerEnvNameFor)).toEqual([
      'RALPH_RUNNER_ORCHESTRATOR',
      'RALPH_RUNNER_EXECUTOR',
      'RALPH_RUNNER_MAPPER',
      'RALPH_RUNNER_REVIEW_STANDARDS',
      'RALPH_RUNNER_REVIEW_SPEC',
      'RALPH_RUNNER_REVIEW_CORRECTNESS',
      'RALPH_RUNNER_CODE_CONTEXT',
    ]);
  });

  it('lets the executor run on claude, as a `claude -p` process with a full model id', () => {
    const lineup = resolve({
      env: { RALPH_RUNNER_EXECUTOR: 'claude', RALPH_MODEL_EXECUTOR: 'claude-sonnet-5' },
    });
    expect(lineup.executor).toMatchObject({ runner: 'claude', model: 'claude-sonnet-5', source: 'env' });
    // Not an Agent call, so no fallback alias is minted for it.
    expect(lineup.executor!.fallback).toBeUndefined();
  });

  it('refuses an alias for the executor on claude, because the ledger books a full id', () => {
    expect(() =>
      resolve({ env: { RALPH_RUNNER_EXECUTOR: 'claude', RALPH_MODEL_EXECUTOR: 'sonnet' } }),
    ).toThrow(/is 'sonnet', an Agent-tool alias.*Name it: claude-sonnet-5/);
    const block = structuredClone(DEFAULT_BLOCK) as Record<string, unknown>;
    block.executor = { runner: 'claude', model: 'opus' };
    expect(() => resolve({ config: config({ loggd: { rafa: block } }), env: { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'rafa' } })).toThrow(
      /'executor\.model' is 'opus', an Agent-tool alias/,
    );
  });

  it('offers only harnesses something dispatches on', () => {
    // A runner nothing dispatches on is a stage that silently does not run —
    // `delegate.sh` knows opencode and claude, `inspect.sh` knows opencode and
    // codex, and `ralph.sh` knows claude.
    expect([...RUNNERS]).toEqual(['claude', 'opencode', 'codex']);
  });
});

describe('the environment layer', () => {
  it('wins over both blocks, so an experiment needs no commit', () => {
    const lineup = resolve({ env: { RALPH_MODEL_EXECUTOR: 'opencode-go/glm-5.3' } });

    expect(lineup.executor).toMatchObject({ model: 'opencode-go/glm-5.3', source: 'env' });
    // And only that stage moves.
    expect(lineup.mapper!.source).toBe('default');
  });

  it('keeps RALPH_CODER_MODEL working, because a start line predates this file', () => {
    const lineup = resolve({ env: { RALPH_CODER_MODEL: 'opencode-go/kimi-k3' } });

    expect(lineup.executor!.model).toBe('opencode-go/kimi-k3');
  });

  it('prefers the new name when both are set', () => {
    const lineup = resolve({
      env: { RALPH_CODER_MODEL: 'opencode-go/kimi-k3', RALPH_MODEL_EXECUTOR: 'opencode-go/glm-5.3' },
    });

    expect(lineup.executor!.model).toBe('opencode-go/glm-5.3');
  });

  it('ignores an empty override rather than resolving to an empty model', () => {
    // `RALPH_MODEL_EXECUTOR= ralph/ralph.sh` is how an operator clears one, and
    // an empty model reaches opencode as a config with no model at all.
    const lineup = resolve({ env: { RALPH_MODEL_EXECUTOR: '   ' } });

    expect(lineup.executor!.model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('names its variables after the stages, with no third spelling to remember', () => {
    expect(STAGES.map(envNameFor)).toEqual([
      'RALPH_MODEL_ORCHESTRATOR',
      'RALPH_MODEL_EXECUTOR',
      'RALPH_MODEL_MAPPER',
      'RALPH_MODEL_REVIEW_STANDARDS',
      'RALPH_MODEL_REVIEW_SPEC',
      'RALPH_MODEL_REVIEW_CORRECTNESS',
      'RALPH_MODEL_CODE_CONTEXT',
    ]);
  });
});

describe('the exports the supervisor evals', () => {
  it('carry every stage, and the effort only when there is one', () => {
    expect(exportLines(resolve())).toEqual([
      "export RALPH_MODEL_ORCHESTRATOR='claude-opus-5'",
      "export RALPH_RUNNER_ORCHESTRATOR='claude'",
      "export RALPH_MODEL_EXECUTOR='opencode-go/deepseek-v4-flash'",
      "export RALPH_RUNNER_EXECUTOR='opencode'",
      "export RALPH_MODEL_MAPPER='sonnet'",
      "export RALPH_RUNNER_MAPPER='claude'",
      "export RALPH_MODEL_REVIEW_STANDARDS='opus'",
      "export RALPH_RUNNER_REVIEW_STANDARDS='claude'",
      "export RALPH_MODEL_REVIEW_SPEC='opus'",
      "export RALPH_RUNNER_REVIEW_SPEC='claude'",
      "export RALPH_MODEL_REVIEW_CORRECTNESS='claude-opus-5-5'",
      "export RALPH_RUNNER_REVIEW_CORRECTNESS='claude'",
      "export RALPH_MODEL_ORCHESTRATOR_EFFORT='medium'",
      "unset RALPH_MODEL_EXECUTOR_EFFORT",
      "unset RALPH_MODEL_MAPPER_EFFORT",
      "unset RALPH_MODEL_REVIEW_STANDARDS_EFFORT",
      "unset RALPH_MODEL_REVIEW_SPEC_EFFORT",
      "export RALPH_MODEL_REVIEW_CORRECTNESS_EFFORT='high'",
      "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_EXECUTOR RALPH_MODEL_MAPPER RALPH_MODEL_REVIEW_STANDARDS RALPH_MODEL_REVIEW_SPEC RALPH_MODEL_REVIEW_CORRECTNESS'",
      "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_EXECUTOR RALPH_RUNNER_MAPPER RALPH_RUNNER_REVIEW_STANDARDS RALPH_RUNNER_REVIEW_SPEC RALPH_RUNNER_REVIEW_CORRECTNESS'",
    ]);
  });

  it('are single-quoted, because the supervisor evals them', () => {
    expect(exportLines(resolve()).every((line) => (/^export [A-Z_]+='[^']*'$/.test(line) || /^unset RALPH_MODEL_[A-Z_]+_EFFORT$/.test(line)))).toBe(true);
  });

  it('emit nothing but exports and one unset, because the supervisor evals them', () => {
    const noEffort = config();
    (noEffort.default as Record<string, unknown>).orchestrator = { runner: 'claude', model: 'claude-opus-5' };

    expect(exportLines(resolve({ config: noEffort })).every(
      (line) => /^export [A-Z_]+='[^']*'$/.test(line) || /^unset RALPH_MODEL_[A-Z_]+_EFFORT$/.test(line),
    )).toBe(true);
  });

  it('unset the effort rather than exporting an empty one', () => {
    // A line either way, so an inherited value cannot survive the eval — but
    // `unset`, not `=''`: the supervisor resolves again to render the prompt,
    // with these exports as its environment, and an empty one would read there
    // as an operator clearing the effort the CLI was just handed.
    const noEffort = config();
    (noEffort.default as Record<string, unknown>).orchestrator = { runner: 'claude', model: 'claude-opus-5' };
    const lines = exportLines(resolve({ config: noEffort }));

    expect(lines).toContain('unset RALPH_MODEL_ORCHESTRATOR_EFFORT');
    expect(lines.some((line) => line.includes("EFFORT=''"))).toBe(false);
  });

  it('carry the stage roster, so the supervisor has no second copy of STAGES', () => {
    const roster = exportLines(resolve()).find((l) => l.startsWith('export RALPH_MODEL_STAGE_VARS='))!;

    expect(roster).toContain(stagesFor('coder').map(envNameFor).join(' '));
  });
});

describe('the Agent-tool stages', () => {
  // On the claude runner these are named subagents whose definition carries
  // the model, so a full Claude id reaches them — unlike an ad-hoc Agent call,
  // whose `model` is an enum of four aliases.
  it('take a full Claude id as well as an alias', () => {
    const file = config();
    (file.default as Record<string, unknown>).mapper = { runner: 'claude', model: 'claude-sonnet-5' };

    expect(resolve({ config: file }).mapper!.model).toBe('claude-sonnet-5');
    expect(resolve({ env: { RALPH_MODEL_REVIEW_SPEC: 'claude-opus-5-5' } })['review.spec']!.model)
      .toBe('claude-opus-5-5');
    expect(resolve()['review.spec']!.model).toBe('opus');
  });

  it('refuse an id that is not Claude\u2019s, from the file or the environment', () => {
    const broken = config();
    (broken.default as Record<string, unknown>).mapper = { runner: 'claude', model: 'gpt-5.6-terra' };

    expect(() => resolve({ config: broken })).toThrow(/is a named Claude agent, whose model is one of/);
    expect(() => resolve({ env: { RALPH_MODEL_REVIEW_SPEC: 'anthropic/claude-opus-5' } })).toThrow(
      /is a named Claude agent, whose model is one of/,
    );
  });

  it('leave the orchestrator free to take either form', () => {
    // `claude --model` accepts an alias or a full name, so neither is refused.
    expect(resolve({ env: { RALPH_MODEL_ORCHESTRATOR: 'claude-opus-5' } }).orchestrator.model)
      .toBe('claude-opus-5');
    expect(resolve({ env: { RALPH_MODEL_ORCHESTRATOR: 'opus' } }).orchestrator.model).toBe('opus');
  });
});

describe('the model id fence', () => {
  // A model id is substituted into an `eval` of generated shell, into the
  // prompt, and into opencode's `{env:…}`. Fenced at the source rather than
  // escaped three times.
  it('refuses characters no model id has', () => {
    expect(() => resolve({ env: { RALPH_MODEL_EXECUTOR: 'a|b' } })).toThrow(/characters a model id cannot/);
    expect(() => resolve({ env: { RALPH_MODEL_EXECUTOR: 'a&b' } })).toThrow(/characters a model id cannot/);
    expect(() => resolve({ env: { RALPH_MODEL_EXECUTOR: "x'; rm -rf /" } })).toThrow(
      /characters a model id cannot/,
    );
  });

  it('accepts every form a real id takes', () => {
    for (const model of ['claude-opus-5', 'claude-opus-5[1m]', 'opencode-go/deepseek-v4-flash']) {
      expect(resolve({ env: { RALPH_MODEL_ORCHESTRATOR: model } }).orchestrator.model).toBe(model);
    }
  });
});

describe('rendering the prompt', () => {
  it('fills every placeholder from the lineup', () => {
    const text = 'orch={{RALPH_MODEL_ORCHESTRATOR}} map={{RALPH_MODEL_MAPPER}} spec={{RALPH_MODEL_REVIEW_SPEC}}';

    expect(renderPrompt(text, resolve())).toBe('orch=claude-opus-5 map=sonnet spec=opus');
  });

  it('renders an absent effort as a phrase, because the prompt is a sentence', () => {
    // The export is an `unset` for the same absence — that one feeds a
    // `[ -n … ]` deciding whether `--effort` is passed at all — but an empty
    // substitution here leaves the prompt reading "effort **** ".
    const noEffort = config();
    (noEffort.default as Record<string, unknown>).orchestrator = { runner: 'claude', model: 'claude-opus-5' };

    expect(renderPrompt('effort=[{{RALPH_MODEL_ORCHESTRATOR_EFFORT}}]', resolve({ config: noEffort })))
      .toBe('effort=[the CLI default]');
    expect(exportLines(resolve({ config: noEffort })))
      .toContain('unset RALPH_MODEL_ORCHESTRATOR_EFFORT');
  });

  it('leaves another tool\u2019s template syntax alone', () => {
    // 34K of markdown may quote somebody else's braces; aborting a run over
    // them is not this file's business. Only its own namespace is policed.
    expect(renderPrompt('keep {{ARG}} and {{lowercase}}', resolve())).toBe('keep {{ARG}} and {{lowercase}}');
  });

  it('refuses a placeholder nothing renders, rather than shipping it as text', () => {
    // Literal `{{RALPH_MODEL_JUDGE}}` reaching the model is how a stage
    // silently loses its configuration: the iteration reads a name that is not
    // a model and picks one itself.
    expect(() => renderPrompt('judge={{RALPH_MODEL_JUDGE}}', resolve())).toThrow(/RALPH_MODEL_JUDGE/);
  });

  it('renders how to invoke a stage, so the prompt carries no conditional', () => {
    // The alternative is prose branching on the runner — "if claude, an Agent
    // call, otherwise a script" — which is how a stage ends up invoked the way
    // the model guessed rather than the way the lineup says.
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', resolve()))
      .toBe('the `ralph-mapper` agent: an `Agent` call with `subagent_type: "ralph-mapper"` and no `model` (it runs sonnet)');

    const moved = resolve({
      env: { RALPH_RUNNER_MAPPER: 'opencode', RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free' },
    });
    const rendered = renderPrompt('{{RALPH_HOWTO_MAPPER}}', moved);
    expect(rendered).toContain('"$RALPH_HOME/inspect.sh" mapper <brief-file>');
    expect(rendered).toContain('opencode-go/ox-alpha-free on opencode');
    // It renders mid-sentence in prompt.md, so it must not close one.
    expect(rendered.endsWith('.')).toBe(false);
  });

  it('names a usable model for the degrade path, which the stage\u2019s own model is not', () => {
    // `inspect.sh` exits 2 when the harness is missing, and the prompt's answer
    // is "make the Agent call yourself" — with WHAT? Not
    // `opencode-go/ox-alpha-free`: the tool's enum refuses it, and the prompt
    // forbids the iteration to pick one mid-iteration. So the sentence carries
    // the alias.
    const moved = resolve({
      env: { RALPH_RUNNER_MAPPER: 'opencode', RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free' },
    });
    expect(moved.mapper!.fallback).toEqual(['opus']);
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', moved)).toContain('exits 2');
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', moved)).toContain('`model: "opus"`');
  });

  it('takes the block\u2019s fallback over the default one', () => {
    const own = config();
    (own.default as Record<string, unknown>).mapper = {
      runner: 'codex',
      model: 'gpt-5.6-terra',
      fallback: 'haiku',
    };
    expect(resolve({ config: own }).mapper!.fallback).toEqual(['haiku']);
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', resolve({ config: own }))).toContain('`model: "haiku"`');
  });

  it('keeps an ordered fallback chain across OpenCode, Codex, and the Agent tool', () => {
    const own = config();
    (own.default as Record<string, unknown>).mapper = {
      runner: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      fallback: ['opencode-go/glm-5.3-flash', 'gpt-5.6-terra', 'opus'],
    };

    const resolved = resolve({ config: own });
    expect(resolved.mapper!.fallback).toEqual([
      'opencode-go/glm-5.3-flash',
      'gpt-5.6-terra',
      'opus',
    ]);
    const rendered = renderPrompt('{{RALPH_HOWTO_MAPPER}}', resolved);
    expect(rendered.indexOf('opencode-go/glm-5.3-flash')).toBeLessThan(rendered.indexOf('gpt-5.6-terra'));
    expect(rendered.indexOf('gpt-5.6-terra')).toBeLessThan(rendered.indexOf('`model: "opus"`'));
    expect(rendered).toContain('exits 2 (unavailable) or 4 (failed)');
  });

  it('refuses duplicate and empty fallback routes', () => {
    const duplicate = config();
    (duplicate.default as Record<string, unknown>).mapper = {
      runner: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      fallback: ['opencode-go/glm-5.3-flash', 'opencode-go/glm-5.3-flash'],
    };
    expect(() => resolve({ config: duplicate })).toThrow(/repeats 'opencode-go\/glm-5.3-flash'/);

    const empty = config();
    (empty.default as Record<string, unknown>).mapper = {
      runner: 'opencode',
      model: 'opencode-go/deepseek-v4.1-flash',
      fallback: [],
    };
    expect(() => resolve({ config: empty })).toThrow(/ordered, non-empty array/);
  });

  it('has no fallback on the claude runner, where the stage IS the Agent call', () => {
    expect(resolve().mapper!.fallback).toBeUndefined();
    // And rendering it there would put a second model in a sentence that
    // already names one.
    expect(renderPrompt('{{RALPH_HOWTO_MAPPER}}', resolve())).toBe('the `ralph-mapper` agent: an `Agent` call with `subagent_type: "ralph-mapper"` and no `model` (it runs sonnet)');
  });

  it('refuses a fallback that is not one of the Agent tool\u2019s aliases', () => {
    // A Claude fallback is still an ad-hoc Agent call, not a named agent: a full
    // id there comes back as an InputValidationError from the tool, hours later.
    const bad = config();
    (bad.default as Record<string, unknown>).mapper = {
      runner: 'codex',
      model: 'gpt-5.6-terra',
      fallback: 'claude-opus-5',
    };
    expect(() => resolve({ config: bad })).toThrow(/mapper.fallback.*Agent call, whose model is one of/s);
  });

  it('refuses a fallback where nothing would read it', () => {
    // Refused rather than ignored, on the same grounds as `effort`: a setting
    // that silently does nothing is worse than one that is rejected.
    const onClaude = config();
    (onClaude.default as Record<string, unknown>).mapper = {
      runner: 'claude',
      model: 'sonnet',
      fallback: 'opus',
    };
    expect(() => resolve({ config: onClaude })).toThrow(/runner is already 'claude'/);

    const onExecutor = config();
    (onExecutor.default as Record<string, unknown>).executor = {
      runner: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      fallback: 'opus',
    };
    expect(() => resolve({ config: onExecutor })).toThrow(/sets 'fallback' on 'executor'/);
  });

  it('has a how-to only for the stages that have a choice', () => {
    // The orchestrator cannot move and the executor is delegate.sh's, so a
    // placeholder for either would be a knob the prompt cannot turn.
    expect(() => renderPrompt('{{RALPH_HOWTO_ORCHESTRATOR}}', resolve())).toThrow(/nothing renders/);
    expect(() => renderPrompt('{{RALPH_HOWTO_EXECUTOR}}', resolve())).toThrow(/nothing renders/);
  });

  it('fills the runner placeholders too', () => {
    expect(renderPrompt('{{RALPH_RUNNER_EXECUTOR}}', resolve())).toBe('opencode');
  });

  it('counts a digit as part of the name, so a numbered stage is caught too', () => {
    // A charset narrower than the names it polices is a hole shaped like the
    // thing it refuses: `{{RALPH_MODEL_JUDGE_2}}` would match neither the
    // substitution nor the leftover check, and ship as literal text.
    expect(() => renderPrompt('judge={{RALPH_MODEL_JUDGE_2}}', resolve())).toThrow(/RALPH_MODEL_JUDGE_2/);
  });

  it('leaves the rest of a 34K prompt alone', () => {
    const text = 'a {{RALPH_MODEL_MAPPER}} b `{{not a placeholder}}` c {braces} d';

    expect(renderPrompt(text, resolve())).toBe('a sonnet b `{{not a placeholder}}` c {braces} d');
  });
});

describe('reading the file', () => {
  const write = (contents: string): string => {
    const path = join(scratchDir('loggd-models-'), 'models.json');
    writeFileSync(path, contents);
    return path;
  };

  it('refuses a file it cannot read, naming the way back', () => {
    expect(() => loadConfig(join(tmpdir(), 'loggd-models-absent', 'models.json'))).toThrow(
      /git -C \S+ checkout -- models\.json/,
    );
  });

  it("sends the operator to the checkout that holds the missing file", () => {
    // An editor pointed at another checkout reads that checkout's lineup; the
    // guidance must restore THAT file, not the harness's own.
    const dir = join(tmpdir(), 'loggd-models-elsewhere');
    expect(() => loadConfig(join(dir, 'models.json'))).toThrow(`git -C ${dir} checkout -- models.json`);
  });

  it('refuses malformed JSON as malformed, not as a missing stage', () => {
    expect(() => loadConfig(write('{ "default": '))).toThrow(/not valid JSON/);
  });

  it('refuses an empty file', () => {
    expect(() => loadConfig(write(''))).toThrow(/not valid JSON/);
  });

  it('refuses a JSON document that is not an object of loop blocks', () => {
    expect(() => loadConfig(write('["claude-opus-5"]'))).toThrow(/keyed by project id/);
  });
});

describe('the checked-in lineup', () => {
  // Which model a stage runs is a knob, not a rule: a day's experiment moves a
  // stage onto another model or another runner, and that must not cost a test
  // edit. What is pinned is what such an edit must not be allowed to break —
  // the file still resolves, and every loop the roster names still answers out
  // of a named block — its own, or its role's. A loop in loggd's roster without
  // one would fall to `default` and run there without anything saying so, which
  // is the silent path the named blocks exist to close.
  const checkedIn = loadConfig();

  it('is a lineup the resolver would accept, with no problems left in it', () => {
    expect(validateConfig(checkedIn)).toEqual({ valid: true, problems: [] });
  });

  it.each(LOGGD_LOOPS)("gives loggd's '%s' a block of its own, complete for every stage", (loop) => {
    expect(Object.keys(checkedIn.loggd as object)).toContain(loop);
    const lineup = resolveLineup({ config: checkedIn, env: { RALPH_LOOP_NAME: loop }, project: 'loggd' });
    for (const stage of stagesFor('coder')) {
      expect(lineup[stage]!.source, `${loop}.${stage}`).toBe('loop');
      expect(RUNNERS, `${loop}.${stage}`).toContain(lineup[stage]!.runner);
      expect(lineup[stage]!.model, `${loop}.${stage}`).not.toBe('');
    }
  });

  // loggd's triager answers out of `@triager`, not out of a block named after
  // the loop. The roster is loggd's, not this repo's, so a `loggd.tria` block
  // of three stages would be judged as an incomplete CODER lineup everywhere
  // the roster cannot be read — which is here, and in the lineup editor on any
  // host without loggd's checkout. The `@role` key carries its own role, so it
  // validates roster-free and serves whatever loggd names its triager.
  it("gives loggd's triager a role block, complete for the three stages it runs", () => {
    expect(Object.keys(checkedIn.loggd as object)).toContain('@triager');
    const lineup = resolveLineup({ config: checkedIn, project: 'loggd', loopName: 'tria', role: 'triager' });

    for (const stage of stagesFor('triager')) {
      expect(lineup[stage]!.source, stage).toBe('role');
      expect(RUNNERS, stage).toContain(lineup[stage]!.runner);
      expect(lineup[stage]!.model, stage).not.toBe('');
    }
  });

  // loggd's ci-doctor answers out of `@ci-doctor` for the same reason the
  // triager does, and over all five stages rather than three: a doctor
  // delegates its fix and reviews the diff exactly as a coder does
  // (`roles.ts` gives the role `[...STAGES]`). Whatever loggd names the loop —
  // `doc`, per felipearos/ralph#164 — the role key serves it without this file
  // having to read loggd's roster.
  it("gives loggd's ci-doctor a role block, complete for all five stages", () => {
    expect(Object.keys(checkedIn.loggd as object)).toContain('@ci-doctor');
    const lineup = resolveLineup({ config: checkedIn, project: 'loggd', loopName: 'doc', role: 'ci-doctor' });

    for (const stage of stagesFor('ci-doctor')) {
      expect(lineup[stage]!.source, stage).toBe('role');
      expect(RUNNERS, stage).toContain(lineup[stage]!.runner);
      expect(lineup[stage]!.model, stage).not.toBe('');
    }
  });

  // loggd's pr-medic answers out of `@pr-medic`, five stages like the doctor,
  // and on a claude orchestrator: the medic's push fence is a rail
  // (`pr-medic/orchestrator-settings.json`) that only a claude session can be
  // handed, so the role refuses to start under codex (felipearos/ralph#249).
  it("gives loggd's pr-medic a role block, complete for all five stages, on a claude orchestrator", () => {
    expect(Object.keys(checkedIn.loggd as object)).toContain('@pr-medic');
    const lineup = resolveLineup({ config: checkedIn, project: 'loggd', loopName: 'medi', role: 'pr-medic' });

    for (const stage of stagesFor('pr-medic')) {
      expect(lineup[stage]!.source, stage).toBe('role');
      expect(RUNNERS, stage).toContain(lineup[stage]!.runner);
      expect(lineup[stage]!.model, stage).not.toBe('');
    }
    expect(lineup.orchestrator!.runner).toBe('claude');
  });
});

describe('the machine-readable surfaces', () => {
  // The extractable line-up editor consumes these across a process boundary,
  // so they are pinned at the boundary — by spawning the real CLI — rather
  // than by calling the same functions the implementation does. A change that
  // keeps the functions green but changes the JSON a consumer reads still
  // fails here.
  const BUN = ((): string => {
    try {
      return execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
    } catch {
      return process.execPath;
    }
  })();
  const CLI = join(__dirname, 'models.ts');

  interface ResolvedStage {
    model: string;
    runner: string;
    effort?: string;
    fallback?: string[];
    source: string;
  }
  interface LineupShape {
    loop: string;
    stages: Record<string, ResolvedStage>;
  }
  interface SchemaShape {
    stages: string[];
    runners: string[];
    runnersFor: Record<string, string[]>;
    agentToolStages: string[];
    agentNames: Record<string, string>;
    claudeIdPrefix: string;
    effortRunnersFor: Record<string, string[]>;
    aliases: string[];
    aliasTargets: Record<string, string>;
    defaultFallback: string;
    defaultFallbacks: string[];
    modelId: { pattern: string; providerPrefix: Record<string, string> };
  }
  interface VerdictShape {
    valid: boolean;
    problems: string[];
  }
  // `JSON.parse` is `any`; these are the shapes the CLI promises.
  const parse = <T>(stdout: string): T => JSON.parse(stdout) as T;

  const scratch = (contents: string): string => {
    const path = join(scratchDir('loggd-models-cli-'), 'models.json');
    writeFileSync(path, contents);
    return path;
  };

  // The runner's own environment may carry a RALPH_* one-off; the surfaces
  // are pinned as a consumer with none set, so `source` is the file's answer.
  const run = (args: string[], input?: string, extraEnv: Record<string, string> = {}) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('RALPH_')) delete env[key];
    return spawnSync(BUN, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...env, ...extraEnv },
      ...(input === undefined ? {} : { input }),
    });
  };

  const valid = JSON.stringify({ $comment: 'keep me', default: DEFAULT_BLOCK });

  it('prints the resolved lineup as JSON with each stage’s source', () => {
    const result = run(['--json', scratch(valid)]);

    expect(result.status, result.stderr).toBe(0);
    const parsed = parse<LineupShape>(result.stdout);
    expect(parsed.loop).toBe('ralph');
    expect(parsed.stages.orchestrator).toEqual({
      model: 'claude-opus-5',
      runner: 'claude',
      effort: 'medium',
      source: 'default',
    });
    expect(parsed.stages.executor).toEqual({
      model: 'opencode-go/deepseek-v4-flash',
      runner: 'opencode',
      source: 'default',
    });
    // Optional fields are absent, not empty strings: a consumer tells "no
    // effort" from "effort: ''" without a second lookup.
    expect(parsed.stages.mapper).not.toHaveProperty('effort');
    expect(parsed.stages.mapper).not.toHaveProperty('fallback');
  });

  it('resolves a candidate path, not only the checked-in file', () => {
    // This is what a preview re-resolves: the edited candidate, before it is
    // written anywhere.
    const config = structuredClone(DEFAULT_BLOCK) as Record<string, unknown>;
    config.orchestrator = { runner: 'claude', model: 'claude-sonnet-5' };
    const parsed = parse<LineupShape>(run(['--json', scratch(JSON.stringify({ default: config }))]).stdout);

    expect(parsed.stages.orchestrator?.model).toBe('claude-sonnet-5');
  });

  it('prints the rules a form constrains with, from what the resolver enforces', () => {
    const schema = parse<SchemaShape>(run(['--schema']).stdout);

    expect(schema.stages).toEqual([...stagesFor('coder')]);
    expect(schema.runners).toEqual([...RUNNERS]);
    expect(schema.runnersFor.orchestrator).toEqual(['claude', 'codex']);
    expect(schema.runnersFor.executor).toEqual(['opencode', 'claude', 'codex']);
    expect(schema.runnersFor.mapper).toEqual(['claude', 'opencode', 'codex']);
    expect(schema.agentToolStages).toEqual(['mapper', 'review.standards', 'review.spec', 'review.correctness']);
    expect(schema.agentNames).toEqual({
      mapper: 'ralph-mapper',
      'review.standards': 'ralph-review-standards',
      'review.spec': 'ralph-review-spec',
      'review.correctness': 'ralph-review-correctness',
    });
    expect(schema.claudeIdPrefix).toBe('claude-');
    expect(schema.effortRunnersFor).toEqual({
      orchestrator: ['claude', 'codex'],
      executor: ['codex'],
      mapper: ['claude', 'codex'],
      'review.standards': ['claude', 'codex'],
      'review.spec': ['claude', 'codex'],
      'review.correctness': ['claude', 'codex'],
    });
    expect(schema.aliases).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(schema.aliasTargets).toEqual({
      opus: 'claude-opus-5-5',
      sonnet: 'claude-sonnet-5-5',
      haiku: 'claude-haiku-5-5',
      fable: 'claude-fable-5-2',
    });
    expect(schema.defaultFallback).toBe('opus');
    expect(schema.defaultFallbacks).toEqual(['opus']);
    expect(schema.modelId.providerPrefix).toEqual({
      claude: 'optional',
      opencode: 'required',
      codex: 'forbidden',
    });
    // The pattern is the fence the validator tests with, so a form applying it
    // refuses exactly the ids the resolver refuses.
    const pattern = new RegExp(schema.modelId.pattern);
    for (const id of ['claude-opus-5', 'claude-opus-5[1m]', 'opencode-go/deepseek-v4-flash']) {
      expect(pattern.test(id), id).toBe(true);
    }
    expect(pattern.test('a|b')).toBe(false);
  });

  it('accepts a valid candidate and says so', () => {
    const result = run(['--validate', scratch(valid)]);

    expect(result.status).toBe(0);
    expect(parse<VerdictShape>(result.stdout)).toEqual({ valid: true, problems: [] });
  });

  it('collects every problem at once, not the first', () => {
    const broken = {
      default: {
        orchestrator: { runner: 'opencode', model: 'claude-opus-5' },
        executor: { runner: 'opencode', model: 'opus' },
        mapper: { runner: 'claude', model: 'gpt-5.6-terra' },
        review: {
          standards: { runner: 'opencode', model: 'no-slash' },
          spec: { runner: 'opencode', model: 'opencode-go/x', effort: 'high' },
        },
      },
    };
    const result = run(['--validate', scratch(JSON.stringify(broken))]);

    expect(result.status).toBe(1);
    const parsed = parse<VerdictShape>(result.stdout);
    const list = parsed.problems.join('\n');
    expect(parsed.valid).toBe(false);
    expect(parsed.problems).toHaveLength(5);
    expect(list).toContain("cannot run 'orchestrator'");
    expect(list).toContain("means nothing to the 'opencode' runner");
    expect(list).toContain('is a named Claude agent');
    expect(list).toContain("opencode names a model 'provider/model'");
    expect(list).toContain("sets 'effort' on 'review.spec'");
  });

  it('reports a broken default and broken named blocks in the same pass', () => {
    // A malformed `default` must not hide the independent problems in a named
    // block: the operator asked for the whole list.
    const result = run(['--validate', scratch(JSON.stringify({ default: null, loggd: { rafa: {} } }))]);

    expect(result.status).toBe(1);
    const list = parse<VerdictShape>(result.stdout).problems.join('\n');
    expect(list).toContain("no 'default' block");
    expect(list).toContain("models.json 'loggd.rafa' is missing 'orchestrator'");
    expect(list).toContain("models.json 'loggd.rafa' is missing 'review.spec'");
  });

  it('reports a named block it is not the one resolving', () => {
    // The editor saves the whole document, so a block this process would never
    // resolve must still be judged before it can reach disk broken.
    const config = {
      default: structuredClone(DEFAULT_BLOCK),
      other: { rafa: { executor: { runner: 'opencode', model: 'opencode-go/kimi-k3' } } },
    };
    const parsed = parse<VerdictShape>(run(['--validate', scratch(JSON.stringify(config))]).stdout);

    expect(parsed.valid).toBe(false);
    expect(parsed.problems.join('\n')).toContain("models.json 'other.rafa' is missing 'orchestrator'");
  });

  it('refuses a malformed document as malformed, not as a missing stage', () => {
    const result = run(['--validate', scratch('{ "default": ')]);

    expect(result.status).toBe(1);
    expect(parse<VerdictShape>(result.stdout).problems.join('\n')).toMatch(/is not valid JSON/);
  });

  it('refuses a root that is not an object of loop blocks', () => {
    const parsed = parse<VerdictShape>(run(['--validate', scratch('["claude-opus-5"]')]).stdout);

    expect(parsed.valid).toBe(false);
    expect(parsed.problems.join('\n')).toContain('keyed by project id');
  });

  it('refuses a missing file with the restore command, not a crash', () => {
    const result = run(['--validate', join(tmpdir(), 'loggd-models-cli-absent', 'models.json')]);

    expect(result.status).toBe(1);
    expect(parse<VerdictShape>(result.stdout).problems.join('\n')).toMatch(/git -C \S+ checkout -- models\.json/);
  });

  it('validates a candidate handed in on stdin', () => {
    const result = run(['--validate', '-'], valid);

    expect(result.status).toBe(0);
    expect(parse<VerdictShape>(result.stdout)).toEqual({ valid: true, problems: [] });
  });

  it('never writes anything while validating', () => {
    const path = scratch(JSON.stringify({ default: structuredClone(DEFAULT_BLOCK) }));
    const before = readFileSync(path, 'utf8');

    run(['--validate', path]);
    run(['--validate', '-'], '{ "default": ');

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dirname(path))).toEqual(['models.json']);
  });

  it('answers --schema and --json for the role the caller names', () => {
    const schema = JSON.parse(run(['--schema', '--role', 'triager']).stdout) as { role: string; stages: string[] };
    expect(schema.role).toBe('triager');
    expect(schema.stages).toEqual(['orchestrator', 'mapper', 'review.spec']);

    const lineup = JSON.parse(run(['--json', scratch(valid), '--role', 'triager']).stdout) as {
      role: string;
      stages: Record<string, unknown>;
    };
    expect(lineup.role).toBe('triager');
    expect(Object.keys(lineup.stages)).toEqual(['orchestrator', 'mapper', 'review.spec']);
  });

  it('refuses a stage the named role does not run, rather than answering from default', () => {
    // `delegate.sh` asks for the executor by name; a triager reaching it must
    // get a refusal, not the coder's executor model.
    const result = run(['executor', '--role', 'triager']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the triager role does not run 'executor'");
    expect(run(['executor', '--role', 'coder']).status).toBe(0);
  });

  it('judges the validated loop by the role --role names, not by the roster', () => {
    // The flag is how a caller states a role the roster cannot tell it: the
    // dashboard validates another project's document from the harness checkout,
    // where that project's roster is not readable at all. Accepting the flag and
    // judging the block as a coder's anyway is how a correct three-stage triager
    // block came back "missing 'executor'" — a refusal telling the operator to
    // add the one stage the resolver would then refuse.
    const candidate = JSON.stringify({
      default: DEFAULT_BLOCK,
      loggd: {
        sift: {
          orchestrator: { runner: 'claude', model: 'claude-sonnet-5' },
          mapper: { runner: 'claude', model: 'haiku' },
          review: { spec: { runner: 'claude', model: 'opus' } },
        },
      },
    });
    const env = { RALPH_PROJECT_ID: 'loggd', RALPH_LOOP_NAME: 'sift' };

    const asTriager = run(['--validate', '-', '--role', 'triager'], candidate, env);
    expect(JSON.parse(asTriager.stdout)).toEqual({ valid: true, problems: [] });
    expect(asTriager.status).toBe(0);

    // Without the flag the roster answers, and this checkout's roster knows no
    // `sift` (its own triager is `tria`), so the block is judged as a coder's —
    // the pre-roles judgement.
    const unnamed = JSON.parse(run(['--validate', '-'], candidate, env).stdout) as { problems: string[] };
    expect(unnamed.problems).toEqual([
      expect.stringContaining("'loggd.sift' is missing 'executor'"),
      expect.stringContaining("'loggd.sift' is missing 'review.standards'"),
    ]);

    // And the role does not become a licence: a stage outside its set is still
    // refused under the flag.
    const withExecutor = JSON.parse(candidate) as { loggd: { sift: Record<string, unknown> } };
    withExecutor.loggd.sift.executor = { runner: 'opencode', model: 'opencode-go/deepseek-v4-flash' };
    const refused = JSON.parse(run(['--validate', '-', '--role', 'triager'], JSON.stringify(withExecutor), env).stdout) as {
      problems: string[];
    };
    expect(refused.problems).toEqual([expect.stringContaining("names 'executor', which a triager loop does not run")]);
  });

  it('prints the usage when --help follows --role', () => {
    const result = run(['--role', 'triager', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: bun');
  });

  it('refuses a --role that is not a role', () => {
    const result = run(['--schema', '--role', 'triagers']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--role takes one of coder, triager, ci-doctor, pr-medic, clerk, verifier');
  });

  // The human surfaces take no path — they read the checked-in file — so they
  // are pinned against what the resolver says about that same file rather than
  // against a model named here, which the next experiment would move.
  it('leaves the human surfaces alone', () => {
    const resolved = resolveLineup({ config: loadConfig(), env: {} });
    expect(run(['mapper', '--runner']).stdout.trim()).toBe(resolved.mapper!.runner);
    expect(run(['--list']).status).toBe(0);
    expect(run(['--export']).status).toBe(0);
  });
});


describe("a role's stage set", () => {
  const TRIAGER_BLOCK = {
    orchestrator: { runner: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    mapper: { runner: 'claude', model: 'haiku' },
    review: { spec: { runner: 'claude', model: 'opus' } },
  };

  const resolveAs = (role: Role, options: { config?: Record<string, unknown>; loopName?: string } = {}): Lineup =>
    resolveLineup({
      config: options.config ?? config({ loggd: { '@triager': structuredClone(TRIAGER_BLOCK) } }),
      env: {},
      loopName: options.loopName ?? 'tria',
      project: 'loggd',
      role,
    });

  it('resolves only the stages the role runs', () => {
    const lineup = resolveAs('triager');
    expect(Object.keys(lineup).sort()).toEqual(['mapper', 'orchestrator', 'review.spec']);
    // Not "resolved from `default` and hidden": the executor is absent, so a
    // caller that reaches for it gets undefined rather than a coder's model.
    expect(lineup.executor).toBeUndefined();
    expect(lineup['review.standards']).toBeUndefined();
  });

  it('leaves a coder with all five, from the same file', () => {
    const lineup = resolveAs('coder', { loopName: 'ralph' });
    expect(Object.keys(lineup).sort()).toEqual([...stagesFor('coder')].sort());
    // The `@triager` block is not a coder's business, whatever it says.
    expect(lineup.orchestrator.model).toBe('claude-opus-5');
    expect(lineup.orchestrator.source).toBe('default');
  });

  // felipearos/ralph#561: a verifier resolves like any role — its orchestrator
  // alone, from the default block until the project gives it one of its own.
  it('resolves a verifier its orchestrator alone, from the default block or `@verifier`', () => {
    const fromDefault = resolveAs('verifier', { loopName: 'sent' });
    expect(Object.keys(fromDefault)).toEqual(['orchestrator']);
    expect(fromDefault.orchestrator.model).toBe('claude-opus-5');
    expect(fromDefault.orchestrator.source).toBe('default');

    // A loop block is held to a coder's five stages by a validator that cannot
    // see the roster, so a verifier's own model is its role default.
    const own = config({ loggd: { '@verifier': { orchestrator: { runner: 'claude', model: 'claude-sonnet-5', effort: 'high' } } } });
    expect(validateConfig(own)).toEqual({ valid: true, problems: [] });
    const fromOwn = resolveAs('verifier', { config: own, loopName: 'sent' });
    expect(fromOwn.orchestrator.model).toBe('claude-sonnet-5');
  });

  // AC 1.
  it('validates a triager block that names exactly its three stages', () => {
    expect(validateConfig(config({ loggd: { '@triager': structuredClone(TRIAGER_BLOCK) } }))).toEqual({
      valid: true,
      problems: [],
    });
  });

  it('refuses a triager block that names a stage the role does not run', () => {
    for (const extra of [
      { executor: { runner: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
      { review: { spec: { runner: 'claude', model: 'opus' }, standards: { runner: 'claude', model: 'opus' } } },
    ]) {
      const block = { ...structuredClone(TRIAGER_BLOCK), ...extra };
      const problems = collectProblems(config({ loggd: { '@triager': block } }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/which a triager loop does not run/);
      expect(problems[0]).toContain('orchestrator, mapper, review.spec');
    }
  });

  it('refuses an out-of-set stage however malformed its value is', () => {
    // Presence, not shape: a typo'd value is the likeliest way an extra stage
    // is written, and a check that looked for a well-formed object would let
    // exactly those through.
    for (const extra of [
      { executor: 'opencode-go/deepseek-v4-flash' },
      { executor: null },
      { review: { spec: { runner: 'claude', model: 'opus' }, standards: 'opus' } },
    ]) {
      const block = { ...structuredClone(TRIAGER_BLOCK), ...extra };
      expect(collectProblems(config({ loggd: { '@triager': block } })))
        .toEqual([expect.stringContaining('which a triager loop does not run')]);
    }
  });

  it('refuses a triager block that is missing one of its three', () => {
    const block = structuredClone(TRIAGER_BLOCK) as Record<string, unknown>;
    delete block.mapper;
    const problems = collectProblems(config({ loggd: { '@triager': block } }));
    expect(problems).toEqual(["models.json 'loggd.@triager' is missing 'mapper'. A block is a complete lineup — name all 3 stages."]);
  });

  it('judges a loop block by the role the caller says the roster gives it', () => {
    const file = config({ loggd: { tria: structuredClone(TRIAGER_BLOCK) } });
    // Without the roster a block is a coder's, which is how every block was
    // judged before roles existed: the three-stage block is then incomplete.
    expect(collectProblems(file)).toEqual([
      "models.json 'loggd.tria' is missing 'executor'. A block is a complete lineup — name all 6 stages.",
      "models.json 'loggd.tria' is missing 'review.standards'. A block is a complete lineup — name all 6 stages.",
    ]);
    expect(collectProblems(file, { loggd: { tria: 'triager' } })).toEqual([]);
  });

  it('holds a default block to every stage, because every role falls back to it', () => {
    // A `default` narrowed to a triager's three would leave a coder with no
    // executor at all, so the narrowing is refused where it is shared.
    const narrowed = { default: structuredClone(TRIAGER_BLOCK) };
    expect(collectProblems(narrowed)).toEqual([
      "models.json 'default' is missing 'executor'. A block is a complete lineup — name all 6 stages.",
      "models.json 'default' is missing 'review.standards'. A block is a complete lineup — name all 6 stages.",
    ]);
    expect(collectProblems(config({ loggd: { default: structuredClone(TRIAGER_BLOCK) } })))
      .toEqual([
        "models.json 'loggd.default' is missing 'executor'. A block is a complete lineup — name all 6 stages.",
        "models.json 'loggd.default' is missing 'review.standards'. A block is a complete lineup — name all 6 stages.",
      ]);
  });

  it('refuses a @key that names no role, wherever it is read', () => {
    const file = config({ loggd: { '@triaging': structuredClone(TRIAGER_BLOCK) } });
    expect(collectProblems(file)).toEqual([
      "models.json 'loggd.@triaging' names no role. A role default is one of: @coder, @triager, @ci-doctor, @pr-medic, @clerk, @verifier, @sentinel.",
    ]);
    // And at resolution, even for a loop that would never read that block.
    expect(() => resolveLineup({ config: file, env: {}, loopName: 'ralph', project: 'loggd' }))
      .toThrow(/'loggd.@triaging' names no role/);
  });

  // AC 2 asks for a test per step of the order, so each step is its own `it`:
  // a failing first step must not hide the three below it.
  const file = (extra: Record<string, unknown>): Record<string, unknown> => config({ loggd: extra });
  const OWN_BLOCK = { ...structuredClone(TRIAGER_BLOCK), orchestrator: { runner: 'claude', model: 'claude-opus-5-5' } };
  const PROJECT_DEFAULT = { ...structuredClone(DEFAULT_BLOCK), orchestrator: { runner: 'claude', model: 'claude-fable-5-1' } };

  it("resolves step 1, the loop's own block, over every default below it", () => {
    const lineup = resolveAs('triager', {
      config: file({ tria: structuredClone(OWN_BLOCK), '@triager': structuredClone(TRIAGER_BLOCK), default: structuredClone(PROJECT_DEFAULT) }),
    });
    expect(lineup.orchestrator).toMatchObject({ model: 'claude-opus-5-5', source: 'loop' });
  });

  it("resolves step 2, the project's @role block, when the loop has none of its own", () => {
    const lineup = resolveAs('triager', {
      config: file({ '@triager': structuredClone(TRIAGER_BLOCK), default: structuredClone(PROJECT_DEFAULT) }),
    });
    expect(lineup.orchestrator).toMatchObject({ model: 'claude-sonnet-5', source: 'role' });
  });

  it("resolves step 3, the project's default, when the role has no block", () => {
    const lineup = resolveAs('triager', { config: file({ default: structuredClone(PROJECT_DEFAULT) }) });
    expect(lineup.orchestrator).toMatchObject({ model: 'claude-fable-5-1', source: 'project' });
  });

  it("resolves step 4, the file's default, when the project has no block at all", () => {
    const lineup = resolveAs('triager', { config: file({}) });
    expect(lineup.orchestrator).toMatchObject({ model: 'claude-opus-5', source: 'default' });
  });

  it('gives the role default to every loop of that role, and to no other', () => {
    const file = config({ loggd: { '@triager': structuredClone(TRIAGER_BLOCK) } });
    for (const loop of ['tria', 'trib']) {
      expect(resolveAs('triager', { config: structuredClone(file), loopName: loop }).orchestrator.source).toBe('role');
    }
    expect(resolveAs('coder', { config: structuredClone(file), loopName: 'ralph' }).orchestrator.source).toBe('default');
  });

  // AC 3.
  it("reports only the role's stages through lineupJson and claudeAgents", () => {
    const lineup = resolveAs('triager');
    const json = lineupJson(lineup, 'tria', 'loggd', 'triager') as { role: string; stages: Record<string, unknown> };
    expect(json.role).toBe('triager');
    expect(Object.keys(json.stages)).toEqual(['orchestrator', 'mapper', 'review.spec']);
    // No `ralph-review-standards` for a role that has no standards axis: a
    // subagent that exists is one the session can call.
    expect(Object.keys(claudeAgents(lineup, 'rails')).sort()).toEqual(['ralph-mapper', 'ralph-review-spec']);
    expect(Object.keys(claudeAgents(resolveAs('coder', { loopName: 'ralph' }), 'rails')).sort())
      .toEqual(['ralph-mapper', 'ralph-review-correctness', 'ralph-review-spec', 'ralph-review-standards']);
  });

  it("exports and lists only the role's stages", () => {
    const lines = exportLines(resolveAs('triager'));
    expect(lines.some((line) => line.includes('RALPH_MODEL_EXECUTOR='))).toBe(false);
    // The roster the supervisor's completeness check loops over is the set this
    // lineup HAS, or it would fail on a variable nothing was going to export.
    expect(lines).toContain(
      "export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_MAPPER RALPH_MODEL_REVIEW_SPEC'",
    );
    expect(lines).toContain(
      "export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_MAPPER RALPH_RUNNER_REVIEW_SPEC'",
    );
    expect(listLines(resolveAs('triager'))).toHaveLength(3);
  });

  it("reports the role's stages through the schema, which is what the editor offers", () => {
    const schema = schemaJson('triager') as {
      role: string;
      stages: string[];
      runnersFor: Record<string, string[]>;
      effortRunnersFor: Record<string, string[]>;
      agentToolStages: string[];
    };
    expect(schema.role).toBe('triager');
    expect(schema.stages).toEqual(['orchestrator', 'mapper', 'review.spec']);
    expect(Object.keys(schema.runnersFor)).toEqual(schema.stages);
    expect(Object.keys(schema.effortRunnersFor)).toEqual(schema.stages);
    expect(schema.agentToolStages).toEqual(['mapper', 'review.spec']);
    // The coder's rules are the ones every current caller already reads.
    expect((schemaJson() as { stages: string[] }).stages).toEqual([...stagesFor('coder')]);
  });

  it('renders a role prompt without the stages it lacks, and refuses one that names them', () => {
    const lineup = resolveAs('triager');
    expect(renderPrompt('map with {{RALPH_MODEL_MAPPER}} on {{RALPH_RUNNER_MAPPER}}', lineup))
      .toBe('map with haiku on claude');
    // A triager template naming the executor is a bug in the template, and the
    // placeholder guard is what makes it one at render rather than a model id
    // the iteration picks for itself.
    expect(() => renderPrompt('delegate to {{RALPH_MODEL_EXECUTOR}}', lineup))
      .toThrow(/\{\{RALPH_MODEL_EXECUTOR\}\}/);
  });
});

describe('Codex across the complete lineup', () => {
  it('resolves all five stages on Codex without removing existing runners', () => {
    const env = Object.fromEntries(stagesFor('coder').flatMap((stage) => [
      [envNameFor(stage), 'gpt-5.6-terra'],
      [runnerEnvNameFor(stage), 'codex'],
    ]));
    const lineup = resolve({ env });
    for (const stage of stagesFor('coder')) expect(lineup[stage]!.runner).toBe('codex');
  });

  it('routes Claude stages and fallbacks through inspect under a Codex orchestrator', () => {
    const lineup = resolve({ config: config(), env: {
      RALPH_RUNNER_ORCHESTRATOR: 'codex', RALPH_MODEL_ORCHESTRATOR: 'gpt-5.6-terra',
      RALPH_RUNNER_REVIEW_SPEC: 'codex', RALPH_MODEL_REVIEW_SPEC: 'gpt-5.6-terra',
    } });
    const prompt = renderPrompt('{{RALPH_HOWTO_MAPPER}} {{RALPH_HOWTO_REVIEW_SPEC}}', lineup);
    expect(prompt).not.toContain('`Agent` call');
    expect(prompt).toContain('inspect.sh');
    expect(prompt).toContain('RALPH_RUNNER_REVIEW_SPEC=claude');
  });
});

describe('the named Claude agents', () => {
  const reviewOn = (model: string, effort?: string): Record<string, unknown> => {
    const file = config();
    const review = (file.default as Record<string, Record<string, unknown>>).review!;
    review.standards = { runner: 'claude', model, ...(effort ? { effort } : {}) };
    review.spec = { runner: 'claude', model, ...(effort ? { effort } : {}) };
    return file;
  };

  it('defines one agent per claude-runner stage, with its model, effort, rails and tool fence', () => {
    const agents = claudeAgents(resolve({ config: reviewOn('claude-opus-5-5', 'medium') }), 'RAILS');

    expect(Object.keys(agents)).toEqual([
      'ralph-mapper',
      'ralph-review-standards',
      'ralph-review-spec',
      'ralph-review-correctness',
    ]);
    expect(agents['ralph-review-standards']).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'medium',
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
    });
    // The inspector rails, behind a preamble that says how this route differs.
    expect(agents['ralph-review-standards']!.prompt).toMatch(/named subagent[\s\S]*\n\nRAILS$/);
    expect(agents['ralph-review-standards']!.description).toMatch(/standards/);
    // No effort configured is no effort key, so the session's own applies.
    expect(agents['ralph-mapper']).toMatchObject({ model: 'sonnet' });
    expect(agents['ralph-mapper']).not.toHaveProperty('effort');
  });

  it('leaves out a stage that runs elsewhere', () => {
    const file = config();
    (file.default as Record<string, unknown>).mapper = { runner: 'opencode', model: 'opencode-go/deepseek-v4-flash' };

    expect(Object.keys(claudeAgents(resolve({ config: file }), 'RAILS')))
      .toEqual(['ralph-review-standards', 'ralph-review-spec', 'ralph-review-correctness']);
  });

  it('defines none under a Codex orchestrator, which reaches Claude through inspect.sh', () => {
    const codexHosted = resolve({
      config: reviewOn('claude-opus-5-5', 'medium'),
      env: { RALPH_RUNNER_ORCHESTRATOR: 'codex', RALPH_MODEL_ORCHESTRATOR: 'gpt-5.6-sol' },
    });

    expect(claudeAgents(codexHosted, 'RAILS')).toEqual({});
    const rendered = renderPrompt('{{RALPH_HOWTO_REVIEW_SPEC}}', codexHosted);
    expect(rendered).toContain('"$RALPH_HOME/inspect.sh" review.spec <brief-file>` (claude-opus-5-5 on claude)');
  });

  it('are what the prompt names, never a model argument', () => {
    const rendered = renderPrompt(
      '{{RALPH_HOWTO_REVIEW_STANDARDS}} | {{RALPH_HOWTO_REVIEW_SPEC}}',
      resolve({ config: reviewOn('claude-opus-5-5', 'medium') }),
    );

    expect(rendered).toContain('`subagent_type: "ralph-review-standards"`');
    expect(rendered).toContain('`subagent_type: "ralph-review-spec"`');
    expect(rendered).toContain('(it runs claude-opus-5-5 at effort medium)');
    expect(rendered).not.toContain('model: "');
  });

  it('are exported as one JSON assignment the supervisor hands to `claude --agents`', () => {
    const line = agentsExportLine(resolve({ config: reviewOn('claude-opus-5-5', 'medium') }), "it's the rails");
    const value = execFileSync('bash', ['-c', `${line}\nprintf '%s' "$RALPH_CLAUDE_AGENTS"`], { encoding: 'utf8' });

    const parsed = JSON.parse(value) as Record<string, { prompt: string; effort?: string }>;
    expect(parsed['ralph-review-spec']).toMatchObject({ effort: 'medium' });
    expect(parsed['ralph-review-spec']!.prompt.endsWith("it's the rails")).toBe(true);
    expect(agentsExportLine(resolve({
      env: { RALPH_RUNNER_ORCHESTRATOR: 'codex', RALPH_MODEL_ORCHESTRATOR: 'gpt-5.6-sol' },
    }), 'RAILS')).toBe("RALPH_CLAUDE_AGENTS=''");
  });
});

describe("the clerk's code-context stage (felipearos/ralph#499)", () => {
  // The model the clerk's code-context iterations run on: its own entry in the
  // lineup, shaped like the orchestrator's, and the clerk's alone. A lineup
  // written before it existed still resolves, to Opus at high effort.
  const CLERK_BLOCK = { orchestrator: { runner: 'claude', model: 'claude-sonnet-5', effort: 'medium' } };
  const asClerk = (extra: Record<string, unknown> = {}, env: Env = {}): Lineup =>
    resolveLineup({ config: config(extra), env, loopName: 'clara', project: 'acme', role: 'clerk' });

  it('defaults to claude-opus-5-5 at high effort when nothing names it', () => {
    expect(asClerk()['code-context']).toEqual({
      model: 'claude-opus-5-5', runner: 'claude', effort: 'high', source: 'default',
      fallback: undefined, fallbackEfforts: undefined,
    });
    // And a `@clerk` block written before the stage existed is not refused for
    // leaving it out: its orchestrator applies, the stage takes the default.
    const lineup = asClerk({ acme: { '@clerk': structuredClone(CLERK_BLOCK) } });
    expect(lineup.orchestrator).toMatchObject({ model: 'claude-sonnet-5', source: 'role' });
    expect(lineup['code-context']).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', source: 'default' });
    expect(validateConfig(config({ acme: { '@clerk': structuredClone(CLERK_BLOCK) } }))).toEqual({ valid: true, problems: [] });
  });

  it("reads the `@clerk` block's `code-context` entry, which replaces the default wholly", () => {
    const block = { ...structuredClone(CLERK_BLOCK), 'code-context': { runner: 'claude', model: 'claude-sonnet-5' } };
    expect(validateConfig(config({ acme: { '@clerk': block } }))).toEqual({ valid: true, problems: [] });
    // No effort named means none, not the default's `high`: a block is read as
    // written rather than merged with what it replaced.
    expect(asClerk({ acme: { '@clerk': block } })['code-context']).toMatchObject({
      model: 'claude-sonnet-5', runner: 'claude', effort: undefined, source: 'role',
    });
    const withEffort = { ...block, 'code-context': { runner: 'claude', model: 'claude-opus-5', effort: 'max' } };
    expect(asClerk({ acme: { '@clerk': withEffort } })['code-context']).toMatchObject({ model: 'claude-opus-5', effort: 'max' });
  });

  it('runs on claude only, because only a claude session carries the clerk rails', () => {
    const block = { ...structuredClone(CLERK_BLOCK), 'code-context': { runner: 'codex', model: 'gpt-5.6-terra' } };
    const problems = collectProblems(config({ acme: { '@clerk': block } }));
    expect(problems).toEqual([expect.stringContaining("'code-context.runner' is 'codex', which cannot run 'code-context'. That stage runs on: claude.")]);
    expect(() => asClerk({}, { RALPH_RUNNER_CODE_CONTEXT: 'opencode' })).toThrow(/RALPH_RUNNER_CODE_CONTEXT is 'opencode'/);
  });

  it('takes the one-off overrides every stage takes, an empty effort clearing it', () => {
    const lineup = asClerk({}, { RALPH_MODEL_CODE_CONTEXT: 'claude-sonnet-5', RALPH_MODEL_CODE_CONTEXT_EFFORT: '' });
    expect(lineup['code-context']).toMatchObject({ model: 'claude-sonnet-5', effort: undefined, source: 'env' });
  });

  it('belongs to the clerk alone: refused in any other role\'s block and in a default', () => {
    const entry = { 'code-context': { runner: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
    const triager = {
      orchestrator: { runner: 'claude', model: 'claude-sonnet-5' },
      mapper: { runner: 'claude', model: 'haiku' },
      review: { spec: { runner: 'claude', model: 'opus' } },
    };
    for (const [label, candidate] of [
      ['a coder loop', config({ loggd: { ralph: { ...structuredClone(DEFAULT_BLOCK), ...entry } } })],
      ['a role default', config({ loggd: { '@triager': { ...triager, ...entry } } })],
      ['the file default', { default: { ...structuredClone(DEFAULT_BLOCK), ...entry } }],
    ] as const) {
      expect(collectProblems(candidate), label).toEqual([expect.stringContaining("names 'code-context', which a")]);
    }
    // And no other role resolves or exports it.
    for (const role of ['coder', 'triager', 'ci-doctor', 'pr-medic'] as const) {
      const lineup = resolveLineup({ config: config(), env: {}, role });
      expect(lineup['code-context'], role).toBeUndefined();
      expect(exportLines(lineup).some((line) => line.includes('CODE_CONTEXT')), role).toBe(false);
    }
  });

  it('is exported for the supervisor as RALPH_MODEL_CODE_CONTEXT and its effort, and listed', () => {
    const lines = exportLines(asClerk());
    expect(lines).toContain("export RALPH_MODEL_CODE_CONTEXT='claude-opus-5-5'");
    expect(lines).toContain("export RALPH_RUNNER_CODE_CONTEXT='claude'");
    expect(lines).toContain("export RALPH_MODEL_CODE_CONTEXT_EFFORT='high'");
    expect(lines).toContain("export RALPH_MODEL_STAGE_VARS='RALPH_MODEL_ORCHESTRATOR RALPH_MODEL_CODE_CONTEXT'");
    expect(lines).toContain("export RALPH_RUNNER_STAGE_VARS='RALPH_RUNNER_ORCHESTRATOR RALPH_RUNNER_CODE_CONTEXT'");
    expect(listLines(asClerk())).toEqual([
      'orchestrator  claude  claude-opus-5 (effort: medium)  [default]',
      'code-context  claude  claude-opus-5-5 (effort: high)  [default]',
    ]);
    // An eval of the exports yields names a shell can hold: no hyphen.
    const value = execFileSync('bash', ['-c', `${lines.join('\n')}\nprintf '%s %s' "$RALPH_MODEL_CODE_CONTEXT" "$RALPH_MODEL_CODE_CONTEXT_EFFORT"`], { encoding: 'utf8' });
    expect(value).toBe('claude-opus-5-5 high');
  });

  it("gives the lineup editor the clerk's two stages and their rules through the schema", () => {
    const schema = schemaJson('clerk') as { stages: string[]; runnersFor: Record<string, string[]>; effortRunnersFor: Record<string, string[]>; agentToolStages: string[] };
    expect(schema.stages).toEqual(['orchestrator', 'code-context']);
    expect(schema.runnersFor['code-context']).toEqual(['claude']);
    expect(schema.effortRunnersFor['code-context']).toEqual(['claude']);
    expect(schema.agentToolStages).toEqual([]);
    expect(lineupJson(asClerk(), 'clara', 'acme', 'clerk')).toMatchObject({
      role: 'clerk',
      stages: { 'code-context': { model: 'claude-opus-5-5', runner: 'claude', effort: 'high', source: 'default' } },
    });
  });

  it('renders no invocation sentence and no agent for it: it is a session, not a subagent', () => {
    expect(claudeAgents(asClerk(), 'RAILS')).toEqual({});
    expect(renderPrompt('{{RALPH_MODEL_CODE_CONTEXT}} on {{RALPH_RUNNER_CODE_CONTEXT}}', asClerk(), undefined, 'clerk'))
      .toBe('claude-opus-5-5 on claude');
  });
});

describe('the correctness review axis', () => {
  // The third pre-PR review, a bug hunt over the diff. Every block written
  // before it existed — including the hand-edited ones on a live host — must
  // keep resolving, so a block may leave it out and then runs Opus at high.

  it('defaults to claude-opus-5-5 at high effort when a block leaves it out', () => {
    expect(validateConfig(config())).toEqual({ valid: true, problems: [] });
    expect(resolve()['review.correctness']).toEqual({
      model: 'claude-opus-5-5', runner: 'claude', effort: 'high', source: 'default',
      fallback: undefined, fallbackEfforts: undefined,
    });
    // A loop block that names its other five stages is not refused for it.
    const lineup = resolveLineup({ config: config({ loggd: { rafa: structuredClone(DEFAULT_BLOCK) } }), env: {}, loopName: 'rafa', project: 'loggd' });
    expect(lineup.orchestrator).toMatchObject({ source: 'loop' });
    expect(lineup['review.correctness']).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', source: 'default' });
  });

  it('reads a block that names it, on any runner a review axis runs on', () => {
    const block = structuredClone(DEFAULT_BLOCK) as Record<string, any>;
    block.review.correctness = { runner: 'opencode', model: 'opencode-go/glm-5.3-flash', fallback: ['opus'] };
    const lineup = resolveLineup({ config: config({ loggd: { rafa: block } }), env: {}, loopName: 'rafa', project: 'loggd' });
    expect(lineup['review.correctness']).toMatchObject({
      model: 'opencode-go/glm-5.3-flash', runner: 'opencode', effort: undefined, source: 'loop', fallback: ['opus'],
    });
  });

  it('is a named agent on a claude lineup, and an inspect.sh route elsewhere', () => {
    const lineup = resolve();
    expect(claudeAgents(lineup, 'RAILS')['ralph-review-correctness']).toMatchObject({
      model: 'claude-opus-5-5', effort: 'high', prompt: expect.stringContaining('RAILS'),
    });
    expect(renderPrompt('{{RALPH_HOWTO_REVIEW_CORRECTNESS}}', lineup)).toContain('subagent_type: "ralph-review-correctness"');
    const external = resolve({ env: { RALPH_RUNNER_REVIEW_CORRECTNESS: 'opencode', RALPH_MODEL_REVIEW_CORRECTNESS: 'opencode-go/glm-5.3-flash' } });
    expect(renderPrompt('{{RALPH_HOWTO_REVIEW_CORRECTNESS}}', external)).toContain('"$RALPH_HOME/inspect.sh" review.correctness <brief-file>');
  });

  it('belongs to the roles that review a diff, never the triager', () => {
    for (const role of ['coder', 'ci-doctor', 'pr-medic'] as const) {
      expect(resolveLineup({ config: config(), env: {}, role })['review.correctness'], role).toBeDefined();
    }
    const triager = resolveLineup({ config: config(), env: {}, role: 'triager' });
    expect(triager['review.correctness']).toBeUndefined();
    expect(Object.keys(claudeAgents(triager, 'RAILS'))).not.toContain('ralph-review-correctness');
    const named = {
      orchestrator: { runner: 'claude', model: 'claude-sonnet-5' },
      mapper: { runner: 'claude', model: 'haiku' },
      review: { spec: { runner: 'claude', model: 'opus' }, correctness: { runner: 'claude', model: 'opus' } },
    };
    expect(collectProblems(config({ loggd: { '@triager': named } }))).toEqual([
      expect.stringContaining("review.correctness"),
    ]);
  });
});
