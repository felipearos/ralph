// @vitest-environment node
/**
 * Which stages run an older Claude model, what the operator's answer does to
 * the block, and the CLI the dashboard and `ralph.sh` call (#851).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { MODEL_UPDATE_ANSWERS, MODEL_UPDATE_POLICIES } from './lineup/contracts';
import {
  ANSWERS,
  applyAnswer,
  applyAuto,
  commit,
  newerFor,
  outdatedStages,
  parseClaudeId,
  POLICIES,
  problemsAdded,
  readPolicy,
  SNOOZE_MS,
  updatesReport,
} from './model-updates';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs model-updates.ts through bun');

const LATEST = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
const NOW = Date.parse('2026-11-18T12:00:00Z');

const stage = (model: string, runner = 'claude', effort?: string) => ({ runner, model, ...(effort ? { effort } : {}) });
/** A coder's complete lineup, every Claude stage on `model`. */
const coder = (model: string) => ({
  orchestrator: stage(model, 'claude', 'medium'),
  executor: stage(model),
  mapper: stage('sonnet'),
  review: { standards: stage(model), spec: stage('gpt-5.5', 'codex'), correctness: stage(model, 'claude', 'high') },
});
const triager = (model: string) => ({ orchestrator: stage(model, 'claude', 'medium'), mapper: stage('sonnet') });

const file = () => ({
  $comment: 'kept',
  default: coder('claude-opus-5-5'),
  loggd: {
    testo: coder('claude-opus-5'),
    '@triager': triager('claude-opus-5'),
    ralph: coder('claude-opus-5-5'),
  },
  other: { bo: coder('claude-opus-5') },
});

describe('telling an older id from a current one', () => {
  it('parses family and version, keeping the context suffix and dropping a snapshot date', () => {
    expect(parseClaudeId('claude-opus-5')).toEqual({ family: 'opus', version: [5], suffix: '' });
    expect(parseClaudeId('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', version: [4, 5], suffix: '' });
    expect(parseClaudeId('claude-opus-5[1m]')).toEqual({ family: 'opus', version: [5], suffix: '[1m]' });
    for (const other of ['opus', 'claude-3-5-sonnet', 'opencode/claude-opus-5', 'gpt-5.5']) expect(parseClaudeId(other)).toBeNull();
  });

  it('moves an older id to its family latest, never sideways or down', () => {
    expect(newerFor('claude-opus-5', LATEST)).toBe('claude-opus-5-5');
    expect(newerFor('claude-opus-4-8', LATEST)).toBe('claude-opus-5-5');
    expect(newerFor('claude-haiku-4-5-20251001', LATEST)).toBe('claude-haiku-5-5');
    expect(newerFor('claude-opus-5[1m]', LATEST)).toBe('claude-opus-5-5[1m]');
    expect(newerFor('claude-opus-5-5', LATEST)).toBeNull();
    // A lineup newer than this host's Claude Code is left alone.
    expect(newerFor('claude-opus-6', LATEST)).toBeNull();
    // A family the map does not name, and an alias, are never moved.
    expect(newerFor('claude-fable-5', LATEST)).toBeNull();
    expect(newerFor('opus', LATEST)).toBeNull();
  });

  it('finds only claude-runner stages, nested ones included, in block order', () => {
    expect(outdatedStages(coder('claude-opus-5'), LATEST)).toEqual([
      { stage: 'orchestrator', model: 'claude-opus-5', latest: 'claude-opus-5-5' },
      { stage: 'executor', model: 'claude-opus-5', latest: 'claude-opus-5-5' },
      { stage: 'review.standards', model: 'claude-opus-5', latest: 'claude-opus-5-5' },
      { stage: 'review.correctness', model: 'claude-opus-5', latest: 'claude-opus-5-5' },
    ]);
    // An opencode stage carrying a Claude-looking id is the provider's, not ours.
    expect(outdatedStages({ orchestrator: stage('claude-opus-5', 'opencode') }, LATEST)).toEqual([]);
  });
});

describe('reading a block policy', () => {
  it('is ask when absent and pinned when unreadable, so a bad file never changes a model', () => {
    expect(readPolicy(undefined)).toEqual({ policy: 'ask', skip: [], snoozedUntil: null, malformed: false });
    expect(readPolicy({ policy: 'auto' })).toEqual({ policy: 'auto', skip: [], snoozedUntil: null, malformed: false });
    for (const bad of ['auto', { policy: 'always' }, { skip: 'claude-opus-5-5' }, { snoozedUntil: 'tomorrow' }, []]) {
      expect(readPolicy(bad)).toMatchObject({ policy: 'pinned', malformed: true });
    }
  });
});

describe('the report', () => {
  it("lists the project's blocks after the file's default, and asks only where it should", () => {
    const config = file() as Record<string, unknown>;
    (config.loggd as Record<string, Record<string, unknown>>).ralph!.updates = { policy: 'pinned' };
    const report = updatesReport(config, { latest: LATEST, source: 'test' }, NOW, 'loggd');
    expect(report.latestSource).toBe('test');
    expect(report.agents.map((agent) => [agent.project, agent.block, agent.outdated.length, agent.ask])).toEqual([
      [null, 'default', 0, false],
      ['loggd', 'testo', 4, true],
      ['loggd', '@triager', 1, true],
      ['loggd', 'ralph', 0, false],
    ]);
  });

  it('holds the question while snoozed, and for a skipped id until a newer one ships', () => {
    const config = { default: coder('claude-opus-5-5'), loggd: { tria: triager('claude-opus-5') } };
    const asked = (updates: unknown, latest = LATEST) => {
      const copy = structuredClone(config) as { loggd: { tria: Record<string, unknown> } } & Record<string, unknown>;
      copy.loggd.tria.updates = updates;
      return updatesReport(copy, { latest, source: 'test' }, NOW, 'loggd').agents[1]!.ask;
    };
    expect(asked({ snoozedUntil: new Date(NOW + 1000).toISOString() })).toBe(false);
    expect(asked({ snoozedUntil: new Date(NOW - 1000).toISOString() })).toBe(true);
    expect(asked({ skip: ['claude-opus-5-5'] })).toBe(false);
    expect(asked({ skip: ['claude-opus-5-5'] }, { ...LATEST, opus: 'claude-opus-5-6' })).toBe(true);
    expect(asked({ policy: 'auto' })).toBe(false);
  });
});

describe('answering for one block', () => {
  const testo = { project: 'loggd', block: 'testo' };
  const block = (config: Record<string, unknown>, project: string, name: string) =>
    (config[project] as Record<string, Record<string, unknown>>)[name]!;

  it('update moves every outdated stage and leaves the policy and the other blocks alone', () => {
    const before = file();
    const { config, changes } = applyAnswer(before, testo, 'update', LATEST, NOW);
    expect(changes.map((change) => `${change.stage}:${change.to}`)).toEqual([
      'orchestrator:claude-opus-5-5',
      'executor:claude-opus-5-5',
      'review.standards:claude-opus-5-5',
      'review.correctness:claude-opus-5-5',
    ]);
    expect(block(config, 'loggd', 'testo').orchestrator).toEqual(stage('claude-opus-5-5', 'claude', 'medium'));
    expect(block(config, 'loggd', 'testo').updates).toBeUndefined();
    expect(block(config, 'loggd', '@triager')).toEqual(triager('claude-opus-5'));
    expect(block(config, 'other', 'bo')).toEqual(coder('claude-opus-5'));
    expect(config.$comment).toBe('kept');
    // The input is not touched: the caller writes the copy.
    expect(before.loggd.testo.orchestrator.model).toBe('claude-opus-5');
  });

  it('snooze, skip, pin and ask write the policy and change no model', () => {
    const snoozed = block(applyAnswer(file(), testo, 'snooze', LATEST, NOW).config, 'loggd', 'testo');
    expect(snoozed.updates).toEqual({ policy: 'ask', skip: [], snoozedUntil: new Date(NOW + SNOOZE_MS).toISOString() });
    expect((snoozed.orchestrator as { model: string }).model).toBe('claude-opus-5');

    const skipped = block(applyAnswer(file(), testo, 'skip', LATEST, NOW).config, 'loggd', 'testo');
    expect(skipped.updates).toEqual({ policy: 'ask', skip: ['claude-opus-5-5'], snoozedUntil: null });

    const pinned = applyAnswer(file(), testo, 'pin', LATEST, NOW);
    expect(block(pinned.config, 'loggd', 'testo').updates).toMatchObject({ policy: 'pinned' });
    expect(pinned.changes).toEqual([]);

    const back = applyAnswer(pinned.config, testo, 'ask', LATEST, NOW).config;
    expect(block(back, 'loggd', 'testo').updates).toEqual({ policy: 'ask', skip: [], snoozedUntil: null });
  });

  it('auto moves the block now and marks it for every loop start', () => {
    const { config, changes } = applyAnswer(file(), testo, 'auto', LATEST, NOW);
    expect(changes).toHaveLength(4);
    expect(block(config, 'loggd', 'testo').updates).toEqual({ policy: 'auto', skip: [], snoozedUntil: null });
  });

  it("answers for the file's default, and refuses a block that is not there", () => {
    const config = { default: coder('claude-opus-5'), loggd: {} };
    expect(applyAnswer(config, { project: null, block: 'default' }, 'update', LATEST, NOW).changes).toHaveLength(4);
    expect(() => applyAnswer(config, { project: 'loggd', block: 'nobody' }, 'update', LATEST, NOW)).toThrow(/no block 'loggd.nobody'/);
  });

  it('a malformed policy is replaced by the answer, starting from ask', () => {
    const config = file() as Record<string, unknown>;
    block(config, 'loggd', 'testo').updates = 'whatever';
    expect(block(applyAnswer(config, testo, 'skip', LATEST, NOW).config, 'loggd', 'testo').updates).toEqual({
      policy: 'ask',
      skip: ['claude-opus-5-5'],
      snoozedUntil: null,
    });
  });
});

describe('auto at loop start', () => {
  it("moves the project's auto blocks only, and the file's default when it is auto", () => {
    const config = {
      default: { ...coder('claude-opus-5'), updates: { policy: 'auto' } },
      loggd: {
        testo: { ...coder('claude-opus-5'), updates: { policy: 'auto' } },
        tria: { ...triager('claude-opus-5'), updates: { policy: 'ask' } },
        bad: { ...triager('claude-opus-5'), updates: { policy: 'auto', skip: 3 } },
      },
      other: { bo: { ...coder('claude-opus-5'), updates: { policy: 'auto' } } },
    };
    const { changes } = applyAuto(config, 'loggd', LATEST);
    expect([...new Set(changes.map((change) => `${change.project}.${change.block}`))]).toEqual(['null.default', 'loggd.testo']);
  });
});

describe('the write guard', () => {
  it('refuses only problems the edit added, not the ones the file already had', () => {
    // A triager's own block judged without the roster reads as an incomplete
    // coder's; the file runs, and an id swap must still be writable.
    const before = { default: coder('claude-opus-5-5'), loggd: { tria: triager('claude-opus-5') } };
    const { config: after } = applyAnswer(before, { project: 'loggd', block: 'tria' }, 'update', LATEST, NOW);
    expect(problemsAdded(before, after)).toEqual([]);
    const broken = structuredClone(after) as typeof after & { loggd: { tria: { orchestrator: { model: string } } } };
    broken.loggd.tria.orchestrator.model = '';
    expect(problemsAdded(before, broken).length).toBeGreaterThan(0);
  });
});

describe('writing the file', () => {
  it('re-applies the edit when another writer landed in between, and keeps their change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-model-updates-commit-'));
    const path = join(dir, 'models.json');
    writeFileSync(path, `${JSON.stringify(file(), null, 2)}\n`);
    let calls = 0;
    const { changes } = commit(path, (config) => {
      calls += 1;
      if (calls === 1) {
        // A lineup save arrives while this edit is being worked out.
        const saved = file() as Record<string, unknown> & { loggd: Record<string, unknown> };
        saved.loggd.rafa = coder('claude-opus-5-5');
        writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`);
      }
      return { ...applyAnswer(config, { project: 'loggd', block: 'testo' }, 'update', LATEST, NOW), write: true };
    });
    const written = JSON.parse(readFileSync(path, 'utf8')) as { loggd: Record<string, { orchestrator: { model: string } }> };
    expect(calls).toBe(2);
    expect(changes).toHaveLength(4);
    expect(written.loggd.rafa).toBeDefined();
    expect(written.loggd.testo!.orchestrator.model).toBe('claude-opus-5-5');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing when the file keeps changing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-model-updates-commit-'));
    const path = join(dir, 'models.json');
    writeFileSync(path, `${JSON.stringify(file(), null, 2)}\n`);
    let calls = 0;
    expect(() =>
      commit(path, (config) => {
        calls += 1;
        writeFileSync(path, `${JSON.stringify({ ...file(), $comment: `edit ${calls}` }, null, 2)}\n`);
        return { ...applyAnswer(config, { project: 'loggd', block: 'testo' }, 'pin', LATEST, NOW), write: true };
      }),
    ).toThrow(/kept changing/);
    expect((JSON.parse(readFileSync(path, 'utf8')) as { $comment: string }).$comment).toBe('edit 3');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the lineup contract', () => {
  it('names the same answers and policies as the CLI it narrows', () => {
    // The lineup editor may import no ralph TypeScript, so it keeps its own
    // copy; this is what stops the copy drifting into a narrowing error.
    expect([...MODEL_UPDATE_ANSWERS]).toEqual([...ANSWERS]);
    expect([...MODEL_UPDATE_POLICIES]).toEqual([...POLICIES]);
  });
});

describe('the CLI', () => {
  const scratch: string[] = [];
  afterAll(() => scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  const CLI = join(__dirname, 'model-updates.ts');
  const BUN = (() => {
    try {
      return execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
    } catch {
      return process.execPath;
    }
  })();

  /** A models.json and a HOME whose installed Claude Code bakes `latest`. */
  const host = (config: unknown, latest = LATEST) => {
    const root = mkdtempSync(join(tmpdir(), 'ralph-model-updates-'));
    scratch.push(root);
    const versions = join(root, 'home', '.local', 'share', 'claude', 'versions');
    mkdirSync(versions, { recursive: true });
    const map = Object.entries(latest).map(([family, id]) => `${family}:"${id}"`).join(',');
    writeFileSync(join(versions, '9.0.0'), `junk latest_per_family:{${map}},alias_migration:{} junk`);
    const models = join(root, 'models.json');
    writeFileSync(models, `${JSON.stringify(config, null, 2)}\n`);
    const env = { ...process.env, HOME: join(root, 'home'), PATH: '/usr/bin:/bin' };
    const run = (...args: string[]) => spawnSync(BUN, [CLI, ...args, '--file', models], { encoding: 'utf8', env });
    return { models, run, read: () => JSON.parse(readFileSync(models, 'utf8')) as ReturnType<typeof file> };
  };

  it('--json reports against the installed binary’s latest map', () => {
    const { run } = host(file(), { ...LATEST, opus: 'claude-opus-5-5' });
    const out = run('--json', '--project', 'loggd');
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout) as { latestSource: string; agents: { block: string; ask: boolean }[] };
    expect(report.latestSource).toMatch(/versions\/9\.0\.0$/);
    expect(report.agents.filter((agent) => agent.ask).map((agent) => agent.block)).toEqual(['testo', '@triager']);
  });

  it('--answer writes the block and prints the changes; a bad answer writes nothing', () => {
    const { run, read, models } = host(file());
    const out = run('--answer', 'update', '--project', 'loggd', '--block', '@triager');
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ block: '@triager', changes: [{ stage: 'orchestrator', to: 'claude-opus-5-5' }], agent: { ask: false } });
    expect(read().loggd['@triager'].orchestrator.model).toBe('claude-opus-5-5');
    expect(read().loggd.testo.orchestrator.model).toBe('claude-opus-5');

    const before = readFileSync(models, 'utf8');
    const bad = run('--answer', 'forever', '--project', 'loggd', '--block', 'testo');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--answer takes one of/);
    expect(run('--answer', 'update', '--project', 'loggd').status).toBe(1);
    expect(readFileSync(models, 'utf8')).toBe(before);
  });

  it('--apply-auto prints one line per change and is silent when nothing is auto', () => {
    const config = file() as ReturnType<typeof file> & { loggd: { testo: Record<string, unknown> } };
    const { run, read } = host(config);
    expect(run('--apply-auto', '--project', 'loggd')).toMatchObject({ status: 0, stdout: '' });
    config.loggd.testo.updates = { policy: 'auto' };
    const auto = host(config);
    const out = auto.run('--apply-auto', '--project', 'loggd');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim().split('\n')).toEqual([
      'model-updates: loggd.testo orchestrator: claude-opus-5 → claude-opus-5-5 (auto)',
      'model-updates: loggd.testo executor: claude-opus-5 → claude-opus-5-5 (auto)',
      'model-updates: loggd.testo review.standards: claude-opus-5 → claude-opus-5-5 (auto)',
      'model-updates: loggd.testo review.correctness: claude-opus-5 → claude-opus-5-5 (auto)',
    ]);
    expect(auto.read().loggd.testo.orchestrator.model).toBe('claude-opus-5-5');
    expect(read().loggd.testo.orchestrator.model).toBe('claude-opus-5');
  });

  it('--apply-auto moves nothing on the models.ts fallback, and says so', () => {
    const config = file() as ReturnType<typeof file> & { loggd: { testo: Record<string, unknown> } };
    config.loggd.testo.updates = { policy: 'auto' };
    const { models } = host(config);
    const before = readFileSync(models, 'utf8');
    const out = spawnSync(BUN, [CLI, '--apply-auto', '--project', 'loggd', '--file', models], {
      encoding: 'utf8',
      env: { ...process.env, HOME: join(models, '..', 'nowhere'), PATH: '' },
    });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe('model-updates: auto updates wait for a readable Claude Code binary; nothing was moved.');
    expect(readFileSync(models, 'utf8')).toBe(before);
  });

  it('falls back to models.ts when no Claude Code binary can be read', () => {
    const { run } = host(file());
    const out = execFileSync(BUN, [CLI, '--json', '--file', join(scratch.at(-1)!, 'models.json')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: join(scratch.at(-1)!, 'nowhere'), PATH: '' },
    });
    expect((JSON.parse(out) as { latestSource: string }).latestSource).toMatch(/models\.ts ALIASES/);
    expect(run('--json').status).toBe(0);
  });
});
