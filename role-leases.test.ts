// @vitest-environment node
/**
 * Role-owned leases: the heartbeat renews the store the running role declares
 * (felipearos/ralph#138).
 *
 * The two rules these pin: a run renews its OWN leases and nothing else, and a
 * lease is cleared when its holder is gone — never merely because it expired,
 * which is the holder's own beat to answer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { CASE_LEASE_SECONDS, emptyStore as emptyCiHealthStore, readStore as readCiHealthStore, storePathFromGit } from './ci-doctor/store';
import { ROLES } from './roles';
import { subprocessSuite } from './test-timeouts';
import { CHECK_IN_LEASE_SECONDS, emptyStore as emptyVerifierStore, readStore as readVerifierStore, storePathFromGit as verifierStorePathFromGit } from './verifier/watches';
import {
  DEFAULT_ROLE_LEASE_SECONDS,
  ROLE_LEASE_STORES,
  renewRoleLeaseStore,
  renewRoleLeases,
  type RoleLease,
  type RoleLeaseStore,
} from './role-leases';

// The stores' paths come from `git rev-parse --git-common-dir`, here and in the heartbeat.
subprocessSuite('git rev-parse for the lease stores\' paths');

const T0 = Date.parse('2026-09-30T08:00:00Z');
const here = process.env.HOSTNAME ?? hostname();
const temps: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ralph-role-leases-'));
  temps.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const lease = (over: Partial<RoleLease> = {}): RoleLease => ({
  run: 'run-a',
  loop: 'ralph',
  pid: process.pid,
  host: here,
  expiresAt: new Date(T0 - 60_000).toISOString(),
  ...over,
});

describe('renewRoleLeases', () => {
  it('renews only the leases whose run and loop both match', () => {
    const store: RoleLeaseStore = {
      leases: {
        mine: lease(),
        'other-run': lease({ run: 'run-b' }),
        'other-loop': lease({ loop: 'rafa' }),
      },
    };

    const done = renewRoleLeases(store, { run: 'run-a', loop: 'ralph' }, T0);

    expect(done.renewed).toEqual(['mine']);
    expect(store.leases!.mine!.expiresAt).toBe(new Date(T0 + DEFAULT_ROLE_LEASE_SECONDS * 1000).toISOString());
    // The other two are live holders: untouched, not pruned.
    expect(done.pruned).toEqual([]);
    expect(store.leases!['other-run']!.expiresAt).toBe(lease().expiresAt);
    expect(store.leases!['other-loop']!.expiresAt).toBe(lease().expiresAt);
  });

  it('prunes a lease whose holder is dead, and keeps an expired lease whose holder runs', () => {
    const store: RoleLeaseStore = {
      leases: { gone: lease({ run: 'run-b', pid: 1234 }), busy: lease({ run: 'run-c', pid: 5678 }) },
    };

    const done = renewRoleLeases(store, { run: 'run-a', loop: 'ralph' }, T0, {
      alive: (holder) => holder.pid !== 1234,
    });

    expect(done.pruned).toEqual(['gone']);
    expect(Object.keys(store.leases!)).toEqual(['busy']);
  });

  it('never prunes this run own lease, whatever the pid check says', () => {
    const store: RoleLeaseStore = { leases: { mine: lease({ pid: 999_999 }) } };

    const done = renewRoleLeases(store, { run: 'run-a', loop: 'ralph' }, T0, { alive: () => false });

    expect(done).toEqual({ renewed: ['mine'], pruned: [] });
  });

  it('takes a dead pid on another host as alive', () => {
    const store: RoleLeaseStore = { leases: { elsewhere: lease({ run: 'run-b', pid: 999_999, host: 'another-box' }) } };

    const done = renewRoleLeases(store, { run: 'run-a', loop: 'ralph' }, T0);

    expect(done.pruned).toEqual([]);
    expect(store.leases!.elsewhere).toBeDefined();
  });

  it('handles a store with no leases at all', () => {
    const store: RoleLeaseStore = {};

    expect(renewRoleLeases(store, { run: 'run-a', loop: 'ralph' }, T0)).toEqual({ renewed: [], pruned: [] });
  });
});

describe('renewRoleLeaseStore', () => {
  it('answers null for a role with no store, and reads nothing', async () => {
    const dir = tempDir();

    for (const role of [null, undefined, '', 'coder', 'triager']) {
      expect(await renewRoleLeaseStore(role, { run: 'run-a', loop: 'ralph' }, { cwd: dir })).toBeNull();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('renews and prunes the ci-doctor store on disk', async () => {
    const dir = tempDir();
    const path = storePathFromGit(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        ...emptyCiHealthStore(),
        leases: {
          'flake:a': { run: 'run-a', loop: 'ralph', pid: process.pid, host: here, expiresAt: new Date(T0).toISOString() },
          'flake:b': { run: 'run-b', loop: 'rafa', pid: 999_999, host: here, expiresAt: new Date(T0).toISOString() },
        },
      })}\n`,
    );

    const done = await renewRoleLeaseStore(
      'ci-doctor',
      { run: 'run-a', loop: 'ralph' },
      { nowMs: T0, cwd: dir },
    );

    expect(done).toMatchObject({ what: 'the ci-health store', renewed: ['flake:a'], pruned: ['flake:b'] });
    expect(existsSync(path)).toBe(true);
    const written = readCiHealthStore(path);
    expect(Object.keys(written.leases)).toEqual(['flake:a']);
    expect(written.leases['flake:a']!.expiresAt).toBe(new Date(T0 + DEFAULT_ROLE_LEASE_SECONDS * 1000).toISOString());
  });

  it('renews the verifier check-in lease for its holder', async () => {
    const dir = tempDir();
    const path = verifierStorePathFromGit(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        ...emptyVerifierStore(),
        leases: {
          '7@1': { run: 'run-a', loop: 'sena', pid: process.pid, host: here, expiresAt: new Date(T0).toISOString() },
        },
      })}\n`,
    );

    const done = await renewRoleLeaseStore('verifier', { run: 'run-a', loop: 'sena' }, { nowMs: T0, cwd: dir });

    expect(done).toMatchObject({ what: 'the verifier watch store', renewed: ['7@1'], pruned: [] });
    expect(readVerifierStore(path).leases['7@1']!.expiresAt).toBe(new Date(T0 + CHECK_IN_LEASE_SECONDS * 1000).toISOString());
  });

  it('registers the ci-doctor store, and every registration can be used', () => {
    // Not `Object.keys(...) === ['ci-doctor']`: the point of the registry is
    // that the next role adds an entry, and a test that fails on that would
    // only ever be deleted.
    expect(ROLE_LEASE_STORES['ci-doctor']!.leaseMs).toBe(CASE_LEASE_SECONDS * 1000);
    for (const [role, registration] of Object.entries(ROLE_LEASE_STORES)) {
      expect(ROLES, role).toContain(role);
      expect(registration.leaseMs, role).toBeGreaterThan(0);
      expect(registration.path(tempDir()), role).toMatch(/^\//);
    }
  });

  it('refuses a role nobody declared rather than renewing nothing', async () => {
    // The silent version of this lets a typo'd RALPH_LOOP_ROLE lapse the very
    // lease the beat exists to renew.
    await expect(renewRoleLeaseStore('ci_doctor', { run: 'run-a', loop: 'ralph' })).rejects.toThrow(/unknown role/);
  });

  it('takes no lock and writes nothing when there is nothing to renew', async () => {
    const dir = tempDir();
    const path = storePathFromGit(dir);
    writeFileSync(path, `${JSON.stringify({
      ...emptyCiHealthStore(),
      cursor: '2026-09-30T00:00:00Z',
      leases: { 'flake:theirs': { run: 'run-b', loop: 'rafa', pid: process.pid, host: here, expiresAt: new Date(T0).toISOString() } },
    })}\n`);
    const before = readFileSync(path, 'utf8');

    const done = await renewRoleLeaseStore('ci-doctor', { run: 'run-a', loop: 'ralph' }, { nowMs: T0, cwd: dir });

    expect(done).toMatchObject({ renewed: [], pruned: [] });
    // Byte-identical: `withStore` writes whatever its critical section leaves,
    // so a beat with no work must not enter it — it would rewrite the whole
    // scan cache every 30s, and truncate it outright on a version it cannot read.
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('does not create the store for a ci-doctor that holds no lease', async () => {
    const dir = tempDir();

    const done = await renewRoleLeaseStore('ci-doctor', { run: 'run-a', loop: 'ralph' }, { nowMs: T0, cwd: dir });

    expect(done).toMatchObject({ renewed: [], pruned: [] });
    expect(readdirSync(dir)).toEqual([]);
  });
});
