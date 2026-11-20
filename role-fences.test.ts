// @vitest-environment node
/**
 * The claim fences across roles. A triager's or a ci-doctor's `-wip` must keep
 * coders off an issue, and a coder's must keep them off it: every fence reads
 * every roster name, whatever its role. Pinned at the fence functions against
 * a project whose roster mixes both forms — its own file, because the fences
 * resolve the roster once per process.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupFixtures, scratchProject } from './dashboard/fixtures';
import { provenance } from './frontier-gate';
import {
  buildTickets,
  claimObstruction,
  classify,
  currentLoop,
  loopClaimObstruction,
  loopRoster,
  loopRosterEntries,
  stuckLabelOf,
  wipLabelOf,
  type LiveIssue,
  type RawIssue,
} from './frontier/next-tasks';
import { routableLoops, reservedLabels, validateJav } from './jav';
import { loopsWithRole } from './roster';

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

process.env.RALPH_PROJECT_OWNER = 'felipearosr';
process.env.RALPH_PROJECT = scratchProject('role-fences', [
  'ralph',
  { name: 'tria', role: 'triager' },
  'rafa',
  { name: 'doc', role: 'ci-doctor' },
]);

const live = (labels: string[]): LiveIssue => ({ assignees: [], labels: labels.map((name) => ({ name })) });

const issue = (number: number, labels: string[]): RawIssue => ({
  number,
  title: `ticket ${number}`,
  body: '## What to build\n\nStuff.\n',
  labels: labels.map((name) => ({ name })),
  assignees: [],
});

describe('a roster that mixes roles', () => {
  it('fences on every name, whatever its role', () => {
    expect(loopRoster()).toEqual(['ralph', 'tria', 'rafa', 'doc']);
    expect(loopsWithRole('coder')).toEqual(['ralph', 'rafa']);
    expect(loopsWithRole('triager')).toEqual(['tria']);
    expect(loopsWithRole('ci-doctor')).toEqual(['doc']);
  });

  it("reads a role loop's claim and wedge like a coder's", () => {
    expect(wipLabelOf(['ready-for-agent', 'tria-wip'])).toBe('tria-wip');
    expect(wipLabelOf(['doc-wip'])).toBe('doc-wip');
    expect(stuckLabelOf(['doc-blocked'])).toBe('doc-blocked');
    expect(stuckLabelOf(['tria-blocked'])).toBe('tria-blocked');
  });

  it("keeps a coder off an issue a role loop holds, at both claim paths", async () => {
    for (const label of ['tria-wip', 'tria-blocked', 'doc-wip', 'doc-blocked']) {
      expect(await claimObstruction(live([label]))).toBe(`labeled ${label}`);
      expect(await loopClaimObstruction(live([label]))).toBe(`labeled ${label}`);
    }
  });

  it("keeps a role loop off an issue a coder holds", async () => {
    // A role loop is a loop identity like any other; the fence it asks is the same one.
    expect(currentLoop({ RALPH_LOOP_NAME: 'tria' }, null)).toBe('tria');
    expect(currentLoop({ RALPH_LOOP_NAME: 'doc' }, null)).toBe('doc');
    expect(await claimObstruction(live(['ralph-wip']))).toBe('labeled ralph-wip');
    expect(await loopClaimObstruction(live(['rafa-blocked']))).toBe('labeled rafa-blocked');
  });

  it("refuses a ticket the live read calls closed, before any other fence and past a rescue", async () => {
    // A search index or census snapshot can lag a status move; the live read wins.
    const closed: LiveIssue = { ...live(['ready-for-agent']), state: 'closed', status: 'Mergeado' };
    expect(await claimObstruction(closed)).toBe('closed (Mergeado)');
    expect(await loopClaimObstruction(closed)).toBe('closed (Mergeado)');
    expect(await claimObstruction({ ...closed, status: '' })).toBe('closed');
    const rescue: LiveIssue = { ...live(['rafa-blocked']), state: 'closed', status: 'Mergeado' };
    expect(await loopClaimObstruction(rescue, undefined, { rescuable: ['rafa-blocked'] })).toBe('closed (Mergeado)');
    expect(await loopClaimObstruction({ ...rescue, state: 'open' }, undefined, { rescuable: ['rafa-blocked'] })).toBeNull();
    expect(await claimObstruction({ ...live(['ralph-wip']), state: 'open', status: 'Todo' })).toBe('labeled ralph-wip');
    expect(await claimObstruction(live(['ready-for-agent']))).toBeNull();
    expect(await loopClaimObstruction(live(['ready-for-agent']))).toBeNull();
  });

  it("leaves an issue a role loop claimed out of the coders' ready set", () => {
    const raw = [issue(1, ['ready-for-agent']), issue(2, ['ready-for-agent', 'tria-wip']), issue(3, ['ready-for-agent', 'doc-wip'])];
    const frontier = classify(buildTickets(raw, raw.map(() => [])), []);
    expect(frontier.readyTasks.map((ticket) => ticket.number)).toEqual([1]);
    expect(frontier.inFlight.map((ticket) => ticket.number).sort()).toEqual([2, 3]);
  });

  it("offers Jav a route only to the coders, off the roster the frontier resolves", () => {
    // The roster the frontier hands Jav carries roles, so a `routes.tria` in
    // `jav.json` is refused where a bare-name roster would have accepted it.
    const roster = loopRosterEntries();
    expect(routableLoops(roster)).toEqual(['ralph', 'rafa']);
    const block = { enabled: true, labels: ['difficulty:easy'], routes: { ralph: ['difficulty:easy'], rafa: ['difficulty:easy'] } };
    expect(validateJav(block, roster).problems).toEqual([]);
    expect(validateJav({ ...block, routes: { ...block.routes, tria: ['difficulty:easy'] } }, roster).problems).toEqual([
      "'tria' is a triager, which never takes frontier work; route targets are ralph, rafa, or default",
    ]);
  });

  it("reserves every loop's labels from Jav's routing", () => {
    const reserved = reservedLabels(loopRoster());
    for (const loop of ['ralph', 'tria', 'rafa', 'doc']) {
      expect(reserved).toEqual(expect.arrayContaining([`${loop}-wip`, `${loop}-blocked`, `${loop}-done`]));
    }
  });

  it("recognises a pull request a role loop opened as the loops' own", () => {
    expect(provenance().exec('Fixes CI.\n\n🤖 doc loop · run doc-run-1')?.[1]).toBe('doc');
    expect(provenance().exec('🤖 tria loop')?.[1]).toBe('tria');
    expect(provenance().exec('🤖 ralph loop')?.[1]).toBe('ralph');
    expect(provenance().test('🤖 nova loop')).toBe(false);
  });
});
