// @vitest-environment node
/**
 * The host lease: a quiet host for a heavy command an acceptance criterion
 * needs and CI does not produce (loggd #1604 / PR #1809, 2026-09-29).
 *
 * These pin the part that matters most: it is NOT something loops race for.
 * Every limit below is enforced by the store, whatever the prompt says.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { subprocessSuite } from './test-timeouts';

import {
  acquire,
  admit,
  emptyStore,
  grant,
  HELD_CONTROL_EXIT,
  heldBack,
  holderLapsed,
  leaseInUse,
  main,
  othersInTurn,
  parsePolicy,
  parseRequest,
  promote,
  prune,
  readCi,
  readStore,
  requiredChecksFrom,
  releaseRun,
  resumePrompt,
  type AcquireDeps,
  type CiRead,
  type LeaseRequest,
  type Party,
  type Policy,
} from './host-lease';

// `main` resolves the store by shelling out to `git rev-parse`, and the held
// `turn-begin` below waits a real control-poll slice, so this file's runtime
// follows the host's load — the 5 s default is what #187 showed stretching to
// 13 s on the box that also runs the loops and CI.
subprocessSuite('resolves the lease store with git rev-parse, and waits a real control slice');

const T0 = Date.parse('2026-09-29T10:40:00Z');
const policy: Policy = parsePolicy({});
const alive = (): boolean => true;

const party = (loop: string, run = `${loop}-run`): Party => ({ run, loop, pid: 4242, host: 'box' });
const request = (ticket = 1604): LeaseRequest => ({
  ticket,
  command: 'bun run build at origin/main and at HEAD',
  criterion: 'AC5: before/after raw and gzip -9 client JS for /show/[id]',
  whyNotCi: 'no CI job emits client-reference manifest sizes',
  fenceEvidence: 'buildkite-agent busy at 08:47, 08:49, 08:52, 10:36',
});

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const storePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-host-lease-'));
  scratch.push(dir);
  return join(dir, 'ralph-host-lease.json');
};

describe('the policy knobs', () => {
  it('defaults every limit on', () => {
    expect(policy).toMatchObject({ perTicket: 2, queueMax: 2, loopCooldownSeconds: 21600, spacingSeconds: 1800 });
  });

  it('refuses a zero that would switch a limit off', () => {
    expect(() => parsePolicy({ RALPH_HOST_LEASE_PER_TICKET: '0' })).toThrow(/must be positive/);
    expect(() => parsePolicy({ RALPH_HOST_LEASE_QUEUE_MAX: 'lots' })).toThrow(/whole number/);
  });
});

describe('the request a session writes', () => {
  it('reads a complete request', () => {
    expect(parseRequest(JSON.stringify(request()))).toEqual(request());
  });

  it.each([
    ['not JSON', '{', /not JSON/],
    ['no ticket', JSON.stringify({ ...request(), ticket: 0 }), /no ticket/],
    ['an empty criterion', JSON.stringify({ ...request(), criterion: '' }), /criterion/],
    ['a token why-not-CI', JSON.stringify({ ...request(), whyNotCi: 'it cannot' }), /whyNotCi/],
    ['no fence evidence', JSON.stringify({ ...request(), fenceEvidence: undefined }), /fenceEvidence/],
  ])('refuses %s', (_, raw, why) => {
    expect(parseRequest(raw)).toMatch(why);
  });
});

describe('who may queue', () => {
  it('queues the claimed ticket', () => {
    const store = emptyStore();
    expect(admit(store, party('testo'), request(), 1604, policy, T0)).toEqual({ ok: true });
    expect(store.queue).toHaveLength(1);
  });

  it('refuses a loop with no claim, or a request for someone else\'s ticket', () => {
    expect(admit(emptyStore(), party('testo'), request(), null, policy, T0)).toMatchObject({ ok: false, why: /no claimed ticket/ });
    expect(admit(emptyStore(), party('testo'), request(1604), 1630, policy, T0)).toMatchObject({ ok: false, why: /#1630/ });
  });

  it('gives a run one place, not one per retry', () => {
    const store = emptyStore();
    admit(store, party('testo'), request(), 1604, policy, T0);
    expect(admit(store, party('testo'), request(), 1604, policy, T0)).toMatchObject({ ok: false, why: /already/ });
    expect(store.queue).toHaveLength(1);
  });

  it('caps grants per ticket, ever', () => {
    const store = emptyStore();
    store.tickets['1604'] = { grants: 2, lastGrantAt: '2026-09-20T00:00:00Z' };
    expect(admit(store, party('testo'), request(), 1604, policy, T0)).toMatchObject({ ok: false, why: /PER_TICKET/ });
  });

  it('counts a refused ask against the ticket, so knocking every iteration runs out', () => {
    const store = emptyStore();
    store.queue = [
      { ...party('ralph'), ticket: 1, command: 'x', queuedAt: 'x' },
      { ...party('remo'), ticket: 2, command: 'x', queuedAt: 'x' },
    ];
    for (let ask = 0; ask < policy.asksPerTicket; ask++) {
      expect(admit(store, party('testo'), request(), 1604, policy, T0)).toMatchObject({ ok: false, why: /QUEUE_MAX/ });
    }
    store.queue = [];
    expect(admit(store, party('testo'), request(), 1604, policy, T0)).toMatchObject({ ok: false, why: /ASKS_PER_TICKET/ });
  });

  it('cools a loop down after its grant', () => {
    const store = emptyStore();
    store.loops.testo = { lastGrantAt: new Date(T0 - 3600_000).toISOString() };
    expect(admit(store, party('testo'), request(), 1604, policy, T0)).toMatchObject({ ok: false, why: /COOLDOWN/ });
    expect(admit(store, party('testo'), request(), 1604, policy, T0 + 6 * 3600_000)).toEqual({ ok: true });
  });

  it('refuses rather than piles up past the queue limit', () => {
    const store = emptyStore();
    admit(store, party('ralph'), request(1), 1, policy, T0);
    admit(store, party('remo'), request(2), 2, policy, T0);
    expect(admit(store, party('rulo'), request(3), 3, policy, T0)).toMatchObject({ ok: false, why: /QUEUE_MAX/ });
  });
});

describe('who holds the host, in what order', () => {
  it('serves the queue first-come, first-served', () => {
    const store = emptyStore();
    admit(store, party('ralph'), request(1), 1, policy, T0);
    admit(store, party('remo'), request(2), 2, policy, T0);
    expect(promote(store, 'remo-run', policy, T0)).toBe(false);
    expect(promote(store, 'ralph-run', policy, T0)).toBe(true);
    expect(store.holder).toMatchObject({ loop: 'ralph', state: 'draining' });
    expect(promote(store, 'remo-run', policy, T0)).toBe(false);
  });

  it('spaces one lease from the next', () => {
    const store = emptyStore();
    store.lastReleasedAt = new Date(T0 - 60_000).toISOString();
    admit(store, party('remo'), request(2), 2, policy, T0);
    expect(promote(store, 'remo-run', policy, T0)).toBe(false);
    expect(promote(store, 'remo-run', policy, T0 + policy.spacingSeconds * 1000)).toBe(true);
  });

  it('holds back everyone but the holder, and counts a grant against both limits', () => {
    const store = emptyStore();
    admit(store, party('testo'), request(), 1604, policy, T0);
    promote(store, 'testo-run', policy, T0);
    expect(heldBack(store, 'remo-run')).toMatchObject({ loop: 'testo' });
    expect(heldBack(store, 'testo-run')).toBeNull();
    grant(store, 'testo-run', policy, T0);
    expect(store.tickets['1604']?.grants).toBe(1);
    expect(store.loops.testo?.lastGrantAt).toBe(new Date(T0).toISOString());
    expect(releaseRun(store, 'testo-run', T0 + 1000)).toBe(true);
    expect(heldBack(store, 'remo-run')).toBeNull();
  });

  it('clears a holder whose supervisor died, or whose grant ran out', () => {
    const dead = emptyStore();
    admit(dead, party('testo'), request(), 1604, policy, T0);
    promote(dead, 'testo-run', policy, T0);
    dead.turns['remo-run'] = { loop: 'remo', pid: 1, host: 'box', since: 'x' };
    expect(prune(dead, T0, () => false).length).toBe(2);
    expect(dead.holder).toBeNull();
    expect(dead.turns).toEqual({});

    const late = emptyStore();
    admit(late, party('testo'), request(), 1604, policy, T0);
    promote(late, 'testo-run', policy, T0);
    grant(late, 'testo-run', policy, T0);
    prune(late, T0 + policy.grantSeconds * 1000, alive);
    expect(late.holder).toBeNull();
  });
});

describe('the supervisor\'s wait', () => {
  const deps = (path: string, overrides: Partial<AcquireDeps> & { reads?: CiRead[] } = {}): AcquireDeps => {
    let now = T0;
    const reads = overrides.reads ?? [{ busy: false, detail: 'idle' }];
    let read = 0;
    return {
      path,
      party: party('testo'),
      policy: { ...policy, pollSeconds: 60 },
      now: () => now,
      sleep: async (ms) => { now += ms; },
      alive,
      ci: () => reads[Math.min(read++, reads.length - 1)]!,
      log: () => {},
      ...overrides,
    };
  };

  it('drains until no other loop is in a turn and CI is idle twice running, then grants', async () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ ...emptyStore(), turns: { 'remo-run': { loop: 'remo', pid: 7, host: 'box', since: 'x' } } }));
    let turnsLeft = 2;
    const d = deps(path, {
      reads: [{ busy: true, detail: 'pending: #1810 buildkite/loggd' }, { busy: false, detail: 'idle' }, { busy: false, detail: 'idle' }],
      // remo's turn ends after two polls.
      alive: (p) => (p.pid === 7 ? turnsLeft-- > 0 : true),
    });
    const result = await acquire(request(), 1604, d);
    expect(result.outcome).toBe('granted');
    expect(result.expiresAt).not.toBeNull();
    const store = readStore(path);
    expect(store.holder).toMatchObject({ state: 'granted', loop: 'testo' });
    expect(store.tickets['1604']?.grants).toBe(1);
  });

  it('gives up and releases the others when the host never goes quiet', async () => {
    const path = storePath();
    const result = await acquire(request(), 1604, deps(path, { reads: [{ busy: true, detail: 'pending' }] }));
    expect(result.outcome).toBe('drain-timeout');
    expect(readStore(path).holder).toBeNull();
    expect(readStore(path).tickets['1604']).toMatchObject({ grants: 0, asks: 1 });
  });

  it('refuses an invalid request without touching the store', async () => {
    const path = storePath();
    expect(await acquire('the request is not JSON', 1604, deps(path))).toMatchObject({ outcome: 'refused' });
    expect(readStore(path)).toEqual(emptyStore());
  });

  it('times out in the queue behind another holder', async () => {
    const path = storePath();
    const other = emptyStore();
    admit(other, party('remo'), request(2), 2, policy, T0);
    promote(other, 'remo-run', policy, T0);
    writeFileSync(path, JSON.stringify(other));
    const result = await acquire(request(), 1604, deps(path, { policy: { ...policy, queueSeconds: 600 } }));
    expect(result.outcome).toBe('queue-timeout');
    expect(readStore(path).queue).toEqual([]);
  });
});

describe('the other supervisors', () => {
  it('registers a turn only when nobody else holds the host', async () => {
    const path = storePath();
    const env = { RALPH_RUN_ID: 'remo-run', RALPH_LOOP_NAME: 'remo', RALPH_SUPERVISOR_PID: String(process.pid), RALPH_STATE_ROOT: join(path, '..') };
    // Not a git worktree, so the store falls back to `.ralph-host-lease.json` under the root.
    const fallback = join(path, '..', '.ralph-host-lease.json');
    expect(await main(['turn-begin'], env)).toBe(0);
    expect(othersInTurn(readStore(fallback), 'testo-run').map((t) => t.loop)).toEqual(['remo']);
    expect(await main(['turn-end'], env)).toBe(0);
    expect(readStore(fallback).turns).toEqual({});
  });

  it('hands an operator command back instead of sleeping on it while held', async () => {
    const path = storePath();
    const root = join(path, '..');
    // Not a git worktree, so `main` reads and writes the same fallback store
    // the test above does, rather than `storePath()`'s own file.
    const fallback = join(root, '.ralph-host-lease.json');
    const project = join(root, 'project');
    mkdirSync(join(project, '.ralph', 'control', 'inbox'), { recursive: true });
    // A holder has the host, so this run is held before its turn. Built on the
    // real clock, not `T0`: `main` prunes against `Date.now()`, and a holder
    // dated to the fixture's day would be past its deadline before it is read.
    const now = Date.now();
    const other = emptyStore();
    admit(other, party('remo'), request(2), 2, policy, now);
    promote(other, 'remo-run', policy, now);
    writeFileSync(fallback, JSON.stringify(other));
    const env = {
      RALPH_RUN_ID: 'testo-run', RALPH_LOOP_NAME: 'testo', RALPH_SUPERVISOR_PID: String(process.pid),
      RALPH_STATE_ROOT: root, RALPH_PROJECT: project, RALPH_CONTROL_POLL_SECONDS: '1',
    };
    // The command lands after the hold begins, within the first slice.
    setTimeout(() => writeFileSync(join(project, '.ralph', 'control', 'inbox', 'stop-1.json'),
      JSON.stringify({ version: 1, id: 'stop-1', command: 'stop', why: 'from the test' })), 300);
    expect(await main(['turn-begin'], env)).toBe(HELD_CONTROL_EXIT);
    // No turn registered: the supervisor applies the command and asks again.
    expect(readStore(fallback).turns).toEqual({});
  });

  it('does not look at the inbox when it is not held', async () => {
    const path = storePath();
    const root = join(path, '..');
    const project = join(root, 'project');
    mkdirSync(join(project, '.ralph', 'control', 'inbox'), { recursive: true });
    writeFileSync(join(project, '.ralph', 'control', 'inbox', 'stop-1.json'),
      JSON.stringify({ version: 1, id: 'stop-1', command: 'stop', why: 'from the test' }));
    const env = { RALPH_RUN_ID: 'remo-run', RALPH_LOOP_NAME: 'remo', RALPH_SUPERVISOR_PID: String(process.pid), RALPH_STATE_ROOT: root, RALPH_PROJECT: project };
    // The checkpoint before the turn already answered it; a turn is not refused
    // for it, and it is registered as usual — a holder must still see it.
    expect(await main(['turn-begin'], env)).toBe(0);
    expect(readStore(join(root, '.ralph-host-lease.json')).turns).toHaveProperty('remo-run');
  });
});

describe('reading CI', () => {
  const gh = (answers: Record<string, string | null>) => (args: string[]) => {
    const key = args[0] === 'pr' ? 'prs' : args[1]!.endsWith('/status') ? 'status' : 'runs';
    const out = answers[key];
    return out === null ? { ok: false, out: '' } : { ok: true, out: out ?? '' };
  };
  const quiet = { runs: '{"check_runs":[]}', status: '{"statuses":[]}' };

  it('counts only required checks that have reported as pending', () => {
    const prs = JSON.stringify([
      { number: 1810, statusCheckRollup: [{ __typename: 'StatusContext', context: 'buildkite/loggd', state: 'PENDING' }] },
      { number: 1811, statusCheckRollup: [{ name: 'Mergify Merge Queue', status: 'IN_PROGRESS' }] },
      { number: 1812, statusCheckRollup: [] },
    ]);
    expect(readCi('o/r', 'main', ['buildkite/loggd', 'Vercel'], gh({ prs, ...quiet }))).toMatchObject({ busy: true, detail: /#1810 buildkite\/loggd/ });
    expect(readCi('o/r', 'main', ['Vercel'], gh({ prs, ...quiet }))).toMatchObject({ busy: false });
  });

  it('looks at the base branch too, and calls an unreadable answer busy', () => {
    const status = '{"statuses":[{"context":"buildkite/loggd","state":"pending"}]}';
    expect(readCi('o/r', 'main', ['buildkite/loggd'], gh({ prs: '[]', runs: quiet.runs, status }))).toMatchObject({ busy: true, detail: /main buildkite/ });
    expect(readCi('o/r', 'main', [], gh({ prs: null }))).toMatchObject({ busy: true });
  });
});

describe('what the resumed session is told', () => {
  it('names the grant, the deadline and the one command', () => {
    const text = resumePrompt({ outcome: 'granted', ticket: 1604, command: 'bun run build twice', expiresAt: '2026-09-29T12:00:00Z', detail: 'idle' });
    expect(text).toContain('GRANTED for #1604 until 2026-09-29T12:00:00Z');
    expect(text).toContain('run only what your request named — bun run build twice');
    expect(text).toContain('Do not end with AWAIT_HOST again');
  });

  it('sends a refusal to the blocked path, quoting it', () => {
    const text = resumePrompt({ outcome: 'refused', ticket: 1604, command: null, expiresAt: null, detail: 'PER_TICKET' });
    expect(text).toContain('NOT granted (refused): PER_TICKET');
    expect(text).toContain('blocked path in §6');
  });
});

describe('leaseInUse — the question a READER asks (#161)', () => {
  const holderAt = (over: Partial<Parameters<typeof leaseInUse>[0]['holder'] & object> = {}) => ({
    ...party('rulo'),
    ticket: 1809,
    command: 'bun run build',
    queuedAt: new Date(T0 - 60_000).toISOString(),
    state: 'granted' as const,
    since: new Date(T0 - 60_000).toISOString(),
    drainDeadline: new Date(T0 + 300_000).toISOString(),
    expiresAt: new Date(T0 + 600_000).toISOString(),
    ...over,
  });

  it('a live granted holder is in use, and names who has it', () => {
    const store = emptyStore();
    store.holder = holderAt();
    expect(leaseInUse(store, T0, alive)).toMatchObject({ busy: true, detail: /rulo for #1809/ });
  });

  it('a holder past its deadline is NOT in use, which is the whole point', () => {
    // `prune` runs on acquire and release alone, so on a host with no lease
    // traffic — the quiet host the retry exists for — a leaked holder would
    // otherwise read as in use for ever and the doctor would never retry.
    const expired = emptyStore();
    expired.holder = holderAt({ expiresAt: new Date(T0 - 1000).toISOString() });
    expect(leaseInUse(expired, T0, alive).busy).toBe(false);

    const draining = emptyStore();
    draining.holder = holderAt({ state: 'draining', drainDeadline: new Date(T0 - 6 * 60_000).toISOString() });
    expect(leaseInUse(draining, T0, alive).busy).toBe(false);

    // And the same two predicates `prune` clears on, so a reader and the
    // sweeper cannot disagree about what a live lease is.
    expect(holderLapsed(expired.holder!, T0)).toBe(true);
    expect(holderLapsed(draining.holder!, T0)).toBe(true);
    expect(holderLapsed(holderAt(), T0)).toBe(false);
  });

  it('a holder whose supervisor is gone is not in use either', () => {
    const store = emptyStore();
    store.holder = holderAt();
    expect(leaseInUse(store, T0, () => false).busy).toBe(false);
  });

  it('counts live waiters and ignores dead ones', () => {
    const store = emptyStore();
    store.queue = [
      { ...party('ralph'), ticket: 1, command: 'x', queuedAt: 'x' },
      { ...party('remo'), ticket: 2, command: 'x', queuedAt: 'x' },
    ];
    expect(leaseInUse(store, T0, alive)).toMatchObject({ busy: true, detail: /2 waiting/ });
    expect(leaseInUse(store, T0, () => false).busy).toBe(false);
  });

  it('an empty store is not in use', () => {
    expect(leaseInUse(emptyStore(), T0, alive)).toMatchObject({ busy: false });
  });
});

describe('requiredChecksFrom', () => {
  it('trims every name, because readCi matches a check name exactly', () => {
    // Two callers had two copies of this split and they disagreed by a
    // `.trim()`. An untrimmed name matches no check, so nothing is ever
    // pending and a BUSY host reads as idle — the one answer that must not be
    // wrong by accident.
    expect(requiredChecksFrom({ RALPH_REQUIRED_CHECKS: ' buildkite/loggd \n\n  test  \n' })).toEqual([
      'buildkite/loggd',
      'test',
    ]);
    expect(requiredChecksFrom({})).toEqual([]);
    expect(requiredChecksFrom({ RALPH_REQUIRED_CHECKS: '   ' })).toEqual([]);
  });

  it('is what readCi counts on: an untrimmed name would make a pending check invisible', () => {
    const rollup = [{ __typename: 'CheckRun', name: 'buildkite/loggd', status: 'IN_PROGRESS' }];
    const gh = (args: string[]): { ok: boolean; out: string } =>
      args.includes('pr')
        ? { ok: true, out: JSON.stringify([{ number: 7, statusCheckRollup: rollup }]) }
        : { ok: true, out: JSON.stringify({ check_runs: [], statuses: [] }) };
    const required = requiredChecksFrom({ RALPH_REQUIRED_CHECKS: '  buildkite/loggd  ' });
    expect(readCi('o/r', 'main', required, gh).busy).toBe(true);
    // The pre-fix spelling, for contrast: the same busy host reads as idle.
    expect(readCi('o/r', 'main', ['  buildkite/loggd  '], gh).busy).toBe(false);
  });
});
