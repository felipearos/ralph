// @vitest-environment node
/**
 * Backing off a target that is not moving, instead of spending a model turn on
 * it every minute.
 *
 * Rafa, 2026-09-23 00:16–00:22: the gate said "Rafa PR #1216 to shepherd"
 * seven times running, and seven fresh Opus sessions (~700k tokens each)
 * re-discovered that Vercel was blocking every deployment and ended DONE —
 * which the supervisor reads as "did work, go again". The PR never changed.
 * The ninth ended NEEDS_TRIAGE to stop the spin, and the loop was dead for the
 * night over an outage it could have waited out.
 *
 * These pin the decision: what counts as "no progress", how long each wait is,
 * what wakes one early, and when waiting stops being the answer.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  backoffWait,
  clearedProbe,
  defaultBaseLookup,
  defaultNotify,
  defaultProbeReader,
  EXHAUSTED_RELATIVE_PATH,
  shareBlocker,
  type BaseLookup,
  type ShareDeps,
  delaySeconds,
  derivedBlocker,
  fingerprint,
  isSharedBlockerKey,
  main,
  normaliseBlockerKey,
  parseCiKey,
  parseClearedBy,
  parseConfig,
  parseRestCheck,
  readBlockerFile,
  readProjectRepo,
  readState,
  settle,
  writeState,
  type BackoffConfig,
  type BackoffState,
  type ProbeReader,
  type SharedBlockerView,
  type WaitDeps,
} from './backoff';
import { readStore, withStore } from './blocker-store';
import type { Check, PrSnapshot } from './pr-wait';
import { NOTIFICATION_KINDS } from './push-notification';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('bun backoff.ts settle');

const NOW = '2026-09-23T03:17:00Z';
const config: BackoffConfig = { baseSeconds: 300, maxSeconds: 3600, budgetSeconds: 21600, pollSeconds: 60 };

const snapshot = (overrides: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: 'OPEN',
  mergedAt: null,
  labels: ['dequeued', 'ralph'],
  head: '17bf75b6c',
  checks: [
    { name: 'buildkite/loggd', state: 'pass', url: null },
    { name: 'Vercel', state: 'pass', url: 'https://vercel.com/x' },
  ],
  ...overrides,
});

describe('the PR fingerprint', () => {
  it('is the same for the same PR state, whatever order gh lists things in', () => {
    const a = snapshot();
    const b = snapshot({ labels: ['ralph', 'dequeued'], checks: [...a.checks].reverse() });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('moves on a push, a label, a check or a merge — the things an iteration does to a PR', () => {
    const base = fingerprint(snapshot());
    expect(fingerprint(snapshot({ head: 'abc1234' }))).not.toBe(base);
    expect(fingerprint(snapshot({ labels: ['queued', 'ralph'] }))).not.toBe(base);
    expect(
      fingerprint(snapshot({ checks: [{ name: 'buildkite/loggd', state: 'pending', url: null }] })),
    ).not.toBe(base);
    expect(fingerprint(snapshot({ state: 'MERGED' }))).not.toBe(base);
  });

  it('ignores check URLs, which change on a re-run without the state changing', () => {
    const moved = snapshot({
      checks: [
        { name: 'buildkite/loggd', state: 'pass', url: 'https://buildkite.com/2' },
        { name: 'Vercel', state: 'pass', url: null },
      ],
    });
    expect(fingerprint(moved)).toBe(fingerprint(snapshot()));
  });
});

describe('settling an iteration', () => {
  it('resets on an iteration that changed its shepherd PR', () => {
    const prev = settle(null, { sigil: 'done', pr: 1216, before: 'x', after: 'x', now: NOW });
    expect(prev).not.toBeNull();
    expect(settle(prev, { sigil: 'done', pr: 1216, before: 'x', after: 'y', now: NOW })).toBeNull();
  });

  it('strikes a DONE that left the shepherd PR exactly as it found it', () => {
    const state = settle(null, { sigil: 'done', pr: 1216, before: 'x', after: 'x', now: NOW });
    expect(state).toMatchObject({ reason: 'no-progress', pr: 1216, fingerprint: 'x', strikes: 1, waitedSeconds: 0, since: NOW });
  });

  it('never strikes when the PR could not be read either side — unreadable is not unchanged', () => {
    expect(settle(null, { sigil: 'done', pr: 1216, before: null, after: 'x', now: NOW })).toBeNull();
    expect(settle(null, { sigil: 'done', pr: 1216, before: 'x', after: null, now: NOW })).toBeNull();
  });

  it('never strikes a DONE that had no shepherd target — frontier work is self-limiting', () => {
    expect(settle(null, { sigil: 'done', pr: null, before: null, after: null, now: NOW })).toBeNull();
  });

  it('strikes RETRY_LATER with or without a PR, as an external blocker', () => {
    expect(settle(null, { sigil: 'retry-later', pr: null, before: null, after: null, now: NOW })).toMatchObject({
      reason: 'external',
      pr: null,
      strikes: 1,
    });
    expect(settle(null, { sigil: 'retry-later', pr: 1216, before: 'x', after: 'y', now: NOW })).toMatchObject({
      reason: 'external',
      pr: 1216,
      fingerprint: 'y',
    });
  });

  it('carries the streak and the time already waited across strikes on the same target', () => {
    const first: BackoffState = {
      version: 1,
      reason: 'no-progress',
      pr: 1216,
      fingerprint: 'x',
      strikes: 2,
      waitedSeconds: 900,
      since: '2026-09-23T03:00:00Z',
      blocker: null,
    };
    const next = settle(first, { sigil: 'retry-later', pr: 1216, before: 'x', after: 'x', now: NOW });
    expect(next).toMatchObject({ strikes: 3, waitedSeconds: 900, since: '2026-09-23T03:00:00Z', reason: 'external' });
  });

  it('starts a new streak when the target changes', () => {
    const first: BackoffState = {
      version: 1,
      reason: 'no-progress',
      pr: 1216,
      fingerprint: 'x',
      strikes: 4,
      waitedSeconds: 4500,
      since: '2026-09-23T01:00:00Z',
      blocker: null,
    };
    expect(settle(first, { sigil: 'done', pr: 1220, before: 'z', after: 'z', now: NOW })).toMatchObject({
      pr: 1220,
      strikes: 1,
      waitedSeconds: 0,
      since: NOW,
    });
  });

  it('resets on every other ending', () => {
    const prev = settle(null, { sigil: 'retry-later', pr: null, before: null, after: null, now: NOW });
    expect(settle(prev, { sigil: 'other', pr: null, before: null, after: null, now: NOW })).toBeNull();
  });
});

describe('the wait schedule', () => {
  it('doubles from the base and holds at the ceiling', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map((s) => delaySeconds(s, config))).toEqual([300, 600, 1200, 2400, 3600, 3600, 3600]);
  });

  it('reads its knobs from the environment, and refuses nonsense rather than spinning on it', () => {
    expect(parseConfig({})).toEqual(config);
    expect(
      parseConfig({
        RALPH_BACKOFF_BASE_SECONDS: '1',
        RALPH_BACKOFF_MAX_SECONDS: '4',
        RALPH_BACKOFF_BUDGET_SECONDS: '10',
        RALPH_BACKOFF_POLL_SECONDS: '1',
      }),
    ).toEqual({ baseSeconds: 1, maxSeconds: 4, budgetSeconds: 10, pollSeconds: 1 });
    expect(() => parseConfig({ RALPH_BACKOFF_BASE_SECONDS: '0' })).toThrow(/RALPH_BACKOFF_BASE_SECONDS/);
    expect(() => parseConfig({ RALPH_BACKOFF_POLL_SECONDS: 'soon' })).toThrow(/RALPH_BACKOFF_POLL_SECONDS/);
  });
});

describe('waiting', () => {
  const base: BackoffState = {
    version: 1,
    reason: 'no-progress',
    pr: 1216,
    fingerprint: 'x',
    strikes: 1,
    waitedSeconds: 0,
    since: NOW,
    blocker: null,
  };
  const deps = (reads: (string | null)[]) => {
    const slept: number[] = [];
    let i = 0;
    return {
      slept,
      deps: {
        read: () => reads[Math.min(i++, reads.length - 1)] ?? null,
        sleep: async (s: number) => {
          slept.push(s);
        },
        log: () => {},
      },
    };
  };

  it('sleeps the scheduled delay in poll-sized steps when nothing changes', async () => {
    const { slept, deps: d } = deps(['x']);
    const result = await backoffWait(base, config, d);
    expect(result.outcome).toBe('elapsed');
    expect(slept).toEqual([60, 60, 60, 60, 60]);
    expect(result.state.waitedSeconds).toBe(300);
  });

  it('wakes early when the PR moves, so a fix is picked up within a poll', async () => {
    const { slept, deps: d } = deps(['x', 'x', 'y']);
    const result = await backoffWait(base, config, d);
    expect(result.outcome).toBe('changed');
    expect(slept).toEqual([60, 60, 60]);
    expect(result.state.waitedSeconds).toBe(180);
  });

  it('hands back to the supervisor when an operator command is waiting', async () => {
    const { slept, deps: d } = deps(['x']);
    let checks = 0;
    const result = await backoffWait(base, config, { ...d, controlPending: () => ++checks >= 2 });
    expect(result.outcome).toBe('control');
    expect(slept).toEqual([60, 60]);
    // What was waited still counts against the budget.
    expect(result.state.waitedSeconds).toBe(120);
  });

  it('does not treat an unreadable PR as a change', async () => {
    const { deps: d } = deps([null]);
    expect((await backoffWait(base, config, d)).outcome).toBe('elapsed');
  });

  it('only sleeps when there is no PR to watch', async () => {
    const { slept, deps: d } = deps(['never read']);
    const result = await backoffWait({ ...base, pr: null, fingerprint: null, reason: 'external', strikes: 2 }, config, d);
    expect(result.outcome).toBe('elapsed');
    expect(slept.reduce((a, b) => a + b, 0)).toBe(600);
  });

  it('never sleeps past the budget, and escalates once it is spent', async () => {
    const { slept, deps: d } = deps(['x']);
    const nearlySpent = { ...base, strikes: 9, waitedSeconds: 21500 };
    const last = await backoffWait(nearlySpent, config, d);
    expect(last.outcome).toBe('elapsed');
    expect(slept.reduce((a, b) => a + b, 0)).toBe(100);

    const spent = await backoffWait(last.state, config, deps(['x']).deps);
    expect(spent.outcome).toBe('exhausted');
  });
});

describe('waiting on a shared blocker (#431)', () => {
  const T0 = Date.parse('2026-10-22T06:00:00.000Z');
  const at = (ms: number): string => new Date(ms).toISOString();
  const KEY = normaliseBlockerKey('ci:buildkite/loggd:unit tests');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const waiting = (over: Partial<BackoffState> = {}): BackoffState => ({
    version: 1,
    reason: 'no-progress',
    pr: 12,
    fingerprint: 'x',
    strikes: 1,
    waitedSeconds: 0,
    since: NOW,
    blocker: { key: KEY, summary: 'unit tests red', clearedBy: null, shared: true },
    ...over,
  });
  const view = (over: Partial<SharedBlockerView> = {}): SharedBlockerView => ({
    first: at(T0),
    notified: at(T0),
    exhaustedNotified: null,
    clearedAt: null,
    clearedBy: null,
    baseSha: null,
    baseFailing: null,
    waiters: ['rafa', 'ralph'],
    ...over,
  });
  // Each call answers the next value, the last one repeated; an Error rejects.
  const seq = <T>(...values: (T | Error)[]) => {
    let i = 0;
    return async (): Promise<T> => {
      const value = values[Math.min(i++, values.length - 1)] as T | Error;
      if (value instanceof Error) throw value;
      return value;
    };
  };
  const seam = (
    blocker: () => Promise<SharedBlockerView | null>,
    cleared: (probe: unknown) => Promise<boolean> = async () => false,
  ) => ({
    blocker: vi.fn(blocker),
    markCleared: vi.fn(async () => true),
    markExhausted: vi.fn(async () => true),
    cleared: vi.fn(cleared),
  });
  // The sleep moves the clock, so the age of `first` follows what was slept.
  const deps = (over: Partial<WaitDeps> = {}, reads: (string | null)[] = ['x']) => {
    const slept: number[] = [];
    let i = 0;
    const d: WaitDeps = {
      read: () => reads[Math.min(i++, reads.length - 1)] ?? null,
      sleep: async (s: number) => {
        slept.push(s);
        vi.setSystemTime(Date.now() + s * 1000);
      },
      log: () => {},
      ...over,
    };
    return { slept, d };
  };
  const total = (slept: number[]): number => slept.reduce((a, b) => a + b, 0);

  // Waits until `exhausted`, settling a strike and spending `gap` seconds of
  // iteration between waits, so the age of `first` runs ahead of `waitedSeconds`.
  const walk = async (start: BackoffState, over: Partial<WaitDeps>, gap = 120) => {
    const delays: number[] = [];
    let state = start;
    for (let i = 0; i < 20; i++) {
      const { slept, d } = deps(over);
      const result = await backoffWait(state, config, d);
      if (result.outcome === 'exhausted') return { delays, state: result.state };
      expect(result.outcome).toBe('elapsed');
      delays.push(total(slept));
      vi.setSystemTime(Date.now() + gap * 1000);
      state = { ...result.state, strikes: result.state.strikes + 1 };
    }
    throw new Error('never exhausted');
  };

  it('keeps today’s sequence and budget for a lone waiter, seam or not', async () => {
    const today = [300, 600, 1200, 2400, 3600, 3600, 3600, 3600, 2700];
    const alone = await walk(waiting(), {});
    expect(alone.delays).toEqual(today);
    expect(alone.state.waitedSeconds).toBe(21600);

    vi.setSystemTime(T0);
    const store = seam(async () => view({ notified: null, waiters: ['ralph'] }));
    const seamed = await walk(waiting(), { shared: store });
    expect(seamed.delays).toEqual(today);
    expect(seamed.state.waitedSeconds).toBe(21600);
    expect(store.blocker).toHaveBeenCalled();
    expect(store.cleared).not.toHaveBeenCalled();
    expect(store.markCleared).not.toHaveBeenCalled();
  });

  it('holds a shared wait at the ceiling and spends the budget from the blocker’s first', async () => {
    const { slept, d } = deps({ shared: seam(async () => view()) });
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('elapsed');
    expect(total(slept)).toBe(3600);
    expect(result.state.waitedSeconds).toBe(3600);

    // Joining an hour in inherits that hour: 18000s left, the last wait cut to it.
    vi.setSystemTime(T0);
    const first = at(T0 - 3600 * 1000);
    const joined = await walk(waiting(), { shared: seam(async () => view({ first })) });
    expect(joined.delays).toEqual([3600, 3600, 3600, 3600, 3120]);
  });

  it('does not exhaust a shared wait on a streak older than the episode', async () => {
    const { slept, d } = deps({ shared: seam(async () => view({ first: at(T0 - 300 * 1000) })) });
    const result = await backoffWait(waiting({ strikes: 9, waitedSeconds: 30000 }), config, d);
    expect(result.outcome).toBe('elapsed');
    expect(total(slept)).toBe(3600);
    expect(result.state.waitedSeconds).toBe(33600);
  });

  it('returns to the per-loop wait when one waiter is left, until the episode is spent', async () => {
    const shared = await backoffWait(waiting(), config, deps({ shared: seam(async () => view()) }).d);
    expect(shared.state.waitedSeconds).toBe(3600);

    const lone = seam(async () => view({ waiters: ['ralph'] }));
    const { slept, d } = deps({ shared: lone });
    const after = await backoffWait({ ...shared.state, strikes: 2 }, config, d);
    expect(after.outcome).toBe('elapsed');
    expect(total(slept)).toBe(600);
    expect(after.state.waitedSeconds).toBe(4200);

    // Today's per-loop `left`, cut and then spent.
    const cut = deps({ shared: lone });
    const last = await backoffWait({ ...after.state, strikes: 9, waitedSeconds: 21500 }, config, cut.d);
    expect(total(cut.slept)).toBe(100);
    expect((await backoffWait(last.state, config, deps({ shared: lone }).d)).outcome).toBe('exhausted');

    // A notified episode is spent for its last waiter too.
    const escalated = seam(async () => view({ waiters: ['ralph'], exhaustedNotified: at(T0) }));
    const e = deps({ shared: escalated });
    expect((await backoffWait(waiting(), config, e.d)).outcome).toBe('exhausted');
    expect(e.slept).toEqual([]);
    const old = seam(async () => view({ waiters: ['ralph'], first: at(T0 - 21600 * 1000) }));
    const o = deps({ shared: old });
    expect((await backoffWait(waiting(), config, o.d)).outcome).toBe('exhausted');
    expect(o.slept).toEqual([]);
  });

  it('reads the clear before the fingerprint, and clears for everyone', async () => {
    const store = seam(async () => view(), async () => true);
    const { slept, d } = deps({ shared: store }, ['y']);
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('changed');
    expect(slept).toEqual([60]);
    expect(store.markCleared).toHaveBeenCalledTimes(1);
    expect(store.cleared).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, pr: 12, first: at(T0) }));
  });

  it('ends the other waiter’s wait at its next poll once the episode is cleared, alone or not', async () => {
    const store = seam(seq<SharedBlockerView | null>(view(), view(), view({ clearedAt: at(T0), waiters: ['ralph'] })));
    const { slept, d } = deps({ shared: store });
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('changed');
    expect(slept).toEqual([60, 60]);
    expect(result.state.waitedSeconds).toBe(120);
    expect(store.markCleared).not.toHaveBeenCalled();
  });

  it('does not sleep at all on an episode already cleared', async () => {
    const store = seam(async () => view({ clearedAt: at(T0) }));
    const { slept, d } = deps({ shared: store });
    const result = await backoffWait(waiting({ waitedSeconds: 900 }), config, d);
    expect(result.outcome).toBe('changed');
    expect(slept).toEqual([]);
    expect(result.state.waitedSeconds).toBe(900);
  });

  it('still wakes on the fingerprint when the probe says not cleared', async () => {
    const store = seam(async () => view());
    const { d } = deps({ shared: store }, ['x', 'y']);
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('changed');
    expect(store.cleared).toHaveBeenCalledTimes(2);
    expect(store.markCleared).not.toHaveBeenCalled();
  });

  it('hands a shared wait back to the supervisor on an operator command', async () => {
    const { slept, d } = deps({ shared: seam(async () => view()), controlPending: () => true });
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('control');
    expect(slept).toEqual([60]);
  });

  it('hands back for an operator command that arrived while the probe ran', async () => {
    let pending = false;
    const store = seam(async () => view(), async () => {
      pending = true;
      return false;
    });
    const { slept, d } = deps({ shared: store, controlPending: () => pending });
    const result = await backoffWait(waiting(), config, d);
    expect(result.outcome).toBe('control');
    expect(slept).toEqual([60]);
  });

  it('waits alone when the store cannot be read at the top', async () => {
    const lines: string[] = [];
    const store = seam(async () => {
      throw new Error('store locked');
    });
    const { slept, d } = deps({ shared: store, log: (line) => lines.push(line) });
    const result = await backoffWait(waiting({ strikes: 2 }), config, d);
    expect(result.outcome).toBe('elapsed');
    expect(total(slept)).toBe(600);
    expect(store.cleared).not.toHaveBeenCalled();
    expect(lines.some((line) => line.includes('could not read the shared blocker'))).toBe(true);

    const spent = await backoffWait(waiting({ waitedSeconds: 21600 }), config, deps({ shared: store }).d);
    expect(spent.outcome).toBe('exhausted');
  });

  it('loses only one poll when the store or the probe rejects inside the wait', async () => {
    const flaky = seam(seq<SharedBlockerView | null>(view(), new Error('store locked'), view()), async () => true);
    const a = deps({ shared: flaky });
    const first = await backoffWait(waiting(), config, a.d);
    expect(first.outcome).toBe('changed');
    expect(a.slept).toEqual([60, 60]);

    const probe = seam(async () => view(), seq<boolean>(new Error('gh down'), true));
    const b = deps({ shared: probe });
    const second = await backoffWait(waiting(), config, b.d);
    expect(second.outcome).toBe('changed');
    expect(b.slept).toEqual([60, 60]);
    expect(probe.markCleared).toHaveBeenCalledTimes(1);
  });
});

describe('the state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips, and a missing or corrupt file reads as no backoff', () => {
    const path = join(dir, 'backoff.json');
    expect(readState(path)).toBeNull();
    const state: BackoffState = {
      version: 1,
      reason: 'external',
      pr: null,
      fingerprint: null,
      strikes: 1,
      waitedSeconds: 0,
      since: NOW,
      blocker: null,
    };
    writeState(path, state);
    expect(readState(path)).toEqual(state);
    writeState(path, null);
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, '{"version":1,"strikes":"lots"');
    expect(readState(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...state, strikes: 0 }));
    expect(readState(path)).toBeNull();
    expect(readFileSync(path, 'utf8')).toContain('strikes');
  });
});

describe('the blocker a backoff waits on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-blocker-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const project = (): string => {
    const cwd = join(dir, `project-${++n}`);
    mkdirSync(join(cwd, '.ralph/logs'), { recursive: true });
    return cwd;
  };
  const settleWith = async (cwd: string, file: string): Promise<{ code: number; state: BackoffState | null; lines: string[] }> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['settle', '--sigil', 'retry-later', '--blocker-file', file], {}, cwd);
      const lines = log.mock.calls.map((call) => String(call[0]));
      return { code, state: readState(join(cwd, '.ralph/logs/backoff.json')), lines };
    } finally {
      log.mockRestore();
    }
  };

  it('reads an old state file, written before the field existed, as no blocker', () => {
    const path = join(dir, 'old.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, reason: 'external', pr: null, fingerprint: null, strikes: 2, waitedSeconds: 300, since: NOW }),
    );
    expect(readState(path)).toEqual({
      version: 1,
      reason: 'external',
      pr: null,
      fingerprint: null,
      strikes: 2,
      waitedSeconds: 300,
      since: NOW,
      blocker: null,
    });
  });

  it('reads a malformed blocker in a state file as no blocker, not as a corrupt state', () => {
    const path = join(dir, 'mangled.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, reason: 'external', pr: null, fingerprint: null, strikes: 1, waitedSeconds: 0, since: NOW, blocker: { key: 3 } }),
    );
    expect(readState(path)).toMatchObject({ strikes: 1, blocker: null });
  });

  it('records no blocker, and still backs off, when the blocker file is missing', async () => {
    const cwd = project();
    const { code, state } = await settleWith(cwd, join(cwd, 'nope.json'));
    expect(code).toBe(0);
    expect(state).toMatchObject({ reason: 'external', strikes: 1, blocker: null });
  });

  it('records no blocker when the blocker file is unreadable', async () => {
    const cwd = project();
    const file = join(cwd, 'a-directory');
    mkdirSync(file);
    const { code, state } = await settleWith(cwd, file);
    expect(code).toBe(0);
    expect(state).toMatchObject({ strikes: 1, blocker: null });
  });

  it('records no blocker when the blocker file is malformed JSON', async () => {
    const cwd = project();
    const file = join(cwd, 'retry-blocker.json');
    writeFileSync(file, '{"key": "ci:buildkite/loggd:migr');
    const { code, state } = await settleWith(cwd, file);
    expect(code).toBe(0);
    expect(state).toMatchObject({ strikes: 1, blocker: null });
  });

  it('records no blocker when the key is empty', async () => {
    const cwd = project();
    const file = join(cwd, 'retry-blocker.json');
    writeFileSync(file, JSON.stringify({ key: '   ', summary: 'something', clearedBy: '#1' }));
    const { code, state } = await settleWith(cwd, file);
    expect(code).toBe(0);
    expect(state).toMatchObject({ strikes: 1, blocker: null });
  });

  it('stores a valid blocker file, normalised, and names its summary in the settle line', async () => {
    const cwd = project();
    const file = join(cwd, 'retry-blocker.json');
    writeFileSync(
      file,
      JSON.stringify({
        key: 'ci:buildkite/loggd::database: Production Migrations',
        summary: 'prod migrations red: ledger ahead of main',
        clearedBy: ' #2760 ',
      }),
    );
    const { code, state, lines } = await settleWith(cwd, 'retry-blocker.json');
    expect(code).toBe(0);
    expect(state?.blocker).toEqual({
      key: 'ci:buildkite/loggd:production-migrations',
      summary: 'prod migrations red: ledger ahead of main',
      clearedBy: '#2760',
      shared: true,
    });
    expect(lines.join('\n')).toContain('waiting on: prod migrations red: ledger ahead of main');
  });

  it('keeps the settle line as it was when no blocker is named', async () => {
    const cwd = project();
    const { lines } = await settleWith(cwd, join(cwd, 'nope.json'));
    expect(lines).toEqual([
      'backoff: the iteration ended RETRY_LATER — blocked on something external; backing off instead of re-spawning ' +
        '(strike 1, next check in 300s, 0s of 21600s budget used).',
    ]);
  });

  it('shares only a check with its step, or the reference that clears it', () => {
    const shared = (key: string): boolean | undefined => {
      const path = join(dir, `shared-${++n}.json`);
      writeFileSync(path, JSON.stringify({ key, summary: 's', clearedBy: null }));
      return readBlockerFile(path)?.shared;
    };
    expect(shared('ci:buildkite/loggd:production-migrations')).toBe(true);
    expect(shared('ref:felipearos/loggd#12')).toBe(true);
    expect(shared('vercel-blocked')).toBe(false);
    expect(shared('ci:onlycheck')).toBe(false);
    expect(isSharedBlockerKey('ci:buildkite/loggd:')).toBe(false);
    expect(isSharedBlockerKey('ref:felipearos/loggd#0')).toBe(false);
  });

  it('derives an unshared key from the shepherd PR\'s failing checks, sorted', () => {
    const failing = snapshot({
      checks: [
        { name: 'b', state: 'fail', url: null },
        { name: 'c', state: 'pass', url: null },
        { name: 'a', state: 'fail', url: null },
      ],
    });
    expect(derivedBlocker(1216, failing)).toEqual({
      key: 'check:a+b',
      summary: 'PR #1216 has failing checks: a, b',
      clearedBy: null,
      shared: false,
    });
    expect(derivedBlocker(1216, snapshot())).toBeNull();
  });

  it('normalises two spellings of one cause to one key, and caps its length', () => {
    expect(normaliseBlockerKey('ci:buildkite/loggd::database: Production Migrations')).toBe(
      'ci:buildkite/loggd:production-migrations',
    );
    expect(normaliseBlockerKey('ci:buildkite/loggd:production-migrations')).toBe('ci:buildkite/loggd:production-migrations');
    expect(normaliseBlockerKey(`  REF:Felipearos/Loggd#5 `)).toBe('ref:felipearos/loggd#5');
    expect(normaliseBlockerKey('x'.repeat(200))).toHaveLength(120);
  });

  it('parses what clears it, and leaves anything else unparsed without throwing', () => {
    expect(parseClearedBy('#2760', 'felipearos/loggd')).toEqual({ repo: 'felipearos/loggd', number: 2760 });
    expect(parseClearedBy('#2760', null)).toBeNull();
    expect(parseClearedBy('felipearos/loggd#5', null)).toEqual({ repo: 'felipearos/loggd', number: 5 });
    for (const raw of ['garbage', '#0', '#x', '', null]) expect(parseClearedBy(raw, 'felipearos/loggd')).toBeNull();
  });

  it('reads the project repo from .ralph/config.json, and null on any failure', () => {
    const cwd = project();
    expect(readProjectRepo(cwd)).toBeNull();
    writeFileSync(join(cwd, '.ralph/config.json'), JSON.stringify({ repo: 'felipearos/loggd' }));
    expect(readProjectRepo(cwd)).toBe('felipearos/loggd');
    writeFileSync(join(cwd, '.ralph/config.json'), '{');
    expect(readProjectRepo(cwd)).toBeNull();
  });
});

describe('sharing a blocker with the other loops of the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-share-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const KEY = 'ci:buildkite/loggd:production-migrations';
  const project = (): string => {
    const cwd = join(dir, `project-${++n}`);
    mkdirSync(join(cwd, '.ralph/logs'), { recursive: true });
    return cwd;
  };
  const loopEnv = (loop: string): Record<string, string> => ({
    RALPH_LOOP_NAME: loop,
    RALPH_RUN_ID: `${loop}-run`,
    RALPH_SUPERVISOR_PID: String(process.pid),
  });
  // Every case injects all of these: the default lookup and push spawn, and
  // the default store path is this checkout's live store.
  const harness = (lookup: BaseLookup = () => ({ baseSha: 'abc123', baseFailing: true })) => {
    const storePath = join(dir, `store-${++n}`, 'ralph-blockers.json');
    const pushes: string[][] = [];
    const lookups: string[] = [];
    const deps: ShareDeps = {
      storePath,
      alive: () => true,
      notify: (argv) => {
        pushes.push(argv);
      },
      baseLookup: (key) => {
        lookups.push(key);
        return lookup(key);
      },
    };
    return { storePath, pushes, lookups, deps };
  };
  const blockerFile = (cwd: string, body: Record<string, unknown>): string => {
    const file = join(cwd, 'retry-blocker.json');
    writeFileSync(file, JSON.stringify(body));
    return file;
  };
  const settleAs = async (
    cwd: string,
    env: Record<string, string>,
    deps: ShareDeps,
    args: string[] = ['--sigil', 'retry-later', '--blocker-file', 'retry-blocker.json'],
  ): Promise<{ code: number; state: BackoffState | null; lines: string[] }> => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['settle', ...args], env, cwd, deps);
      const lines = log.mock.calls.map((call) => String(call[0]));
      return { code, state: readState(join(cwd, '.ralph/logs/backoff.json')), lines };
    } finally {
      log.mockRestore();
    }
  };
  const loopOn = (loop: string, body: Record<string, unknown> = { key: KEY, summary: 'prod migrations red' }) => {
    const cwd = project();
    blockerFile(cwd, body);
    return { cwd, env: loopEnv(loop) };
  };
  const state = (pr: number | null, key: string, clearedBy: string | null = null, shared = true): BackoffState => ({
    version: 1,
    reason: 'external',
    pr,
    fingerprint: null,
    strikes: 1,
    waitedSeconds: 0,
    since: NOW,
    blocker: { key, summary: 'prod migrations red', clearedBy, shared },
  });

  it('joins a shared blocker under the loop name, with its PR, pid and host, and pushes nothing alone', async () => {
    const h = harness();
    const rafa = loopOn('rafa');
    const { code, lines } = await settleAs(rafa.cwd, rafa.env, h.deps);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
    const waiter = readStore(h.storePath).blockers[KEY]?.waiters.rafa;
    expect(waiter).toMatchObject({ loop: 'rafa', pr: null, pid: process.pid });
    expect(waiter?.host).toMatch(/\S/);

    // The shepherd PR comes from the settled state.
    expect(await shareBlocker(null, state(12, KEY), loopEnv('ralph'), project(), h.deps)).toEqual([]);
    expect(readStore(h.storePath).blockers[KEY]?.waiters.ralph?.pr).toBe(12);
  });

  it('never joins a shared:false blocker, nor looks up the base for it', async () => {
    const h = harness();
    const locked: string[] = [];
    const spy: typeof withStore = (path, critical, alive) => {
      locked.push(path);
      return withStore(path, critical, alive);
    };
    const rafa = loopOn('rafa', { key: 'vercel-blocked', summary: 'vercel is down' });
    const { code, state: written, lines } = await settleAs(rafa.cwd, rafa.env, { ...h.deps, withStore: spy });
    expect(code).toBe(0);
    expect(written?.blocker).toMatchObject({ key: 'vercel-blocked', shared: false });
    expect(lines).toHaveLength(1);
    expect(locked).toEqual([]);
    expect(h.lookups).toEqual([]);
    expect(readStore(h.storePath).blockers).toEqual({});

    // The supervisor-derived key, which names a check but not its step.
    const derived = derivedBlocker(1216, snapshot({ checks: [{ name: 'buildkite/loggd', state: 'fail', url: null }] }));
    const unshared: BackoffState = { ...state(1216, 'unused'), blocker: derived };
    expect(await shareBlocker(null, unshared, loopEnv('ralph'), project(), { ...h.deps, withStore: spy })).toEqual([]);
    expect(locked).toEqual([]);
    expect(h.lookups).toEqual([]);
    expect(readStore(h.storePath).blockers).toEqual({});
  });

  it('escalates once, on the second loop to wait, and never on the third or fourth', async () => {
    const h = harness();
    expect(NOTIFICATION_KINDS).toContain('shared-blocker');
    for (const loop of ['ralph', 'rafa']) {
      const l = loopOn(loop);
      expect((await settleAs(l.cwd, l.env, h.deps)).lines).toHaveLength(1);
    }
    expect(h.pushes).toHaveLength(1);
    const first = readStore(h.storePath).blockers[KEY]?.first;
    const argv = h.pushes[0] as string[];
    expect(argv.slice(0, 5)).toEqual(['push', '--kind', 'shared-blocker', '--occurrence', `shared-blocker:${KEY}:${first}`]);
    expect(argv[5]).toBe('--subject');
    expect(argv[6]).toMatch(/\S/);
    expect(argv[6]).not.toContain('\n');
    expect(argv[7]).toBe('--body');
    expect(argv[8]).toMatch(/\S/);
    expect(argv.slice(9)).toEqual(['--priority', 'high']);
    expect(argv).toHaveLength(11);

    for (const loop of ['rita', 'tria']) {
      const l = loopOn(loop);
      await settleAs(l.cwd, l.env, h.deps);
    }
    expect(h.pushes).toHaveLength(1);
    expect(Object.keys(readStore(h.storePath).blockers[KEY]?.waiters ?? {})).toHaveLength(4);
  });

  it('records the base branch the lookup read when the episode opened', async () => {
    const h = harness(() => ({ baseSha: 'deadbeef', baseFailing: true }));
    const rafa = loopOn('rafa');
    await settleAs(rafa.cwd, rafa.env, h.deps);
    expect(h.lookups).toEqual([KEY]);
    expect(readStore(h.storePath).blockers[KEY]).toMatchObject({ baseSha: 'deadbeef', baseFailing: true });
  });

  it('records the base as not known when the lookup throws, and still joins and settles', async () => {
    const h = harness(() => {
      throw new Error('gh is down');
    });
    const rafa = loopOn('rafa');
    const { code, state: written, lines } = await settleAs(rafa.cwd, rafa.env, h.deps);
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^backoff: /);
    expect(written).toMatchObject({ strikes: 1, blocker: { key: KEY, shared: true } });
    expect(readStore(h.storePath).blockers[KEY]).toMatchObject({ baseSha: null, baseFailing: null });
    expect(readStore(h.storePath).blockers[KEY]?.waiters.rafa).toBeDefined();
  });

  it('never looks up the base on a settle that only leaves', async () => {
    const h = harness();
    const rafa = loopOn('rafa');
    await settleAs(rafa.cwd, rafa.env, h.deps);
    expect(h.lookups).toHaveLength(1);
    await settleAs(rafa.cwd, rafa.env, h.deps, ['--sigil', 'other']);
    expect(h.lookups).toHaveLength(1);
    expect(readStore(h.storePath).blockers).toEqual({});
  });

  it('names the summary, every waiter with its PR, and what clears it when one join said', async () => {
    const h = harness();
    await shareBlocker(null, state(12, KEY), loopEnv('rafa'), project(), h.deps);
    await shareBlocker(null, state(null, KEY, '#2760'), loopEnv('ralph'), project(), h.deps);
    const body = h.pushes[0]?.[8] ?? '';
    expect(body).toContain('prod migrations red');
    expect(body).toContain('rafa (PR #12)');
    expect(body).toContain('ralph (no PR)');
    expect(body).toContain('#2760');
  });

  it('names no clearing reference when no join supplied one', async () => {
    const h = harness();
    await shareBlocker(null, state(12, KEY), loopEnv('rafa'), project(), h.deps);
    await shareBlocker(null, state(7, KEY), loopEnv('ralph'), project(), h.deps);
    const body = h.pushes[0]?.[8] ?? '';
    expect(body).toContain('rafa (PR #12)');
    expect(body).toContain('ralph (PR #7)');
    expect(body).not.toMatch(/clear/i);
  });

  it('pushes only after the store lock is released', async () => {
    const h = harness();
    const seen: boolean[] = [];
    const deps: ShareDeps = { ...h.deps, notify: () => void seen.push(existsSync(`${h.storePath}.lock`)) };
    await shareBlocker(null, state(12, KEY), loopEnv('rafa'), project(), deps);
    await shareBlocker(null, state(7, KEY), loopEnv('ralph'), project(), deps);
    expect(seen).toEqual([false]);
  });

  it('spawns the scripts RALPH_BACKOFF_BASE_LOOKUP and RALPH_PUSH_CLI name, under bun', async () => {
    const cwd = project();
    const lookup = join(cwd, 'lookup.ts');
    writeFileSync(lookup, 'console.log("noise");\nconsole.log(JSON.stringify({ baseSha: "f00d", baseFailing: process.argv[2]?.startsWith("ci:") ?? null }));\n');
    expect(await defaultBaseLookup({ ...process.env, RALPH_BACKOFF_BASE_LOOKUP: lookup }, cwd)(KEY)).toEqual({
      baseSha: 'f00d',
      baseFailing: true,
    });
    const broken = join(cwd, 'broken.ts');
    writeFileSync(broken, 'console.log("not json");\n');
    expect(() => defaultBaseLookup({ ...process.env, RALPH_BACKOFF_BASE_LOOKUP: broken }, cwd)(KEY)).toThrow();

    const feed = join(cwd, 'pushes.log');
    const push = join(cwd, 'push.ts');
    writeFileSync(push, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(feed)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    await defaultNotify({ ...process.env, RALPH_PUSH_CLI: push }, cwd)(['push', '--kind', 'shared-blocker']);
    expect(readFileSync(feed, 'utf8')).toBe('["push","--kind","shared-blocker"]\n');
    const failing = join(cwd, 'fail.ts');
    writeFileSync(failing, 'process.exit(1);\n');
    expect(() => defaultNotify({ ...process.env, RALPH_PUSH_CLI: failing }, cwd)(['push'])).toThrow(/exited 1/);
  });

  describe('leaving the blocker a loop no longer waits on', () => {
    const joined = async () => {
      const h = harness();
      const rafa = loopOn('rafa');
      await settleAs(rafa.cwd, rafa.env, h.deps);
      expect(readStore(h.storePath).blockers[KEY]).toBeDefined();
      return { h, rafa };
    };

    it('when the backoff ended', async () => {
      const { h, rafa } = await joined();
      await settleAs(rafa.cwd, rafa.env, h.deps, ['--sigil', 'other']);
      expect(readStore(h.storePath).blockers[KEY]).toBeUndefined();
    });

    it('when the key changed, joining the new one', async () => {
      const { h, rafa } = await joined();
      blockerFile(rafa.cwd, { key: 'ref:felipearos/loggd#2760', summary: 'waiting on #2760' });
      await settleAs(rafa.cwd, rafa.env, h.deps);
      const blockers = readStore(h.storePath).blockers;
      expect(blockers[KEY]).toBeUndefined();
      expect(blockers['ref:felipearos/loggd#2760']?.waiters.rafa).toBeDefined();
    });

    it('when the next blocker is null or shared:false', async () => {
      const gone = await joined();
      rmSync(join(gone.rafa.cwd, 'retry-blocker.json'));
      expect((await settleAs(gone.rafa.cwd, gone.rafa.env, gone.h.deps)).state?.blocker).toBeNull();
      expect(readStore(gone.h.storePath).blockers).toEqual({});
      // Only the opening join looked the base up: a settle that only leaves has no episode to open.
      expect(gone.h.lookups).toHaveLength(1);

      const unshared = await joined();
      blockerFile(unshared.rafa.cwd, { key: 'vercel-blocked', summary: 'vercel is down' });
      await settleAs(unshared.rafa.cwd, unshared.rafa.env, unshared.h.deps);
      expect(readStore(unshared.h.storePath).blockers).toEqual({});
      expect(unshared.h.lookups).toHaveLength(1);
    });

    it('but not on a rejoin of the same key', async () => {
      const { h, rafa } = await joined();
      const { lines } = await settleAs(rafa.cwd, rafa.env, h.deps);
      expect(lines).toHaveLength(1);
      expect(readStore(h.storePath).blockers[KEY]?.waiters.rafa).toBeDefined();
    });
  });

  describe('degrading when the store cannot be shared', () => {
    // What a settle with no store at all writes, `since` aside.
    const alone = async (): Promise<BackoffState | null> => {
      const cwd = project();
      blockerFile(cwd, { key: KEY, summary: 'prod migrations red' });
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await main(['settle', '--sigil', 'retry-later', '--blocker-file', 'retry-blocker.json'], {}, cwd, harness().deps);
      } finally {
        log.mockRestore();
      }
      return readState(join(cwd, '.ralph/logs/backoff.json'));
    };

    it('prints one line and exits 0 when the store lock cannot be had', async () => {
      const h = harness();
      const rafa = loopOn('rafa');
      const { code, state: written, lines } = await settleAs(rafa.cwd, rafa.env, {
        ...h.deps,
        withStore: async () => {
          throw new Error('the blocker store is locked');
        },
      });
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^backoff: .*locked/);
      expect(written).toEqual({ ...(await alone()), since: written?.since });
      expect(h.pushes).toHaveLength(0);
    });

    it('prints one line and exits 0 without a loop name, touching no store', async () => {
      const h = harness();
      const locked: string[] = [];
      const spy: typeof withStore = (path, critical, alive) => {
        locked.push(path);
        return withStore(path, critical, alive);
      };
      const rafa = loopOn('rafa');
      const { RALPH_LOOP_NAME: _, ...env } = rafa.env;
      const { code, state: written, lines } = await settleAs(rafa.cwd, env, { ...h.deps, withStore: spy });
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^backoff: /);
      expect(written).toEqual({ ...(await alone()), since: written?.since });
      expect(locked).toEqual([]);
      expect(h.lookups).toEqual([]);
      expect(existsSync(h.storePath)).toBe(false);
    });

    it('reads a corrupt store as empty, joins, and prints nothing more', async () => {
      const h = harness();
      mkdirSync(join(h.storePath, '..'), { recursive: true });
      writeFileSync(h.storePath, '{"version":1,"blockers":');
      const rafa = loopOn('rafa');
      const { code, lines } = await settleAs(rafa.cwd, rafa.env, h.deps);
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(h.pushes).toHaveLength(0);
      expect(readStore(h.storePath).blockers[KEY]?.waiters.rafa).toBeDefined();
    });

    it('prints one line and exits 0 when the push fails', async () => {
      const h = harness();
      const deps: ShareDeps = {
        ...h.deps,
        notify: () => {
          throw new Error('push exited 1');
        },
      };
      const ralph = loopOn('ralph');
      await settleAs(ralph.cwd, ralph.env, deps);
      const rafa = loopOn('rafa');
      const { code, lines } = await settleAs(rafa.cwd, rafa.env, deps);
      expect(code).toBe(0);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^backoff: .*push exited 1/);
    });
  });
});

describe('the clear probe for a shared blocker (#431)', () => {
  const KEY = normaliseBlockerKey('ci:buildkite/loggd:unit tests');
  const view = (over: Partial<SharedBlockerView> = {}): SharedBlockerView => ({
    first: '2026-10-22T00:00:00.000Z',
    notified: '2026-10-22T00:05:00.000Z',
    exhaustedNotified: null,
    clearedAt: null,
    clearedBy: null,
    baseSha: null,
    baseFailing: null,
    waiters: ['rafa', 'ralph'],
    ...over,
  });
  const check = (name: string, state: Check['state']): Check => ({ name, state, url: null });
  const reader = (over: Partial<ProbeReader> = {}): ProbeReader & {
    prChecks: ReturnType<typeof vi.fn>;
    baseChecks: ReturnType<typeof vi.fn>;
    prState: ReturnType<typeof vi.fn>;
  } => ({
    prChecks: vi.fn(over.prChecks ?? (async () => null)),
    baseChecks: vi.fn(over.baseChecks ?? (async () => null)),
    prState: vi.fn(over.prState ?? (async () => null)),
  });

  describe('the PR’s own check', () => {
    it('clears when the key’s check passes on the PR', async () => {
      const fake = reader({ prChecks: async () => [check('buildkite/loggd', 'pass')] });
      expect(await clearedProbe(fake, 'o/r')({ ...view(), key: KEY, pr: 12 })).toBe(true);
      expect(fake.prChecks).toHaveBeenCalledWith(12);
    });

    it.each(['pending', 'fail', 'skip'] as const)('does not clear while the check is %s', async (state) => {
      const fake = reader({ prChecks: async () => [check('buildkite/loggd', state)] });
      expect(await clearedProbe(fake, 'o/r')({ ...view(), key: KEY, pr: 12 })).toBe(false);
    });

    it('does not clear when the key’s check is absent, even with another check green', async () => {
      const fake = reader({ prChecks: async () => [check('vercel', 'pass')] });
      expect(await clearedProbe(fake, 'o/r')({ ...view(), key: KEY, pr: 12 })).toBe(false);
    });

    it('matches a differently cased and punctuated check name', async () => {
      const fake = reader({ prChecks: async () => [check('Buildkite/Loggd', 'pass')] });
      expect(await clearedProbe(fake, 'o/r')({ ...view(), key: KEY, pr: 12 })).toBe(true);
    });

    it('is not asked without a PR', async () => {
      const fake = reader({ prChecks: async () => [check('buildkite/loggd', 'pass')] });
      expect(await clearedProbe(fake, 'o/r')({ ...view(), key: KEY, pr: null })).toBe(false);
      expect(fake.prChecks).not.toHaveBeenCalled();
    });
  });

  describe('parseCiKey', () => {
    it('splits a well-formed ci: key into check and step', () => {
      expect(parseCiKey('ci:buildkite/loggd:unit-tests')).toEqual({ check: 'buildkite/loggd', step: 'unit-tests' });
    });

    it('rejects a ref: key', () => {
      expect(parseCiKey('ref:owner/repo#12')).toBeNull();
    });

    it('rejects a key with no second colon', () => {
      expect(parseCiKey('ci:buildkite/loggd')).toBeNull();
    });

    it('rejects anything else the share grammar rejects', () => {
      expect(parseCiKey('check:vercel')).toBeNull();
      expect(parseCiKey('ci:a:b:c')).toBeNull();
      expect(parseCiKey('')).toBeNull();
    });
  });

  describe('parseRestCheck', () => {
    it.each([
      [{ name: 'unit', status: 'completed', conclusion: 'success', html_url: 'https://x/1' }, { name: 'unit', state: 'pass', url: 'https://x/1' }],
      [{ name: 'unit', status: 'completed', conclusion: 'failure', details_url: 'https://x/2' }, { name: 'unit', state: 'fail', url: 'https://x/2' }],
      [{ name: 'unit', status: 'in_progress', conclusion: null }, { name: 'unit', state: 'pending', url: null }],
      [{ name: 'unit', status: 'completed', conclusion: 'skipped' }, { name: 'unit', state: 'skip', url: null }],
      [{ context: 'buildkite/loggd', state: 'success', target_url: 'https://bk/1' }, { name: 'buildkite/loggd', state: 'pass', url: 'https://bk/1' }],
      [{ context: 'buildkite/loggd', state: 'failure' }, { name: 'buildkite/loggd', state: 'fail', url: null }],
      [{ context: 'buildkite/loggd', state: 'pending' }, { name: 'buildkite/loggd', state: 'pending', url: null }],
    ])('maps the lowercase REST entry %j', (raw, expected) => {
      expect(parseRestCheck(raw)).toEqual(expected);
    });

    it('reads garbage as null', () => {
      for (const raw of [null, undefined, 'unit', 7, {}, { status: 'completed' }, { context: '' }]) {
        expect(parseRestCheck(raw)).toBeNull();
      }
    });
  });

  describe('the base head', () => {
    const red = { baseSha: 'aaa', baseFailing: true };

    it('clears when the base was red and a new head passes the key’s check', async () => {
      const fake = reader({ baseChecks: async () => ({ sha: 'bbb', checks: [check('buildkite/loggd', 'pass')] }) });
      expect(await clearedProbe(fake, 'o/r')({ ...view(red), key: KEY, pr: null })).toBe(true);
    });

    it('does not clear on a new green head when the base was never red', async () => {
      const fake = reader({ baseChecks: async () => ({ sha: 'bbb', checks: [check('buildkite/loggd', 'pass')] }) });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ baseSha: 'aaa', baseFailing: false }), key: KEY, pr: null })).toBe(false);
    });

    it('is disabled by a null baseSha', async () => {
      const fake = reader({ baseChecks: async () => ({ sha: 'bbb', checks: [check('buildkite/loggd', 'pass')] }) });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ baseSha: null, baseFailing: true }), key: KEY, pr: null })).toBe(false);
      expect(fake.baseChecks).not.toHaveBeenCalled();
    });

    it('is disabled by a null baseFailing', async () => {
      const fake = reader({ baseChecks: async () => ({ sha: 'bbb', checks: [check('buildkite/loggd', 'pass')] }) });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ baseSha: 'aaa', baseFailing: null }), key: KEY, pr: null })).toBe(false);
      expect(fake.baseChecks).not.toHaveBeenCalled();
    });

    it('does not clear on the same head it recorded red', async () => {
      const fake = reader({ baseChecks: async () => ({ sha: 'aaa', checks: [check('buildkite/loggd', 'pass')] }) });
      expect(await clearedProbe(fake, 'o/r')({ ...view(red), key: KEY, pr: null })).toBe(false);
    });
  });

  describe('the reference', () => {
    it.each(['merged', 'closed'] as const)('clears when clearedBy is %s, with no PR of its own', async (state) => {
      const fake = reader({ prState: async () => state });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ clearedBy: 'acme/infra#9' }), key: KEY, pr: null })).toBe(true);
      expect(fake.prState).toHaveBeenCalledWith('acme/infra', 9);
    });

    it('does not clear while the reference is open', async () => {
      const fake = reader({ prState: async () => 'open' });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ clearedBy: '#9' }), key: KEY, pr: 3 })).toBe(false);
    });

    it('resolves a bare #n against the project repo', async () => {
      const fake = reader({ prState: async () => 'merged' });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ clearedBy: '#9' }), key: KEY, pr: null })).toBe(true);
      expect(fake.prState).toHaveBeenCalledWith('o/r', 9);
    });

    it('cannot resolve a bare #n without a project repo', async () => {
      const fake = reader({ prState: async () => 'merged' });
      expect(await clearedProbe(fake, null)({ ...view({ clearedBy: '#9' }), key: KEY, pr: null })).toBe(false);
      expect(fake.prState).not.toHaveBeenCalled();
    });

    it.each(['merged', 'closed'] as const)('probes a ref: key’s own PR when %s', async (state) => {
      const fake = reader({ prState: async () => state });
      const probe = { ...view(), key: 'ref:acme/infra#42', pr: null };
      expect(await clearedProbe(fake, null)(probe)).toBe(true);
      expect(fake.prState).toHaveBeenCalledWith('acme/infra', 42);
    });

    it('reads an unparseable reference as no clear, without throwing', async () => {
      const fake = reader({ prState: async () => 'merged' });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ clearedBy: 'the vercel outage' }), key: KEY, pr: null })).toBe(false);
      expect(fake.prState).not.toHaveBeenCalled();
    });

    it('reads a null answer as no clear', async () => {
      const fake = reader({ prState: async () => null });
      expect(await clearedProbe(fake, 'o/r')({ ...view({ clearedBy: '#9' }), key: KEY, pr: null })).toBe(false);
    });

    it('reads a reader that throws or rejects as no clear', async () => {
      const throwing: ProbeReader = {
        prChecks: () => { throw new Error('gh exploded'); },
        baseChecks: async () => { throw new Error('gh exploded'); },
        prState: () => Promise.reject(new Error('gh exploded')),
      };
      const probe = { ...view({ clearedBy: '#9', baseSha: 'aaa', baseFailing: true }), key: KEY, pr: 12 };
      await expect(clearedProbe(throwing, 'o/r')(probe)).resolves.toBe(false);
    });
  });
});

describe('the default base-branch lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-base-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const KEY = 'ci:buildkite/loggd:production-migrations';
  const SHA = 'c0ffee1234';
  // `git` and `gh` are stubs on the PATH of the env passed in: no network, no repo.
  const stubbed = (body: { runs?: unknown[]; statuses?: unknown[]; ghExit?: number }) => {
    const cwd = join(dir, `project-${++n}`);
    const bin = join(cwd, 'bin');
    mkdirSync(join(cwd, '.ralph'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(cwd, '.ralph/config.json'), JSON.stringify({ repo: 'o/r' }));
    const calls = join(cwd, 'gh-calls.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho ${SHA}\n`, { mode: 0o755 });
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${calls}'`,
        `[ ${body.ghExit ?? 0} -eq 0 ] || exit ${body.ghExit}`,
        'case "$2" in',
        `  */check-runs*) echo '${JSON.stringify({ check_runs: body.runs ?? [] })}' ;;`,
        `  */status) echo '${JSON.stringify({ statuses: body.statuses ?? [] })}' ;;`,
        '  *) exit 3 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}:${process.env.PATH}` };
    return { lookup: defaultBaseLookup(env, cwd), calls };
  };
  const status = (state: string) => ({ statuses: [{ context: 'buildkite/loggd', state }] });

  it('reads a failing legacy status on the base commit as failing', async () => {
    const { lookup, calls } = stubbed(status('failure'));
    expect(await lookup(KEY)).toEqual({ baseSha: SHA, baseFailing: true });
    expect(readFileSync(calls, 'utf8')).toBe(
      `api repos/o/r/commits/${SHA}/check-runs?per_page=100\napi repos/o/r/commits/${SHA}/status\n`,
    );
  });

  it('reads success as not failing, and pending or absent as not known', async () => {
    expect(await stubbed(status('success')).lookup(KEY)).toEqual({ baseSha: SHA, baseFailing: false });
    expect(await stubbed(status('pending')).lookup(KEY)).toEqual({ baseSha: SHA, baseFailing: null });
    expect(await stubbed({}).lookup(KEY)).toEqual({ baseSha: SHA, baseFailing: null });
  });

  it('matches a check run by name case-insensitively', async () => {
    const runs = [{ name: 'Buildkite/Loggd', status: 'completed', conclusion: 'failure' }];
    expect(await stubbed({ runs }).lookup(KEY)).toEqual({ baseSha: SHA, baseFailing: true });
  });

  it('records only the sha for a ref key, without asking gh', async () => {
    const { lookup, calls } = stubbed(status('failure'));
    expect(await lookup('ref:o/r#5')).toEqual({ baseSha: SHA, baseFailing: null });
    expect(existsSync(calls)).toBe(false);
  });

  it('throws when gh fails', () => {
    expect(() => stubbed({ ...status('failure'), ghExit: 1 }).lookup(KEY)).toThrow(/exited 1/);
  });
});

describe('the wait CLI on a shared blocker (#431)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-wait-cli-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const KEY = 'ci:buildkite/loggd:production-migrations';
  const BUDGET = 21600;
  const OLD = new Date(Date.now() - (BUDGET + 600) * 1000).toISOString();
  const RECENT = new Date(Date.now() - 60 * 1000).toISOString();
  const env = (over: Record<string, string> = {}): Record<string, string> => ({
    RALPH_LOOP_NAME: 'rita',
    RALPH_RUN_ID: 'rita-run',
    RALPH_SUPERVISOR_PID: String(process.pid),
    ...over,
  });
  // A reader that never clears and spawns nothing: every case here ends before a poll would ask it.
  const probeReader: ProbeReader = {
    prChecks: async () => null,
    baseChecks: async () => null,
    prState: async () => null,
  };
  const project = (blocker: BackoffState['blocker'], waitedSeconds = 0) => {
    const cwd = join(dir, `project-${++n}`);
    mkdirSync(join(cwd, '.ralph/logs'), { recursive: true });
    writeState(join(cwd, '.ralph/logs/backoff.json'), {
      version: 1,
      reason: 'external',
      pr: null,
      fingerprint: null,
      strikes: 1,
      waitedSeconds,
      since: NOW,
      blocker,
    });
    return { cwd, storePath: join(cwd, 'store', 'ralph-blockers.json'), file: join(cwd, EXHAUSTED_RELATIVE_PATH) };
  };
  const ref = (key = KEY, shared = true): BackoffState['blocker'] => ({
    key,
    summary: 'prod migrations red',
    clearedBy: null,
    shared,
  });
  const seed = (storePath: string, key: string, over: Record<string, unknown> = {}, loops = ['ralph', 'rafa']) => {
    const waiters = Object.fromEntries(
      loops.map((loop) => [
        loop,
        { loop, pr: null, pid: process.pid, host: 'h', since: OLD, lastSeen: OLD },
      ]),
    );
    mkdirSync(join(storePath, '..'), { recursive: true });
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        blockers: {
          [key]: {
            key,
            summary: 'prod migrations red',
            clearedBy: null,
            first: OLD,
            baseSha: null,
            baseFailing: null,
            notified: OLD,
            exhaustedNotified: null,
            clearedAt: null,
            waiters,
            ...over,
          },
        },
      }),
    );
  };
  const wait = async (cwd: string, e: Record<string, string>, deps: ShareDeps) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['wait'], e, cwd, { alive: () => true, probeReader, ...deps });
      return { code, lines: log.mock.calls.map((call) => String(call[0])) };
    } finally {
      log.mockRestore();
    }
  };
  const record = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

  it('claims the exhaustion of a spent shared episode and names every waiting loop', async () => {
    const p = project(ref());
    seed(p.storePath, KEY);
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(3);
    expect(record(p.file)).toEqual({
      event: 'backoff-exhausted',
      why: `shared blocker ${KEY} did not clear in ${BUDGET}s; waiting loops: rafa, ralph, rita; needs human triage`,
    });
    expect(readStore(p.storePath).blockers[KEY]?.exhaustedNotified).toEqual(expect.any(String));
  });

  it('says the episode was already escalated when another loop claimed it', async () => {
    const p = project(ref());
    seed(p.storePath, KEY, { exhaustedNotified: OLD });
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(3);
    expect(record(p.file)).toEqual({
      event: 'backoff-exhausted-shared',
      why: `shared blocker ${KEY} did not clear in ${BUDGET}s; already escalated on this host`,
    });
    expect(readStore(p.storePath).blockers[KEY]?.exhaustedNotified).toBe(OLD);
  });

  it('keeps today\'s record when only this loop\'s own streak ran out on an episode with budget left', async () => {
    const p = project(ref(), BUDGET);
    seed(p.storePath, KEY, { first: RECENT }, ['rita']);
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(3);
    expect(existsSync(p.file)).toBe(false);
    expect(readStore(p.storePath).blockers[KEY]?.exhaustedNotified).toBeNull();
  });

  it('finds the store through RALPH_BLOCKER_STORE when no path is injected', async () => {
    const p = project(ref());
    seed(p.storePath, KEY);
    const { code } = await wait(p.cwd, env({ RALPH_BLOCKER_STORE: p.storePath }), {});
    expect(code).toBe(3);
    expect(record(p.file)).toMatchObject({ event: 'backoff-exhausted' });
    expect(readStore(p.storePath).blockers[KEY]?.exhaustedNotified).toEqual(expect.any(String));
  });

  it('re-checks at once when another loop already cleared the episode', async () => {
    const p = project(ref());
    seed(p.storePath, KEY, { first: RECENT, clearedAt: RECENT });
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(0);
    expect(existsSync(join(p.cwd, '.ralph/logs/backoff.json'))).toBe(true);
    expect(existsSync(p.file)).toBe(false);
  });

  it('never reaches the store for an unshared key or no blocker', async () => {
    for (const blocker of [ref('check:test', false), null]) {
      const p = project(blocker, BUDGET);
      seed(p.storePath, 'check:test', { clearedAt: RECENT });
      const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
      expect(code).toBe(3);
      expect(existsSync(p.file)).toBe(false);
      expect(readStore(p.storePath).blockers['check:test']?.exhaustedNotified).toBeNull();
    }
  });

  it('writes no record for a shared key whose episode was never shared', async () => {
    const p = project(ref(), BUDGET);
    seed(p.storePath, KEY, { notified: null, first: RECENT }, ['rita']);
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(3);
    expect(existsSync(p.file)).toBe(false);
    expect(readStore(p.storePath).blockers[KEY]?.exhaustedNotified).toBeNull();
  });

  it('removes a stale record on a per-loop exhaustion', async () => {
    const p = project(ref('check:test', false), BUDGET);
    writeFileSync(p.file, JSON.stringify({ event: 'backoff-exhausted-shared', why: 'an old episode' }));
    const { code } = await wait(p.cwd, env(), { storePath: p.storePath });
    expect(code).toBe(3);
    expect(existsSync(p.file)).toBe(false);
  });

  it('degrades to the per-loop record when the store cannot be read', async () => {
    const p = project(ref());
    seed(p.storePath, KEY);
    let calls = 0;
    const spy: typeof withStore = (path, critical, alive) =>
      ++calls === 1 ? withStore(path, critical, alive) : Promise.reject(new Error('lock lost'));
    const { code, lines } = await wait(p.cwd, env(), { storePath: p.storePath, withStore: spy });
    expect(code).toBe(3);
    expect(existsSync(p.file)).toBe(false);
    expect(lines.some((line) => line.includes('lock lost'))).toBe(true);
  });
});

describe('the default clear-probe reader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-probe-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const SHA = 'c0ffee1234';
  // `git` and `gh` are stubs on the PATH of the env passed in: no network, no repo.
  const stubbed = (body: { runs?: unknown[]; statuses?: unknown[]; pull?: unknown; ghExit?: number }) => {
    const cwd = join(dir, `project-${++n}`);
    const bin = join(cwd, 'bin');
    mkdirSync(join(cwd, '.ralph'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(cwd, '.ralph/config.json'), JSON.stringify({ repo: 'o/r' }));
    // The probe reads the head from GitHub: a local ref nobody fetches never moves.
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `[ ${body.ghExit ?? 0} -eq 0 ] || exit ${body.ghExit}`,
        'case "$2" in',
        `  */check-runs*) echo '${JSON.stringify({ check_runs: body.runs ?? [] })}' ;;`,
        `  */status) echo '${JSON.stringify({ statuses: body.statuses ?? [] })}' ;;`,
        `  */pulls/*) echo '${JSON.stringify(body.pull ?? {})}' ;;`,
        `  */commits/main) echo '${JSON.stringify({ sha: SHA })}' ;;`,
        '  *) exit 3 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return defaultProbeReader({ PATH: `${bin}:${process.env.PATH}` }, cwd);
  };

  it('reads the base head from both REST endpoints in their lower-case spellings', async () => {
    const reader = stubbed({
      runs: [{ name: 'Buildkite/Loggd', status: 'completed', conclusion: 'success' }],
      statuses: [{ context: 'vercel', state: 'failure' }],
    });
    expect(await reader.baseChecks()).toEqual({
      sha: SHA,
      checks: [
        { name: 'Buildkite/Loggd', state: 'pass', url: null },
        { name: 'vercel', state: 'fail', url: null },
      ],
    });
  });

  it('maps a referenced PR to merged, closed or open', async () => {
    expect(await stubbed({ pull: { state: 'closed', merged: true } }).prState('o/r', 5)).toBe('merged');
    expect(await stubbed({ pull: { state: 'closed', merged_at: NOW } }).prState('o/r', 5)).toBe('merged');
    expect(await stubbed({ pull: { state: 'closed', merged: false } }).prState('o/r', 5)).toBe('closed');
    expect(await stubbed({ pull: { state: 'open' } }).prState('o/r', 5)).toBe('open');
    expect(await stubbed({ pull: {} }).prState('o/r', 5)).toBeNull();
  });

  it('answers null instead of throwing when gh fails', async () => {
    const reader = stubbed({ ghExit: 1 });
    expect(await reader.baseChecks()).toBeNull();
    expect(await reader.prState('o/r', 5)).toBeNull();
  });
});

describe('two loops settling at the same time, as two bun processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-backoff-two-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const KEY = 'ci:buildkite/loggd:production-migrations';

  // The in-process cases above share one event loop, so they cannot race on
  // the store's lock. Two real processes can: "once" has to come from the lock
  // and markNotified, not from the order a test happens to call them in.
  it('escalates exactly once when both join the same shared key', async () => {
    const store = join(dir, 'store', 'ralph-blockers.json');
    const pushes = join(dir, 'pushes.log');
    const pushCli = join(dir, 'push.ts');
    // One JSON line per invocation: the push body has newlines of its own.
    writeFileSync(
      pushCli,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(pushes)}, JSON.stringify(process.argv.slice(2).join(' ')) + '\\n');\n`,
    );
    const lookup = join(dir, 'lookup.ts');
    writeFileSync(lookup, `console.log(JSON.stringify({ baseSha: 'abc', baseFailing: true }));\n`);
    const settleAs = (loop: string): Promise<number | null> => {
      const cwd = join(dir, loop);
      mkdirSync(join(cwd, '.ralph/logs'), { recursive: true });
      writeFileSync(join(cwd, 'retry-blocker.json'), JSON.stringify({ key: KEY, summary: 'prod migrations red' }));
      return new Promise((done, fail) => {
        const child = spawn(
          'bun',
          [join(__dirname, 'backoff.ts'), 'settle', '--sigil', 'retry-later', '--blocker-file', 'retry-blocker.json'],
          {
            cwd,
            // A minimal base, not process.env: a loop running this suite has
            // RALPH_* vars of its own that would name another store or push.
            env: {
              PATH: process.env.PATH ?? '',
              HOME: process.env.HOME ?? '',
              RALPH_LOOP_NAME: loop,
              RALPH_RUN_ID: `${loop}-run`,
              // This test process: alive, so neither waiter is pruned as dead.
              RALPH_SUPERVISOR_PID: String(process.pid),
              RALPH_BLOCKER_STORE: store,
              RALPH_PUSH_CLI: pushCli,
              RALPH_BACKOFF_BASE_LOOKUP: lookup,
            },
            stdio: 'ignore',
          },
        );
        child.on('error', fail);
        child.on('exit', done);
      });
    };

    expect(await Promise.all([settleAs('ralph'), settleAs('rafa')])).toEqual([0, 0]);
    expect(Object.keys(readStore(store).blockers[KEY]?.waiters ?? {}).sort()).toEqual(['rafa', 'ralph']);
    const lines = readFileSync(pushes, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--kind shared-blocker');
  });
});
