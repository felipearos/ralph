// @vitest-environment node
/**
 * How long one delegation may run, and what the executor and the orchestrator
 * are told about it.
 *
 * On 2026-09-23 five Codex executor runs were killed at the flat 900s timeout
 * while still iterating (remo #1114 and #1115, rafa #1219 and #1108, ralph
 * #1221), and rafa #1107's orchestrator wrapped `delegate.sh` in its own
 * `timeout 590` and gave up on a run that was nearly done. The budget is now
 * resolved in one place, can be declared per brief, is bounded by a maximum,
 * and comes with a wrap-up point the executor is told about up front.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET_SECONDS,
  DEFAULT_MAX_BUDGET_SECONDS,
  MIN_BRIEF_BUDGET_SECONDS,
  budgetNote,
  declaredBudget,
  orchestratorWaitSeconds,
  resolveBudget,
} from './executor-budget';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs the executor-budget CLI under bun');

const ROOT = dirname(new URL(import.meta.url).pathname);
const scratch: string[] = [];
afterAll(() => scratch.forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('the declared budget in a brief', () => {
  it('reads seconds and minutes from a `Budget:` line', () => {
    expect(declaredBudget('# Slice\n\nBudget: 1800s\n\nDo the thing.')).toBe(1800);
    expect(declaredBudget('Budget: 1800')).toBe(1800);
    expect(declaredBudget('**Budget:** 30m')).toBe(1800);
    expect(declaredBudget('budget: 25 min')).toBe(1500);
  });

  it('is absent when the brief does not declare one', () => {
    expect(declaredBudget('# Slice\n\nKeep the budget of the page small.')).toBeNull();
    expect(declaredBudget('Budget: soon')).toBeNull();
  });
});

describe('resolving the budget', () => {
  it('defaults to a budget longer than the 900s that killed productive runs', () => {
    const budget = resolveBudget({}, '# Slice\n');
    expect(DEFAULT_BUDGET_SECONDS).toBeGreaterThan(900);
    expect(budget).toMatchObject({ seconds: DEFAULT_BUDGET_SECONDS, source: 'default', clamped: false });
    expect(budget.wrapUpSeconds).toBe(Math.floor(DEFAULT_BUDGET_SECONDS * 0.8));
  });

  it('lets the operator move the default with RALPH_DELEGATE_TIMEOUT', () => {
    expect(resolveBudget({ RALPH_DELEGATE_TIMEOUT: '600' }, '')).toMatchObject({ seconds: 600, source: 'env' });
  });

  it('ignores an unusable RALPH_DELEGATE_TIMEOUT', () => {
    expect(resolveBudget({ RALPH_DELEGATE_TIMEOUT: 'forever' }, '')).toMatchObject({
      seconds: DEFAULT_BUDGET_SECONDS,
      source: 'default',
    });
    expect(resolveBudget({ RALPH_DELEGATE_TIMEOUT: '0' }, '').source).toBe('default');
  });

  it('prefers the budget a brief declares', () => {
    expect(resolveBudget({ RALPH_DELEGATE_TIMEOUT: '600' }, 'Budget: 1800s')).toMatchObject({
      seconds: 1800,
      source: 'brief',
      clamped: false,
    });
  });

  it('holds a declared budget to the maximum, and says it did', () => {
    expect(resolveBudget({}, 'Budget: 2h')).toMatchObject({ seconds: DEFAULT_MAX_BUDGET_SECONDS, clamped: true });
    expect(resolveBudget({}, 'Budget: 9999s')).toMatchObject({
      seconds: DEFAULT_MAX_BUDGET_SECONDS,
      source: 'brief',
      clamped: true,
    });
  });

  it('holds a declared budget above a floor, so a typo cannot starve a slice', () => {
    expect(resolveBudget({}, 'Budget: 5s')).toMatchObject({ seconds: MIN_BRIEF_BUDGET_SECONDS, clamped: true });
  });

  it('moves the maximum with RALPH_DELEGATE_MAX_TIMEOUT', () => {
    expect(resolveBudget({ RALPH_DELEGATE_MAX_TIMEOUT: '3600' }, 'Budget: 3000s')).toMatchObject({
      seconds: 3000,
      clamped: false,
      maxSeconds: 3600,
    });
  });

  it('never clamps an operator default below itself', () => {
    const budget = resolveBudget({ RALPH_DELEGATE_TIMEOUT: '5000' }, '');
    expect(budget).toMatchObject({ seconds: 5000, maxSeconds: 5000 });
  });
});

describe('what the executor is told', () => {
  it('names the hard kill, the wrap-up point, and what to do at it', () => {
    const budget = resolveBudget({}, 'Budget: 1000s');
    const note = budgetNote(budget, 1_000_000);
    expect(note).toContain('1000s');
    expect(note).toContain(String(1_000_000 + 1000));
    expect(note).toContain(String(1_000_000 + 800));
    expect(note).toMatch(/date \+%s/);
    expect(note).toMatch(/stop verifying/i);
    expect(note).toMatch(/leave the diff/i);
  });
});

describe('how long the orchestrator must be able to wait', () => {
  it('covers the largest budget a brief can declare, with a margin for the summary', () => {
    expect(orchestratorWaitSeconds({})).toBeGreaterThan(DEFAULT_MAX_BUDGET_SECONDS);
    expect(orchestratorWaitSeconds({ RALPH_DELEGATE_MAX_TIMEOUT: '3600' })).toBeGreaterThan(3600);
  });
});

describe('the command line delegate.sh calls', () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bun', [join(ROOT, 'executor-budget.ts'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, RALPH_DELEGATE_TIMEOUT: '', RALPH_DELEGATE_MAX_TIMEOUT: '', ...env },
    });

  it('prints shell assignments for a brief', () => {
    const folder = mkdtempSync(join(tmpdir(), 'executor-budget-'));
    scratch.push(folder);
    const brief = join(folder, 'brief.md');
    writeFileSync(brief, '# Slice\n\nBudget: 1200s\n');
    const run = cli(['resolve', brief]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('DELEGATE_BUDGET=1200\n');
    expect(run.stdout).toContain('DELEGATE_BUDGET_SOURCE=brief\n');
    expect(run.stdout).toContain('DELEGATE_WRAP_UP=960\n');
    expect(run.stdout).toContain('DELEGATE_WAIT=');
  });

  it('renders the executor note', () => {
    const run = cli(['note', '1200', '960', '1000000']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('1001200');
    expect(run.stdout).toContain('1000960');
  });

  it('prints the orchestrator tool ceiling in milliseconds', () => {
    const run = cli(['orchestrator-wait-ms'], { RALPH_DELEGATE_MAX_TIMEOUT: '3600' });
    expect(run.status).toBe(0);
    expect(Number(run.stdout.trim())).toBe(orchestratorWaitSeconds({ RALPH_DELEGATE_MAX_TIMEOUT: '3600' }) * 1000);
  });

  it('refuses a bad call', () => {
    expect(cli(['resolve']).status).toBe(64);
    expect(cli(['nonsense']).status).toBe(64);
  });
});
