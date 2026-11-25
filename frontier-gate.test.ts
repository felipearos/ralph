// @vitest-environment node
/**
 * What the frontier gate promises the supervisor.
 *
 * Three properties are worth pinning, and they fail in different ways:
 *
 *   1. *It claims only when the supervisor asks, and only at report time.*
 *      Every poll asks the frontier with `--dry-run`, and a hand-run `--once`
 *      writes nothing at all. With `--claim`, a coder's frontier ticket is
 *      claimed by one real `--take-one` (same fences as the dry run) right
 *      before the gate reports it, and is reported only if the claim was won —
 *      never for a triager, a closure pick, or a poll whose pull request or
 *      claim list was unreadable. The subprocess tests record every argv the
 *      gate issues and assert on it, because that is where the rule lives.
 *   2. *It counts a shepherdable pull request as work.* `prompt.md` §1 puts
 *      shepherding ahead of the frontier, so a gate that asked the frontier
 *      alone would park a supervisor forever beside its own open pull request
 *      — an idle loop with work sitting in front of it, and nothing in the log
 *      saying so.
 *   3. *It waits rather than exiting, and says that it is waiting.* An idle
 *      supervisor and a dead one are the same process table entry; the poll
 *      line is the only thing that tells them apart.
 *
 * `bun` and `gh` are faked on PATH rather than mocked in-process, because the
 * seam the gate depends on is the subprocess: its argv, its stdout, its exit
 * code. The script itself is launched through the real bun found before PATH
 * is shimmed. Nothing here touches the network, GitHub, or a real ticket.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  adoptedBy,
  CLAIM_HELD_NOTE,
  claimVerdict,
  closableParent,
  decide,
  formatDuration,
  frontierOutcome,
  holdBudgetLine,
  holdDecision,
  holdReleasedLine,
  gateResume,
  liveClaims,
  rateLimitMaxSeconds,
  rateLimitWaitSeconds,
  controlSliceSeconds,
  parseInterval,
  parsePick,
  parsePlanFences,
  secretRereadDue,
  secretRereadPoll,
  secretRereadLine,
  shepherdable,
  sleepInSlices,
  supervisorGone,
  supervisorPidFrom,
  waitingLine,
  type PullRequest,
  type TakeOnePick,
} from './frontier-gate';
import { cleanupFixtures, scratchProject } from './dashboard/fixtures';
import { subprocessSuite } from './test-timeouts';
import { scratchDir } from './test-scratch';
import { readHeld, releaseHeld, writeHeld, type HeldVerdict } from './gate-verdict-store';

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite('runs the frontier gate under bun with fake gh');

const REPO_ROOT = __dirname;
const GATE = join(REPO_ROOT, 'frontier-gate.ts');
// The provenance stamp names the project's loops. The in-process reads resolve
// the roster from loggd's mirrored config, as the gate subprocesses below do.
process.env.RALPH_PROJECT = join(REPO_ROOT, 'fixtures', 'loggd');

const pick = (over: Partial<TakeOnePick> = {}): TakeOnePick => ({
  ticket: null,
  title: null,
  claimed: false,
  obstructed: [],
  ...over,
});

/** A checkout with nothing to recover: detached, clean, nothing ahead. */
const CLEAN = { branch: null, ahead: 0, dirty: false } as const;

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  isDraft: false,
  body: 'ordinary body',
  ...over,
});

const STAMPED = '🤖 Ralph loop — run `ralph-run-20260820T100000-42` · iteration session `abc`';
const STAMPED_RAFA = '🤖 Rafa loop — run `rafa-run-20260820T100000-43` · iteration session `def`';

describe('shepherdable', () => {
  it('takes a stamped, non-draft pull request', () => {
    expect(shepherdable([pr({ number: 7, body: STAMPED })], 'ralph')?.number).toBe(7);
  });

  it('ignores a stamped draft, which is a deliberate blocked handoff', () => {
    expect(shepherdable([pr({ isDraft: true, body: STAMPED })], 'ralph')).toBeNull();
  });

  it('ignores a stamped pull request handed to a person to merge', () => {
    // `merge: "human"`: `tracker.ts handoff` put the loop's done label on it
    // while it is still open. Only a person taking the label off hands it back.
    const handed = pr({ number: 41, body: STAMPED, labels: [{ name: 'ralph-done' }] });
    expect(shepherdable([handed], 'ralph')).toBeNull();
    expect(shepherdable([pr({ number: 41, body: STAMPED, labels: [{ name: 'rafa-done' }] })], 'ralph')?.number).toBe(41);
  });

  it('ignores an unstamped pull request even on a ralph branch', () => {
    // The branch prefix is a naming convention parallel agents share; only the
    // provenance line in the body is evidence.
    expect(shepherdable([pr({ body: 'opened by a parallel agent' })], 'ralph')).toBeNull();
  });

  it('tolerates a pull request with no body at all', () => {
    expect(shepherdable([pr({ body: null })], 'ralph')).toBeNull();
  });

  it('leaves the other loop\'s stamped pull request with its owner', () => {
    expect(shepherdable([pr({ number: 9, body: STAMPED_RAFA })], 'ralph')).toBeNull();
  });

  it('lets the matching loop resume its stamped pull request', () => {
    expect(shepherdable([pr({ number: 9, body: STAMPED_RAFA })], 'rafa')?.number).toBe(9);
  });

  it('holds the draft rule for either loop', () => {
    expect(shepherdable([pr({ isDraft: true, body: STAMPED_RAFA })], 'rafa')).toBeNull();
  });

  it('refuses a name that is not a loop, however well it imitates the stamp', () => {
    // `rafa2` has no labels and no worktree; a pull request claiming to be
    // one is a human's, and shepherding it would be taking someone's work.
    expect(
      shepherdable(
        [pr({ body: '🤖 Rafa2 loop — run `x` · iteration session `y`' })],
        'rafa',
      ),
    ).toBeNull();
  });

  // #424: a pull request another roster loop has adopted (the medic labels it
  // `<name>-wip`) is that loop's to shepherd now, not the stamping loop's.
  const label = (name: string) => ({ name });

  it('leaves a pull request another roster loop has adopted', () => {
    expect(shepherdable([pr({ body: STAMPED, labels: [label('medi-wip')] })], 'ralph')).toBeNull();
    expect(shepherdable([pr({ body: STAMPED, labels: [label('rafa-wip')] })], 'ralph')).toBeNull();
  });

  it('keeps a pull request carrying only its own loop\'s claim label', () => {
    expect(shepherdable([pr({ number: 7, body: STAMPED, labels: [label('ralph-wip')] })], 'ralph')?.number).toBe(7);
  });

  it('keeps a pull request with an unrelated label', () => {
    expect(shepherdable([pr({ number: 7, body: STAMPED, labels: [label('bug')] })], 'ralph')?.number).toBe(7);
  });

  it('ignores a -wip label naming no loop in the roster', () => {
    expect(shepherdable([pr({ number: 7, body: STAMPED, labels: [label('foo-wip')] })], 'ralph')?.number).toBe(7);
  });

  it('reads absent, non-array and malformed labels as none, without throwing', () => {
    for (const labels of [undefined, null, 'medi-wip', 42, { name: 'medi-wip' }, [null, 7, 'medi-wip', {}, { name: 3 }]]) {
      expect(adoptedBy(pr({ body: STAMPED, labels }), 'ralph')).toBeNull();
      expect(shepherdable([pr({ number: 7, body: STAMPED, labels })], 'ralph')?.number).toBe(7);
    }
  });

  // #433: a pull request the operator readied after applying its migration by
  // hand (#432) goes first, whatever order `gh pr list` returned.
  const migration = (over: Partial<PullRequest> = {}) =>
    pr({ number: 8, body: STAMPED, labels: [label('migration-applied')], ...over });

  it('prefers a migration-applied pull request in either input order', () => {
    const ordinary = pr({ number: 7, body: STAMPED });
    expect(shepherdable([ordinary, migration()], 'ralph')?.number).toBe(8);
    expect(shepherdable([migration(), ordinary], 'ralph')?.number).toBe(8);
  });

  it('matches the migration-applied label case-insensitively', () => {
    const ordinary = pr({ number: 7, body: STAMPED });
    expect(shepherdable([ordinary, migration({ labels: [label('Migration-Applied')] })], 'ralph')?.number).toBe(8);
  });

  it('still skips a migration-applied draft, another loop\'s, or an adopted one', () => {
    const ordinary = pr({ number: 7, body: STAMPED });
    expect(shepherdable([ordinary, migration({ isDraft: true })], 'ralph')?.number).toBe(7);
    expect(shepherdable([ordinary, migration({ body: STAMPED_RAFA })], 'ralph')?.number).toBe(7);
    expect(
      shepherdable([ordinary, migration({ labels: [label('migration-applied'), label('medi-wip')] })], 'ralph')?.number,
    ).toBe(7);
    expect(shepherdable([migration({ isDraft: true })], 'ralph')).toBeNull();
  });

  it('takes the first match when no candidate is migration-applied, whatever the labels look like', () => {
    for (const labels of [undefined, null, [], 'migration-applied', 42, { name: 'migration-applied' }, [null, 7, 'migration-applied', {}, { name: 3 }]]) {
      const prs = [pr({ number: 7, body: STAMPED, labels }), pr({ number: 8, body: STAMPED, labels })];
      expect(shepherdable(prs, 'ralph')?.number).toBe(7);
    }
  });
});

describe('decide with an adopted claim (#424)', () => {
  const adopted = (branch: string): PullRequest =>
    pr({ number: 70, body: STAMPED, headRefName: branch, labels: [{ name: 'medi-wip' }] });

  it('passes an adopted sole claim over for the frontier ticket', () => {
    const verdict = decide({
      prs: [adopted('ralph/628-fix-it')],
      pick: pick({ ticket: 601, title: 'Do the thing' }),
      claims: [{ number: 628 }],
      localRecovery: CLEAN,
    });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#601');
    expect(verdict.why).not.toContain('#628');
  });

  it('stops exactly as with no claims when the adopted claim was the only work', () => {
    const none = decide({ prs: [], pick: pick(), claims: [], localRecovery: CLEAN });
    const verdict = decide({
      prs: [adopted('ralph/628-fix-it')],
      pick: pick(),
      claims: [{ number: 628 }],
      localRecovery: CLEAN,
    });
    expect(verdict).toEqual(none);
    expect(verdict).not.toHaveProperty('undetermined');
  });

  it('still resumes a claim nobody adopted', () => {
    const verdict = decide({
      // A draft, so the shepherd answer does not pre-empt the claim this pins.
      prs: [pr({ number: 70, isDraft: true, body: STAMPED, headRefName: 'ralph/628-fix-it' })],
      pick: pick(),
      claims: [{ number: 628 }],
    });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#628');
  });

  it('still resumes the claim when the pull requests could not be read', () => {
    const verdict = decide({ prs: null, pick: pick(), claims: [{ number: 628 }] });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#628');
  });

  it('does not drop a claim for an adopted pull request on another ticket\'s branch', () => {
    const verdict = decide({ prs: [adopted('ralph/6280-other')], pick: pick(), claims: [{ number: 628 }] });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#628');
  });

  it('matches an adopted head branch that carries no slug', () => {
    expect(liveClaims([{ number: 628 }], [adopted('ralph/628')], 'ralph')).toEqual([]);
    expect(liveClaims([{ number: 628 }], [adopted('ralph/6280')], 'ralph')).toEqual([{ number: 628 }]);
  });

  it('leaves claims as they are when either list is unread', () => {
    expect(liveClaims(null, [adopted('ralph/628-x')], 'ralph')).toBeNull();
    expect(liveClaims(undefined, [adopted('ralph/628-x')], 'ralph')).toBeUndefined();
    expect(liveClaims([{ number: 628 }], null, 'ralph')).toEqual([{ number: 628 }]);
  });
});

describe('decide', () => {
  it('spawns for a frontier ticket', () => {
    const verdict = decide({ prs: [], pick: pick({ ticket: 601, title: 'Do the thing' }) });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#601');
  });

  it('spawns for a shepherdable pull request even with an empty frontier', () => {
    const verdict = decide({ prs: [pr({ number: 9, body: STAMPED })], pick: pick() });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#9');
  });

  it('shepherds the migration-applied pull request ahead of an ordinary one (#433)', () => {
    const verdict = decide(
      {
        prs: [
          pr({ number: 9, body: STAMPED }),
          pr({ number: 12, body: STAMPED, labels: [{ name: 'migration-applied' }] }),
        ],
        pick: pick(),
      },
      'ralph',
    );
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#12');
    expect(verdict.why).not.toContain('#9');
  });

  it('ignores the other loop\'s pull request and uses its own frontier', () => {
    const verdict = decide(
      {
        prs: [pr({ number: 9, body: STAMPED_RAFA })],
        pick: pick({ ticket: 656, title: 'Put IMDb behind the shared import run' }),
      },
      'ralph',
    );
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#656');
    expect(verdict.why).not.toContain('#9');
  });

  it('spawns for this loop\'s unfinished claim even with an empty frontier', () => {
    // The frontier tool excludes every `*-wip` ticket as claimed, so without
    // the recovery probe a supervisor whose loop holds a killed iteration's
    // half-finished work would stop beside it forever — README "Stop it"
    // promises that work is recoverable by design.
    const verdict = decide({ prs: [], pick: pick(), claims: [{ number: 628 }] });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#628');
  });

  it('spawns for local-only recovery work before the frontier', () => {
    const verdict = decide({
      prs: [],
      claims: [],
      localRecovery: { branch: 'rafa/658-background-import', ahead: 2, dirty: true },
      pick: pick(),
    }, 'rafa');

    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('local recovery work');
  });

  it('does not recover a clean loop branch with no commits ahead', () => {
    const verdict = decide({
      prs: [],
      claims: [],
      localRecovery: { branch: 'rafa/658-background-import', ahead: 0, dirty: false },
      pick: pick(),
    }, 'rafa');

    expect(verdict).toEqual({ work: false, why: 'the frontier is empty' });
  });

  it('does not recover commits already landed by a squash merge', () => {
    const verdict = decide({
      prs: [],
      claims: [],
      localRecovery: {
        branch: 'rafa/658-background-import',
        ahead: 2,
        dirty: false,
        finalizedMergedPullRequest: true,
      },
      pick: pick(),
    }, 'rafa');

    expect(verdict).toEqual({ work: false, why: 'the frontier is empty' });
  });

  it('refuses a definitive stop while the claim list could not be read', () => {
    // The stop verdicts are terminal for an ungated supervisor, so they need
    // every probe that could have surfaced work to have actually answered.
    const verdict = decide({ prs: [], pick: pick(), claims: null });
    expect(verdict).toMatchObject({ work: false, undetermined: true });
  });

  it('waits on an empty frontier with nothing to shepherd', () => {
    expect(decide({ prs: [], pick: pick() })).toEqual({ work: false, why: 'the frontier is empty' });
  });

  it('names the work waiting on an operator behind an empty frontier (#811)', () => {
    const verdict = decide({
      prs: [],
      pick: pick({ waitingOnOperator: { 'ready-for-human': 1, 'needs-info': 0, held: 2, untriaged: 0 } }),
    });
    expect(verdict).toEqual({
      work: false,
      why: 'the frontier is empty — 3 waiting on an operator (ready-for-human 1, held 2)',
    });
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['all zeros', { 'ready-for-human': 0, 'needs-info': 0, held: 0, untriaged: 0 }],
    ['a string', 'ready-for-human 1'],
    ['null', null],
    ['an array', [1, 2]],
    ['a negative count', { 'ready-for-human': 2, held: -1 }],
    ['a non-integer count', { 'ready-for-human': 1.5 }],
    ['a reason this gate does not know', { 'ready-for-human': 1, 'needs-decision': 4 }],
  ])('keeps the plain empty verdict when waitingOnOperator is %s', (_label, field) => {
    // A malformed signal falls back to the pre-#811 line, never a wrong count.
    const verdict = decide({ prs: [], pick: pick({ waitingOnOperator: field }) });
    expect(verdict).toEqual({ work: false, why: 'the frontier is empty' });
  });

  it('distinguishes a fully-held frontier from a drained one', () => {
    const verdict = decide({ prs: [], pick: pick({ obstructed: [{ number: 12, reason: 'ralph-wip' }] }) });
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain('#12');
    expect(verdict.why).not.toContain('empty');
  });

  it('reports an unreadable frontier as undetermined rather than as empty', () => {
    // A network blip must not be logged as "the backlog is drained": that is
    // the one message a human reads as "nothing left to do".
    expect(decide({ prs: [], pick: null })).toEqual({
      work: false,
      undetermined: true,
      why: 'the frontier could not be read',
    });
  });

  it('reports an unreadable pull request list as undetermined, not as an empty frontier', () => {
    expect(decide({ prs: null, pick: pick() })).toEqual({
      work: false,
      undetermined: true,
      why: 'open PRs could not be read',
    });
  });

  it('still spawns on a known ticket when the shepherd probe is unreadable', () => {
    // The gate is a boolean and never chooses the work: §0 re-lists the PRs
    // and §1 re-orders inside the iteration, so a stamped PR is still found
    // and shepherded. Vetoing here would let a persistently malformed
    // `gh pr list` block the loop forever while tickets sat ready — the exact
    // deadlock this file exists to prevent.
    const verdict = decide({ prs: null, pick: pick({ ticket: 601, title: 'Do the thing' }) });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#601');
    // But the failed probe must not vanish from the report.
    expect(verdict.why).toContain('open PRs unreadable');
  });

  it('carries the same caveat when it spawns on a closable spec', () => {
    const verdict = decide({ prs: null, pick: pick(), closableParent: 528 });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#528');
    expect(verdict.why).toContain('open PRs unreadable');
  });

  it('says nothing about PRs when they were readable', () => {
    const verdict = decide({ prs: [], pick: pick({ ticket: 601, title: 'Do the thing' }) });
    expect(verdict.why).not.toContain('unreadable');
  });

  it('reports both probes failing as one undetermined answer', () => {
    expect(decide({ prs: null, pick: null })).toEqual({
      work: false,
      undetermined: true,
      why: 'neither probe could be read',
    });
  });

  it('names a throttled frontier as rate-limited, still undetermined', () => {
    // 2026-09-28: ~30 polls logged "the frontier could not be read" for what
    // was GitHub throttling four loops on one account. Undetermined all the
    // same — it says nothing about the backlog and must never stop a loop.
    expect(decide({ prs: [], pick: null, frontierRateLimit: { retryAfterSeconds: 60 } })).toEqual({
      work: false,
      undetermined: true,
      rateLimited: true,
      retryAfterSeconds: 60,
      why: 'GitHub rate-limited the frontier read (GitHub asked for 60s)',
    });
    const alsoNoPrs = decide({ prs: null, pick: null, frontierRateLimit: { retryAfterSeconds: null } });
    expect(alsoNoPrs).toMatchObject({ work: false, undetermined: true, rateLimited: true });
    expect(alsoNoPrs.why).toBe('GitHub rate-limited the frontier read');
  });

  it('still spawns on a shepherdable PR while the frontier is throttled', () => {
    const verdict = decide(
      { prs: [pr({ number: 9, body: STAMPED })], pick: null, frontierRateLimit: { retryAfterSeconds: 60 } },
      'ralph',
    );
    expect(verdict.work).toBe(true);
  });
});

describe('claimVerdict', () => {
  const context = {
    probes: { prs: [], pick: null, claims: [], localRecovery: CLEAN },
    loop: 'rafa' as const,
    offered: 601,
  };

  it('reports a won claim as work naming the claimed ticket, marked held', () => {
    const verdict = claimVerdict(
      { pick: pick({ ticket: 602, title: 'Next', claimed: true, obstructed: [{ number: 601, reason: 'raced' }] }), rateLimit: null },
      context,
    );
    expect(verdict).toEqual({ work: true, why: `frontier ticket #602 — Next${CLAIM_HELD_NOTE}` });
    expect(verdict.why).toMatch(/^frontier ticket #([0-9]+)/);
    expect(CLAIM_HELD_NOTE).toContain('claim held by this loop');
  });

  it('words a claimed closure parent as the closure task, still held', () => {
    const verdict = claimVerdict(
      { pick: pick({ ticket: 50, title: 'Spec', claimed: true, closure: true }), rateLimit: null },
      context,
    );
    expect(verdict).toEqual({
      work: true,
      why: `spec #50 has no open children left — closing it is the task${CLAIM_HELD_NOTE}`,
    });
    expect(verdict.why).not.toMatch(/^frontier ticket #/);
  });

  it('reports a lost race through decide, as held or empty', () => {
    const held = claimVerdict(
      { pick: pick({ claimed: false, obstructed: [{ number: 601, reason: 'labeled rafa-wip' }] }), rateLimit: null },
      context,
    );
    expect(held).toEqual({ work: false, why: 'claim race lost for #601 — every frontier candidate is held (#601)' });
    const empty = claimVerdict({ pick: pick({ claimed: false }), rateLimit: null }, context);
    expect(empty).toEqual({ work: false, why: 'claim race lost for #601 — the frontier is empty' });
  });

  it('never reports an unclaimed ticket as work', () => {
    const verdict = claimVerdict({ pick: pick({ ticket: 601, title: 'X', claimed: false }), rateLimit: null }, context);
    expect(verdict.work).toBe(false);
  });

  it('waits undetermined on an unreadable or throttled claim run', () => {
    const unreadable = claimVerdict({ pick: null, rateLimit: null }, context);
    expect(unreadable).toMatchObject({ work: false, undetermined: true });
    expect(unreadable.why).toContain('the frontier could not be read');
    const throttled = claimVerdict({ pick: null, rateLimit: { retryAfterSeconds: 30 } }, context);
    expect(throttled).toMatchObject({ work: false, undetermined: true, rateLimited: true, retryAfterSeconds: 30 });
  });
});

describe('frontierOutcome', () => {
  it('reads a throttled failure as rate-limited and any other failure as unreadable', () => {
    const throttled = JSON.stringify({ ...pick(), error: 'GitHub rate limit', rateLimited: true, retryAfterSeconds: 40 });
    expect(frontierOutcome(false, throttled)).toEqual({ pick: null, rateLimit: { retryAfterSeconds: 40 } });
    // A failed run's JSON looks like an empty frontier; it must not be read as one.
    const failed = JSON.stringify({ ...pick(), error: 'lock timeout', rateLimited: false });
    expect(frontierOutcome(false, failed)).toEqual({ pick: null, rateLimit: null });
    expect(frontierOutcome(true, JSON.stringify(pick({ ticket: 5 })))).toMatchObject({
      pick: { ticket: 5 },
      rateLimit: null,
    });
  });
});

describe('rateLimitWaitSeconds', () => {
  const base = { intervalSeconds: 300, retryAfterSeconds: null, maxSeconds: 1800 };

  it('grows with consecutive throttled polls, up to the cap', () => {
    const mid = (): number => 0.5; // no jitter
    expect([1, 2, 3, 4, 5].map((streak) => rateLimitWaitSeconds({ ...base, streak }, mid))).toEqual([
      300, 600, 1200, 1800, 1800,
    ]);
  });

  it('jitters ±25% so loops throttled together drift apart', () => {
    expect(rateLimitWaitSeconds({ ...base, streak: 1 }, () => 0)).toBe(225);
    expect(rateLimitWaitSeconds({ ...base, streak: 1 }, () => 0.999)).toBe(375);
  });

  it('never waits less than GitHub asked for', () => {
    const asked = { ...base, retryAfterSeconds: 3600, streak: 1 };
    expect(rateLimitWaitSeconds(asked, () => 0)).toBeGreaterThanOrEqual(3600);
  });

  it('reads the cap from the environment', () => {
    expect(rateLimitMaxSeconds(undefined)).toBe(1800);
    expect(rateLimitMaxSeconds('600')).toBe(600);
    expect(rateLimitMaxSeconds('nope')).toBe(1800);
  });
});

describe('parsePlanFences', () => {
  const PLAN = [
    '# Ralph plan — scope fences',
    '',
    'Prose mentioning #999 above any heading.',
    '',
    '## Out of scope — never pick',
    '',
    '- #228 (Renovate dashboard), #65 (held for music launch), #428 (HITL only).',
    '',
    '## Parent closure exceptions',
    '',
    '- Parent/spec issues: #542, #507, #528.',
    '',
  ].join('\n');

  it('reads both lists, and nothing from outside them', () => {
    expect(parsePlanFences(PLAN)).toEqual({
      outOfScope: [228, 65, 428],
      closureParents: [542, 507, 528],
    });
  });

  it('is empty for a plan with neither heading', () => {
    expect(parsePlanFences('# nothing here')).toEqual({ outOfScope: [], closureParents: [] });
  });

  // An issue number inside an HTML comment IS a fence: the section is read as
  // raw text up to the next heading, and `/#(\d+)/` does not know what a
  // comment is. Pinned because it reads as a bug and is load-bearing for the
  // guard in `ralph-fragments.test.ts` — #299 recorded a lifted hold in a
  // comment under this heading and silently re-fenced two of its numbers.
  it("reads a number out of an HTML comment, which is why a plan must not put one there", () => {
    expect(parsePlanFences('## Out of scope — never pick\n\n<!-- #42 was held, then merged. -->\n')).toEqual(
      { outOfScope: [42], closureParents: [] },
    );
  });
});

describe('closableParent', () => {
  const parent = { number: 528, body: '# spec' };
  const child = { number: 540, body: '## Parent\n\n#528\n' };

  it('finds an open spec whose children are all closed', () => {
    // prompt.md §1 makes closing this the iteration's task when the frontier
    // is empty. Without the probe a gated supervisor parks on "empty" while
    // an iteration would have had work — a stall the ungated one never had.
    expect(closableParent([528], [parent])).toBe(528);
  });

  it('leaves a spec alone while a child is still open', () => {
    expect(closableParent([528], [parent, child])).toBeNull();
  });

  it('ignores a spec that is already closed', () => {
    expect(closableParent([528], [child])).toBeNull();
  });

  it('only considers specs the plan lists', () => {
    expect(closableParent([], [parent])).toBeNull();
  });

  // #810: the frontier now claims a closure parent itself, so one a roster
  // loop already holds, or anyone is assigned to, is somebody's work.
  it("skips a parent carrying a roster loop's -wip or -blocked label", () => {
    expect(closableParent([528], [{ ...parent, labels: ['rafa-wip'] }])).toBeNull();
    expect(closableParent([528], [{ ...parent, labels: ['ralph-blocked'] }])).toBeNull();
  });

  it('skips a parent with an assignee', () => {
    expect(closableParent([528], [{ ...parent, labels: [], assignees: ['someone'] }])).toBeNull();
  });

  it('still finds a parent with no claim, no block and no assignee', () => {
    expect(closableParent([528], [{ ...parent, labels: ['spec'], assignees: [] }])).toBe(528);
  });
});

describe('decide with a closable spec', () => {
  it('counts it as work when the frontier is empty', () => {
    const verdict = decide({ prs: [], pick: pick(), closableParent: 528 });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain('#528');
  });

  it('still prefers the frontier ticket, as prompt.md §1 orders it', () => {
    const verdict = decide({ prs: [], pick: pick({ ticket: 601 }), closableParent: 528 });
    expect(verdict.why).toContain('#601');
  });

  it('ignores it when the frontier is held rather than empty', () => {
    // §1: "If it is empty WITH NO OBSTRUCTIONS, first check the Parent closure
    // exceptions." A held frontier is not an empty one, and spawning on
    // maintenance here would take a task the iteration would not have taken.
    const verdict = decide({
      prs: [],
      pick: pick({ obstructed: [{ number: 12, reason: 'ralph-wip' }] }),
      closableParent: 528,
    });
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain('#12');
  });

  it('names a closure parent the frontier handed out as a claimed unit (#810)', () => {
    const verdict = decide({ prs: [], pick: pick({ ticket: 50, title: 'Spec', closure: true }) });
    expect(verdict.work).toBe(true);
    expect(verdict.why).toBe('spec #50 has no open children left — closing it is the task');
  });

  it('ignores it when the frontier could not be read at all', () => {
    const verdict = decide({ prs: [], pick: null, closableParent: 528 });
    expect(verdict.work).toBe(false);
    expect(verdict.why).toBe('the frontier could not be read');
  });
});

describe('supervisorPidFrom', () => {
  it('prefers the pid ralph.sh exported, and falls back to the parent', () => {
    // A gate run by hand has no RALPH_SUPERVISOR_PID and serves the shell that
    // started it; a pid of 0, empty or non-numeric is no process to ask about.
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: '4321' }, 99)).toBe(4321);
    expect(supervisorPidFrom({}, 99)).toBe(99);
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: '' }, 99)).toBe(99);
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: 'abc' }, 99)).toBe(99);
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: '0' }, 99)).toBe(99);
  });
});

describe('secretRereadDue (#759)', () => {
  const gate = { RALPH_ROLE_SECRETS_GATE: 'RALPH_X_TOKEN A_TOKEN B_TOKEN' };

  it('is due only when the supervisor understands the hand-back and a secret is unread', () => {
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_UNREAD: 'RALPH_X_TOKEN' }, 1)).toBe(true);
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_UNREAD: ' A_TOKEN\tB_TOKEN ' }, 1)).toBe(true);
    // An old supervisor exports the unread names but not the flag: it would
    // read the hand-back's exit 0 as work, so the gate sleeps as before.
    expect(secretRereadDue({ ...gate, RALPH_ROLE_SECRETS_UNREAD: 'RALPH_X_TOKEN' }, 1)).toBe(false);
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '0', RALPH_ROLE_SECRETS_UNREAD: 'RALPH_X_TOKEN' }, 1)).toBe(false);
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '1' }, 1)).toBe(false);
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_UNREAD: '' }, 1)).toBe(false);
    expect(secretRereadDue({ ...gate, RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_UNREAD: ' \t ' }, 1)).toBe(false);
  });

  it('is due only for an unread secret the gate itself uses', () => {
    // The coder's Buildkite read token is iteration-only: the supervisor
    // re-reads it before each iteration, so the gate need not restart for it.
    const coder = { RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_GATE: '', RALPH_ROLE_SECRETS_UNREAD: 'RALPH_BUILDKITE_READ_TOKEN' };
    expect(secretRereadDue(coder, 1)).toBe(false);
    expect(secretRereadDue({ ...coder, RALPH_ROLE_SECRETS_GATE: undefined }, 1)).toBe(false);
    expect(secretRereadDue({ ...coder, RALPH_ROLE_SECRETS_GATE: 'RALPH_SENTRY_TOKEN' }, 1)).toBe(false);
    expect(
      secretRereadDue({ ...coder, RALPH_ROLE_SECRETS_GATE: 'RALPH_SENTRY_TOKEN', RALPH_ROLE_SECRETS_UNREAD: 'RALPH_BUILDKITE_READ_TOKEN RALPH_SENTRY_TOKEN' }, 1),
    ).toBe(true);
  });

  it('backs off: polls 1, 2, 4, 8, then every 12th from 24', () => {
    const env = { ...gate, RALPH_SECRET_REREAD: '1', RALPH_ROLE_SECRETS_UNREAD: 'RALPH_X_TOKEN' };
    const due = Array.from({ length: 60 }, (_, index) => index + 1).filter((poll) => secretRereadDue(env, poll));
    expect(due).toEqual([1, 2, 4, 8, 24, 36, 48, 60]);
    expect(secretRereadPoll(0)).toBe(false);
    expect(secretRereadPoll(-4)).toBe(false);
    expect(secretRereadPoll(2.5)).toBe(false);
  });

  it('names the gate in a line ralph.sh matches', () => {
    expect(secretRereadLine('clerk-gate')).toBe('clerk-gate: secret re-read due — handing back to the supervisor');
    expect(secretRereadLine('clerk-gate')).toMatch(/^[A-Za-z0-9_.-]+: secret re-read due/);
  });

  it("carries the poll's own wait, so the supervisor sleeps out a throttled gate's longer one", () => {
    expect(secretRereadLine('ci-doctor-gate', 912.4)).toBe(
      'ci-doctor-gate: secret re-read due — handing back to the supervisor — poll again in 912s',
    );
    expect(secretRereadLine('ci-doctor-gate', 300, 8)).toBe(
      'ci-doctor-gate: secret re-read due — handing back to the supervisor — poll again in 300s — after poll 8',
    );
  });
});

describe('gateResume (#759)', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const nowSec = now.getTime() / 1000;

  it('resumes the wait and the poll count the supervisor passed', () => {
    const resumed = gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec - 3600), RALPH_GATE_POLLS: '12' }, now);
    expect(resumed.waitingSince.getTime()).toBe((nowSec - 3600) * 1000);
    expect(resumed.firstPoll).toBe(13);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec), RALPH_GATE_POLLS: '0' }, now).firstPoll).toBe(1);
  });

  it('starts a fresh wait when either value is missing or malformed', () => {
    const fresh = { waitingSince: now, firstPoll: 1 };
    expect(gateResume({}, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec - 60) }, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_POLLS: '3' }, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: 'yesterday', RALPH_GATE_POLLS: '3' }, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec - 60), RALPH_GATE_POLLS: '-1' }, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec - 60), RALPH_GATE_POLLS: '2.5' }, now)).toEqual(fresh);
    expect(gateResume({ RALPH_GATE_WAITING_SINCE: '', RALPH_GATE_POLLS: '' }, now)).toEqual(fresh);
  });

  it('clamps a start in the future to now', () => {
    const resumed = gateResume({ RALPH_GATE_WAITING_SINCE: String(nowSec + 600), RALPH_GATE_POLLS: '4' }, now);
    expect(resumed.waitingSince.getTime()).toBe(now.getTime());
    expect(resumed.firstPoll).toBe(5);
  });
});

describe('supervisorGone', () => {
  it('is false for a live process, and for one owned by another user', () => {
    expect(supervisorGone(process.pid)).toBe(false);
    // pid 1 exists on every Linux host and is not ours: EPERM, still alive.
    expect(supervisorGone(1)).toBe(false);
  });

  it('is true once the process has exited', () => {
    const exited = spawnSync('true');
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeGreaterThan(0);
    expect(supervisorGone(exited.pid)).toBe(true);
  });
});

describe('parsePick', () => {
  it('reads the JSON out of the last line, past launcher chatter', () => {
    // `bun run` and `scripts/next.ts` both narrate; only the last line is the
    // answer, and a parser that took the first would read the narration.
    const stdout = '$ bun scripts/next.ts\n{"ticket":5,"title":"t","claimed":false,"obstructed":[]}\n';
    expect(parsePick(stdout)?.ticket).toBe(5);
  });

  it('is null on unparseable output rather than throwing', () => {
    expect(parsePick('gh: could not connect\n')).toBeNull();
    expect(parsePick('')).toBeNull();
  });

  it('defaults a missing obstructed list rather than crashing decide', () => {
    expect(parsePick('{"ticket":null}')?.obstructed).toEqual([]);
  });
});

describe('sleepInSlices', () => {
  // The gate used to sleep whole intervals without looking at the control
  // inbox, so a stop sent to an idle loop waited for work that never came.
  const napper = () => {
    const naps: number[] = [];
    return { naps, nap: async (s: number) => void naps.push(s) };
  };

  it('sleeps the whole interval in slices when nothing interrupts it', async () => {
    const { naps, nap } = napper();
    expect(await sleepInSlices(40, 15, () => null, nap)).toBeNull();
    expect(naps).toEqual([15, 15, 10]);
  });

  it('wakes at the first slice that finds a command waiting', async () => {
    const { naps, nap } = napper();
    let checks = 0;
    const woke = await sleepInSlices(300, 15, () => (++checks === 2 ? 'control' : null), nap);
    expect(woke).toBe('control');
    expect(naps).toEqual([15, 15]);
  });

  it('slices on the control poll interval, falling back to 15s', () => {
    expect(controlSliceSeconds('5')).toBe(5);
    expect(controlSliceSeconds(undefined)).toBe(15);
    expect(controlSliceSeconds('0')).toBe(15);
    expect(controlSliceSeconds('soon')).toBe(15);
  });
});

describe('parseInterval', () => {
  it('accepts a whole number of seconds', () => {
    expect(parseInterval('300')).toBe(300);
  });

  it.each([undefined, '', '0', '-5', '30s', '2.5'])('rejects %o', (raw) => {
    // A rejected interval stops the supervisor. An accepted bad one would make
    // `sleep` fail every cycle, turning the gate into a tight API poll.
    expect(() => parseInterval(raw)).toThrow(/whole number of seconds/);
  });
});

describe('waitingLine', () => {
  it('carries a clock and an idle duration, so idle reads differently from dead', () => {
    const line = waitingLine(
      { work: false, why: 'the frontier is empty' },
      {
        poll: 4,
        waitingSince: new Date('2026-08-20T10:00:00Z'),
        now: new Date('2026-08-20T11:15:00Z'),
        intervalSeconds: 300,
      },
    );
    expect(line).toBe(
      'frontier-gate: the frontier is empty at 2026-08-20T11:15:00Z — waiting 300s (poll 4, idle 1h15m)',
    );
  });

  it('prints the work waiting on an operator from the verdict (#811)', () => {
    const line = waitingLine(
      { work: false, why: 'the frontier is empty — 3 waiting on an operator (ready-for-human 1, held 2)' },
      {
        poll: 4,
        waitingSince: new Date('2026-08-20T10:00:00Z'),
        now: new Date('2026-08-20T11:15:00Z'),
        intervalSeconds: 300,
      },
    );
    expect(line).toBe(
      'frontier-gate: the frontier is empty — 3 waiting on an operator (ready-for-human 1, held 2) at 2026-08-20T11:15:00Z — waiting 300s (poll 4, idle 1h15m)',
    );
  });
});

describe('holdDecision (#771)', () => {
  const NOW = new Date('2026-11-11T12:00:00Z');
  const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
  const held = (over: Partial<HeldVerdict> = {}): HeldVerdict => ({
    kind: 'frontier-ticket',
    ticket: 42,
    first: hoursAgo(1),
    notified: false,
    released: false,
    reholds: 0,
    ...over,
  });
  const work = (why: string) => ({ work: true as const, why });
  const EMPTY = { work: false as const, why: 'the frontier is empty' };
  const ALL_HELD = { work: false as const, why: 'every frontier candidate is held (#7 #8)' };
  const UNREAD = { work: false as const, undetermined: true as const, why: 'the frontier could not be read' };
  const THROTTLED = {
    work: false as const,
    undetermined: true as const,
    rateLimited: true as const,
    retryAfterSeconds: 60,
    why: 'GitHub rate-limited the frontier read (GitHub asked for 60s)',
  };

  it('with no record, reports work and waits on no work, as before', () => {
    expect(holdDecision(work('frontier ticket #42 — Do it'), null, NOW, 48)).toBe('report');
    expect(holdDecision(EMPTY, null, NOW, 48)).toBe('wait');
    expect(holdDecision(UNREAD, null, NOW, 48)).toBe('wait');
  });

  it('holds on the held subject, whatever its title or trailing notes', () => {
    expect(holdDecision(work('frontier ticket #42 — Do it'), held(), NOW, 48)).toBe('hold');
    expect(
      holdDecision(work('frontier ticket #42 — Do it (open PRs unreadable; the iteration re-checks)'), held(), NOW, 48),
    ).toBe('hold');
    expect(holdDecision(work('frontier ticket #42 — A renamed title'), held(), NOW, 48)).toBe('hold');
    expect(
      holdDecision(work('spec #9 has no open children left — closing it is the task'), held({ kind: 'closable-spec', ticket: 9 }), NOW, 48),
    ).toBe('hold');
  });

  it('reports any other subject as work', () => {
    expect(holdDecision(work('frontier ticket #43 — Other'), held(), NOW, 48)).toBe('report');
    expect(holdDecision(work('spec #42 has no open children left — closing it is the task'), held(), NOW, 48)).toBe('report');
    expect(holdDecision(work('ralph PR #42 to shepherd'), held(), NOW, 48)).toBe('report');
    expect(holdDecision(work('local recovery work on ralph/42-x — inspect it before the frontier'), held(), NOW, 48)).toBe('report');
  });

  it('releases on a definite no-work verdict, and never on an undetermined one', () => {
    expect(holdDecision(EMPTY, held(), NOW, 48)).toBe('release');
    expect(holdDecision(ALL_HELD, held(), NOW, 48)).toBe('release');
    expect(holdDecision(UNREAD, held(), NOW, 48)).toBe('wait');
    expect(holdDecision(THROTTLED, held(), NOW, 48)).toBe('wait');
  });

  it('hands back once the budget is spent, and only once', () => {
    const offered = work('frontier ticket #42 — Do it');
    expect(holdDecision(offered, held({ first: hoursAgo(47) }), NOW, 48)).toBe('hold');
    expect(holdDecision(offered, held({ first: hoursAgo(48) }), NOW, 48)).toBe('budget');
    expect(holdDecision(offered, held({ first: hoursAgo(72), notified: true }), NOW, 48)).toBe('hold');
    expect(holdDecision(offered, held({ first: hoursAgo(1) }), NOW, 1)).toBe('budget');
    expect(holdDecision(offered, held({ first: hoursAgo(0.5) }), NOW, 1)).toBe('hold');
  });

  it('treats a released record as no hold: reports any work, waits on any no-work, never releases twice', () => {
    const released = held({ released: true, first: hoursAgo(72) });
    expect(holdDecision(work('frontier ticket #42 — Do it'), released, NOW, 48)).toBe('report');
    expect(holdDecision(work('frontier ticket #43 — Other'), released, NOW, 48)).toBe('report');
    expect(holdDecision(EMPTY, released, NOW, 48)).toBe('wait');
    expect(holdDecision(ALL_HELD, released, NOW, 48)).toBe('wait');
    expect(holdDecision(UNREAD, released, NOW, 48)).toBe('wait');
    expect(holdDecision(THROTTLED, released, NOW, 48)).toBe('wait');
  });

  it("follows the Idea's sequence: hold, release when #42 leaves, spawn when it comes back", async () => {
    const offered = work('frontier ticket #42 — Do it');
    const path = join(scratchDir('gate-verdict-'), 'gate-verdict.json');
    await writeHeld(path, { kind: 'frontier-ticket', ticket: 42 }, new Date(hoursAgo(72)));
    expect(holdDecision(offered, readHeld(path), NOW, 48)).toBe('budget');
    expect(holdDecision(EMPTY, readHeld(path), NOW, 48)).toBe('release');
    // The supervisor's step on that hand-back: mark the record released, keep it.
    await releaseHeld(path);
    const back = readHeld(path);
    expect(back).toMatchObject({ released: true, first: hoursAgo(72) });
    // #42's return is work to look at again, not a spent budget, even on a 72h-old clock.
    expect(holdDecision(offered, back, NOW, 48)).toBe('report');
  });

  it('builds the anchored hand-back lines ralph.sh matches', () => {
    const line = holdBudgetLine(held({ first: '2026-11-08T12:00:00.000Z' }), NOW, 7);
    expect(line).toBe(
      'frontier-gate: hold budget spent — frontier ticket #42 held since 2026-11-08T12:00:00.000Z (3d) — after poll 7',
    );
    expect(line).toMatch(/^[A-Za-z0-9_.-]+: hold budget spent/);
    expect(/after poll (\d+)/.exec(line)?.[1]).toBe('7');
    expect(holdBudgetLine(held({ kind: 'closable-spec', ticket: 9 }), NOW, 1)).toContain('closable spec #9 held since');
    expect(holdReleasedLine(EMPTY)).toBe('frontier-gate: hold released — the frontier is empty');
    expect(holdReleasedLine(EMPTY)).toMatch(/^[A-Za-z0-9_.-]+: hold released/);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [59, '59s'],
    [60, '1m'],
    [3599, '59m'],
    [3600, '1h00m'],
    [4500, '1h15m'],
  ])('%i → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

/**
 * The subprocess tests. A scratch PATH holds fakes for the only two commands
 * the gate runs; both record their argv so the read-only promise can be
 * asserted on rather than assumed.
 */
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim();
const fakeBinDir = mkdtempSync(join(tmpdir(), 'loggd-gate-fakes-'));

const writeFake = (name: string, lines: string[]): void => {
  const path = join(fakeBinDir, name);
  writeFileSync(path, ['#!/bin/sh', ...lines, ''].join('\n'));
  chmodSync(path, 0o755);
};

// Both fakes answer from the environment and append their argv to a file, so a
// test can assert on what was asked as well as on what came back. The `gh`
// fake dispatches on the label flag: the recovery probe and the census both
// speak `gh issue list`, and each test needs to answer them separately.
writeFake('bun', [
  'printf \'%s\\n\' "bun $*" >> "$FAKE_ARGV_FILE"',
  // The park sweep (#775) answers for itself, so a test can fail it alone.
  'case "$*" in *"park-probe.ts sweep"*) printf \'%s\\n\' "park-probe: swept"; exit ${FAKE_SWEEP_STATUS:-0};; esac',
  // A frontier call without `--dry-run` is the gate's claim: it answers on its own when a test supplies one.
  'case "$*" in *"frontier/next.ts"*) case "$*" in *--dry-run*) ;; *) printf \'%s\\n\' "${FAKE_CLAIM_JSON:-$FAKE_FRONTIER_JSON}"; exit ${FAKE_CLAIM_STATUS:-0};; esac;; esac',
  'printf \'%s\\n\' "$FAKE_FRONTIER_JSON"',
  'exit ${FAKE_FRONTIER_STATUS:-0}',
]);
writeFake('gh', [
  'printf \'%s\\n\' "gh $*" >> "$FAKE_ARGV_FILE"',
  'case "$*" in',
  '  *"pr list --state merged"*) printf \'%s\\n\' "${FAKE_MERGED_PR_JSON:-[]}";;',
  // The claim list fails on its own when a test asks (FAKE_CLAIMS_STATUS).
  '  *--label*) printf \'%s\\n\' "${FAKE_CLAIMS_JSON:-[]}"; exit ${FAKE_CLAIMS_STATUS:-${FAKE_GH_STATUS:-0}};;',
  // The census, answered on its own when a test supplies it (#810).
  '  *"issue list"*"--json number,body,labels,assignees"*) printf \'%s\\n\' "${FAKE_ISSUES_JSON:-$FAKE_PR_JSON}";;',
  '  *) printf \'%s\\n\' "$FAKE_PR_JSON";;',
  'esac',
  'exit ${FAKE_GH_STATUS:-0}',
]);
// The plan is read out of origin/main (as the iteration reads it), so the git
// fake answers that one shape; refusing by default sends the gate to its
// working-tree fallback, which is what the pre-change tests were written
// against.
writeFake('git', [
  'printf \'%s\\n\' "git $*" >> "$FAKE_ARGV_FILE"',
  'if [ "$1 $2" = "status --porcelain" ]; then printf \'%s\\n\' "${FAKE_LOCAL_STATUS:-}"; exit 0; fi',
  'if [ "$1 $2" = "branch --show-current" ]; then printf \'%s\\n\' "${FAKE_LOCAL_BRANCH:-}"; exit 0; fi',
  'if [ "$1 $2" = "rev-list --count" ]; then printf \'%s\\n\' "${FAKE_LOCAL_AHEAD:-0}"; exit 0; fi',
  'if [ "$1 $2" = "show origin/main:.ralph/plan.md" ]; then',
  '  [ -n "${FAKE_ORIGIN_PLAN:-}" ] || exit 1',
  '  printf \'%s\\n\' "$FAKE_ORIGIN_PLAN"',
  '  exit 0',
  'fi',
  'exit ${FAKE_GIT_STATUS:-0}',
]);

afterAll(() => rmSync(fakeBinDir, { recursive: true, force: true }));

interface GateRun {
  status: number;
  stdout: string;
  argv: string[];
}

// The gate runs against a PROJECT, whose committed `.ralph/plan.md` carries the
// fences. Loggd's (mirrored in `fixtures/loggd`) keeps the parent closure
// exceptions this suite's census cases depend on.
const PROJECT = join(REPO_ROOT, 'fixtures', 'loggd');

const gateEnv = (over: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  RALPH_PROJECT: PROJECT,
  PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
  FAKE_FRONTIER_JSON: JSON.stringify(pick()),
  FAKE_PR_JSON: '[]',
  ...over,
});

const runGate = (args: string[], over: Record<string, string> = {}): GateRun => {
  const argvFile = join(fakeBinDir, `argv-${Math.random().toString(36).slice(2)}`);
  writeFileSync(argvFile, '');
  const result = spawnSync(REAL_BUN, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: gateEnv({ FAKE_ARGV_FILE: argvFile, ...over }),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    argv: readFileSync(argvFile, 'utf8').split('\n').filter(Boolean),
  };
};

describe('the gate as a process', () => {
  it('--once exits 0 and names the ticket when the frontier has one', () => {
    const run = runGate(['--once'], {
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 601, title: 'Do the thing' })),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('work available');
    expect(run.stdout).toContain('#601');
  });

  it('--once exits 1 on an empty frontier, so a caller can branch on it', () => {
    const run = runGate(['--once']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('nothing to do');
  });

  it('asks the frontier read-only, and asks GitHub for nothing but lists', () => {
    // The whole no-write guarantee, asserted at the seam where it lives.
    const run = runGate(['--once']);

    const frontier = run.argv.filter((line) => line.startsWith('bun '));
    expect(frontier).toHaveLength(1);
    // Read against loggd's real `.ralph/plan.md`, so the exclusions are whatever it
    // currently fences rather than a copy of the list that would drift from it.
    //
    // Keep this assertion about the SHAPE of the command, never about which
    // numbers it carries. Loggd's scope detector's `ralph/*.md` rule
    // (`scripts/affected-scopes.mjs`) answers "no scopes" for a `plan.md` edit
    // on the verified claim that nothing pins the contents of the loop's prose.
    // Pinning a literal exclusion list here would make that claim false and this
    // suite unrunnable on the commit that broke it — the fences are prose a
    // human maintains, and `parsePlanFences` is pinned against its own fixture
    // above, which is where a change to the parsing belongs.
    // The harness's own launcher, by absolute path — never the project's
    // `bun run next`, which a project need not have.
    expect(frontier[0]).toMatch(
      /^bun \/\S+\/frontier\/next\.ts --take-one --dry-run( --exclude \d+)*$/,
    );

    expect(run.argv.filter((line) => line.startsWith('gh '))).toEqual([
      'gh pr list --state open --limit 100 --json number,isDraft,body,labels,headRefName',
      'gh issue list --state open --limit 500 --label ralph-wip --json number',
      'gh issue list --state open --limit 500 --json number,body,labels,assignees',
    ]);
    expect(run.argv.join('\n')).not.toMatch(/issue edit|--add-label|pr merge|pr create/);
  });

  it("probes the role's bucket for a role loop, and leaves a coder's probe byte-identical", () => {
    // `frontier/next.ts` materialises its payload from the harness's
    // `origin/main`, so a flag sent before that payload knows it would fail every
    // coder's probe. Only a non-coder role asks for one.
    // A scratch roster rather than a committed fixture: `fixtures/loggd` is a
    // mirror of loggd's real config, so a role loop cannot be added there.
    const ROLES_PROJECT = scratchProject('gate-roles', [
      'codo',
      { name: 'tria', role: 'triager' },
    ]);
    const frontierOf = (run: GateRun): string[] =>
      run.argv.filter((line) => line.includes('frontier/next.ts'));

    const coder = runGate(['--once'], { RALPH_PROJECT: ROLES_PROJECT, RALPH_LOOP_NAME: 'codo' });
    expect(frontierOf(coder)[0]).toMatch(
      /^bun \/\S+\/frontier\/next\.ts --take-one --dry-run( --exclude \d+)*$/,
    );
    expect(frontierOf(coder)[0]).not.toContain('--role');

    const triager = runGate(['--once'], { RALPH_PROJECT: ROLES_PROJECT, RALPH_LOOP_NAME: 'tria' });
    expect(frontierOf(triager)[0]).toMatch(
      /^bun \/\S+\/frontier\/next\.ts --take-one --dry-run( --exclude \d+)* --role triager$/,
    );
    // Still read-only, whoever asked: the probe writes nothing either way.
    expect(triager.argv.join('\n')).not.toMatch(/issue edit|--add-label|pr merge|pr create/);
    // And the claim probe is the loop's own label, so a triager's claim fences
    // coders off the issue exactly as a coder's fences the triager.
    expect(triager.argv).toContain('gh issue list --state open --limit 500 --label tria-wip --json number');
  });

  it("measures the checkout against the PROJECT's base branch, not origin/main", () => {
    // `role_invariant` measures "detached at the base" against the project's
    // own base branch. A gate that measured it against `origin/main` on a
    // project whose base is something else would call the same checkout stray
    // while the invariant called it clean — the two disagreeing forever is a
    // `BLOCKED_STREAK_LIMIT` halt. Resolved through `planLocation`, so the
    // committed config answers it when no supervisor exported anything, which
    // is how the README documents running this gate by hand.
    const TRUNK = scratchProject('gate-base-ref');
    writeFileSync(
      join(TRUNK, '.ralph', 'config.json'),
      readFileSync(join(TRUNK, '.ralph', 'config.json'), 'utf8').replace('"baseBranch":"main"', '"baseBranch":"trunk"'),
    );
    const run = runGate(['--once'], { RALPH_PROJECT: TRUNK, RALPH_BASE_BRANCH: '' });
    expect(run.argv).toContain('git rev-list --count origin/trunk..HEAD');
    expect(run.argv.join('\n')).not.toContain('origin/main..HEAD');

    // And the supervisor's export still wins, since it is the live path.
    const exported = runGate(['--once'], { RALPH_PROJECT: TRUNK, RALPH_BASE_BRANCH: 'release' });
    expect(exported.argv).toContain('git rev-list --count origin/release..HEAD');
  });

  it('asks nothing about pull requests for a role that opens none, and still answers', () => {
    // A triager writes labels and comments through the apply tool and opens no
    // pull request, so a `gh pr list` on every poll spends an API read to learn
    // that a thing which cannot exist does not.
    const ROLES_PROJECT = scratchProject('gate-no-shepherd', ['codo', { name: 'tria', role: 'triager' }]);
    const triager = runGate(['--once'], {
      RALPH_PROJECT: ROLES_PROJECT,
      RALPH_LOOP_NAME: 'tria',
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 146, title: 'Staff the tree' })),
      // Stamped for `tria` and wide open: if the probe ran at all, this would
      // be found and reported as a PR to shepherd.
      FAKE_PR_JSON: JSON.stringify([{ number: 42, isDraft: false, body: '🤖 Tria loop — run `x` · iteration session `y`' }]),
    });
    expect(triager.argv.filter((line) => line.startsWith('gh pr list'))).toEqual([]);
    expect(triager.status).toBe(0);
    expect(triager.stdout).toContain('#146');
    expect(triager.stdout).not.toContain('to shepherd');

    // And the coder's probe is untouched — it asks first, as it always has.
    const coder = runGate(['--once'], { RALPH_PROJECT: ROLES_PROJECT, RALPH_LOOP_NAME: 'codo' });
    expect(coder.argv.filter((line) => line.startsWith('gh pr list --state open'))).toHaveLength(1);
  });

  it('never reads an unasked pull-request probe as an unreadable one', () => {
    // `prs: null` means "ran and could not be parsed", which vetoes nothing but
    // rides along as a caveat and, with nothing else found, waits undetermined.
    // For a role that was never asked, both would be lies — and the wait would
    // be a gate that can never spawn.
    const asked = decide({ prs: null, pick: pick({ ticket: 601, title: 'Do the thing' }) }, 'ralph', 'coder');
    expect(asked.why).toContain('open PRs unreadable');

    const unasked = decide({ prs: null, pick: pick({ ticket: 601, title: 'Do the thing' }) }, 'ralph', 'triager');
    expect(unasked.work).toBe(true);
    expect(unasked.why).not.toContain('open PRs');

    // The coder's undetermined verdicts must not regress: an unreadable probe
    // is still the decision when nothing definite was found.
    const coderWaits = decide({ prs: null, pick: pick(), claims: [], localRecovery: CLEAN }, 'ralph', 'coder');
    expect(coderWaits).toMatchObject({ work: false, undetermined: true });
    // Where the triager, asked nothing, gets a definite empty frontier.
    const triagerStops = decide({ prs: null, pick: pick(), claims: [], localRecovery: CLEAN }, 'ralph', 'triager');
    expect(triagerStops).toMatchObject({ work: false });
    // Definite, not a wait. `undetermined` is not even a key on the verdict
    // that means "asked and answered", so its absence is the assertion.
    expect('undetermined' in triagerStops).toBe(false);
  });

  it("reads a read-only role's dirty worktree as its own violation, not as work to do", () => {
    // The same reading means opposite things per role. For a coder, uncommitted
    // work is the one thing the frontier cannot express. For a triager it is a
    // bug report: its prompt never edits a file, so an iteration woken for one
    // reads the worktree, finds nothing it may do, and comes back blocked —
    // and a gate insisting on work the iteration keeps not finding is
    // `BLOCKED_STREAK_LIMIT`. `ralph.sh`'s `role_invariant` is what repairs it.
    const localRecovery = { branch: 'tria/146-triage', ahead: 1, dirty: true };
    const coder = decide({ prs: [], claims: [], localRecovery, pick: pick() }, 'ralph', 'coder');
    expect(coder.work).toBe(true);
    expect(coder.why).toContain('local recovery work');

    const triager = decide({ prs: null, claims: [], localRecovery, pick: pick() }, 'ralph', 'triager');
    expect(triager.work).toBe(false);
    // Named rather than hidden: the one thing it must not do is vanish.
    expect(triager.why).toContain('the worktree dirty');
    expect(triager.why).toContain('whenever an iteration next runs');

    // It rides on a work verdict too, so the violation is not lost the moment
    // the frontier has something to offer.
    const withWork = decide(
      { prs: null, claims: [], localRecovery, pick: pick({ ticket: 12, title: 'Staff it' }) },
      'ralph',
      'triager',
    );
    expect(withWork.work).toBe(true);
    expect(withWork.why).toContain('#12');
    expect(withWork.why).toContain('the worktree dirty');
  });

  it('carries a violation on the verdicts that repeat forever, not just the tidy ones', () => {
    // The undetermined waits are precisely the answers a gate gives for hours,
    // so losing the note there would lose it in the only state where it piles
    // up. The claim-resume verdict returns before the frontier is asked at all.
    const localRecovery = { branch: null, ahead: 0, dirty: true };
    const of = (probes: Parameters<typeof decide>[0]): string =>
      decide({ ...probes, localRecovery }, 'ralph', 'triager').why;

    expect(of({ prs: null, pick: null, claims: [{ number: 9 }] })).toContain('the worktree dirty');
    expect(of({ prs: null, pick: null, claims: [] })).toContain('the worktree dirty');
    expect(of({ prs: null, pick: null, claims: null })).toContain('the worktree dirty');
    expect(
      of({ prs: null, pick: null, claims: [], frontierRateLimit: { retryAfterSeconds: 42 } }),
    ).toContain('the worktree dirty');
    expect(of({ prs: null, pick: pick(), claims: null })).toContain('the worktree dirty');
    // And it promises only what the supervisor can keep: the repair happens at
    // the end of an iteration, and with an empty bucket none may run for hours.
    expect(of({ prs: null, pick: pick(), claims: [] })).toContain('whenever an iteration next runs');
  });

  it("wakes a triager for its own unfinished claim, and for nothing when its bucket is empty", () => {
    // AC 4: a crash mid-apply keeps the claim, and the own-claim probe is what
    // spawns the iteration that reruns the same plan — the op log and the
    // markers skip whatever already landed.
    const resumes = decide({ prs: null, pick: pick(), claims: [{ number: 146 }] }, 'ralph', 'triager');
    expect(resumes.work).toBe(true);
    expect(resumes.why).toContain('#146');

    // AC 3: run the triager twice with no issue changes between the runs and
    // the second makes zero writes — because there is no second iteration at
    // all. An empty triage bucket with nothing held is a definite answer.
    const idle = decide({ prs: null, pick: pick(), claims: [], localRecovery: CLEAN }, 'ralph', 'triager');
    expect(idle.work).toBe(false);
    expect(idle.why).toBe('the frontier is empty');
  });

  it("fences a triager off the plan's closure parents, and leaves them a coder's task", () => {
    // Closing a drained spec is §1's maintenance job, reached only when the
    // coder's frontier is empty. Triaging that same spec — staffing its tree,
    // or taking it into intake for want of a state label — would put a claim on
    // the issue the plan says is somebody else's closure task, and hide it from
    // the coder that would have closed it.
    const ROLES_PROJECT = scratchProject('gate-closure', ['codo', { name: 'tria', role: 'triager' }]);
    const plan = [
      '# Ralph plan',
      '',
      '## Out of scope — never pick',
      '',
      '- #999 fenced on main.',
      '',
      '## Parent closure exceptions',
      '',
      '- #500 close it when its children are done.',
      '',
    ].join('\n');
    const frontierOf = (run: GateRun): string =>
      run.argv.filter((line) => line.includes('frontier/next.ts'))[0]!;

    const triager = frontierOf(
      runGate(['--once'], { RALPH_PROJECT: ROLES_PROJECT, RALPH_LOOP_NAME: 'tria', FAKE_ORIGIN_PLAN: plan }),
    );
    expect(triager).toContain('--exclude 999');
    expect(triager).toContain('--exclude 500');

    const coder = frontierOf(
      runGate(['--once'], { RALPH_PROJECT: ROLES_PROJECT, RALPH_LOOP_NAME: 'codo', FAKE_ORIGIN_PLAN: plan }),
    );
    expect(coder).toContain('--exclude 999');
    expect(coder).not.toContain('--exclude 500');
  });

  it("reports no closure work when the only closable parent carries another loop's -wip (#810)", () => {
    const ROLES_PROJECT = scratchProject('gate-closure-held', ['codo', 'rafa']);
    const plan = ['# Ralph plan', '', '## Parent closure exceptions', '', '- #500 close it when done.', ''].join('\n');
    const issue = (labels: string[]): string =>
      JSON.stringify([{ number: 500, body: '# spec', labels: labels.map((name) => ({ name })), assignees: [] }]);

    const held = runGate(['--once'], {
      RALPH_PROJECT: ROLES_PROJECT,
      RALPH_LOOP_NAME: 'codo',
      FAKE_ORIGIN_PLAN: plan,
      FAKE_ISSUES_JSON: issue(['rafa-wip']),
    });
    expect(held.argv).toContain('gh issue list --state open --limit 500 --json number,body,labels,assignees');
    expect(held.status).toBe(1);
    expect(held.stdout).not.toContain('spec #');

    // The same parent unheld is the census's work, so the case above is the label.
    const free = runGate(['--once'], {
      RALPH_PROJECT: ROLES_PROJECT,
      RALPH_LOOP_NAME: 'codo',
      FAKE_ORIGIN_PLAN: plan,
      FAKE_ISSUES_JSON: issue([]),
    });
    expect(free.status).toBe(0);
    expect(free.stdout).toContain('spec #500');

    // Also out of scope: the frontier's `--exclude` would refuse it, so the gate does too.
    const fenced = runGate(['--once'], {
      RALPH_PROJECT: ROLES_PROJECT,
      RALPH_LOOP_NAME: 'codo',
      FAKE_ORIGIN_PLAN: ['# Ralph plan', '', '## Out of scope', '', '- #500 held.', '', plan.replace('# Ralph plan\n\n', '')].join('\n'),
      FAKE_ISSUES_JSON: issue([]),
    });
    expect(fenced.status).toBe(1);
    expect(fenced.stdout).not.toContain('spec #');
  });

  it('names the closure parent when the frontier probe hands one out (#810)', () => {
    const run = runGate(['--once'], {
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 50, title: 'Spec', closure: true })),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('spec #50 has no open children left');
  });

  it('only pays for the maintenance census when the frontier came back empty', () => {
    const run = runGate(['--once'], {
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 601, title: 'Do the thing' })),
    });
    // The census is the label-less issue list; the recovery probe also speaks
    // `gh issue list`, so match its shape and not the verb alone.
    expect(
      run.argv.some((line) => line.startsWith('gh issue list --state open --limit 500 --json')),
    ).toBe(false);
  });

  it('skips the census when the frontier is held, not empty', () => {
    const run = runGate(['--once'], {
      FAKE_FRONTIER_JSON: JSON.stringify(
        pick({ obstructed: [{ number: 12, reason: 'ralph-wip' }] }),
      ),
    });
    expect(run.status).toBe(1);
    expect(
      run.argv.some((line) => line.startsWith('gh issue list --state open --limit 500 --json')),
    ).toBe(false);
  });

  it('reports a throttled frontier as rate-limited, not unreadable and not empty', () => {
    const run = runGate(['--once'], {
      FAKE_FRONTIER_JSON: JSON.stringify({
        ...pick(),
        error: 'GitHub rate limit (secondary) — retry later',
        rateLimited: true,
        retryAfterSeconds: 60,
      }),
      FAKE_FRONTIER_STATUS: '75',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('GitHub rate-limited the frontier read');
    expect(run.stdout).not.toContain('could not be read');
    expect(run.stdout).not.toContain('the frontier is empty');
    // Nothing to ask the census about: the frontier said nothing about the backlog.
    expect(run.argv.some((line) => line.startsWith('gh issue list --state open --limit 500 --json'))).toBe(false);
  });

  it('waits, naming why, when a Linear project has no tracker credential on this host', () => {
    // #334: nothing in the loop can connect the tracker, so the gate must not
    // send an iteration to fail at it, and must not read GitHub issues the
    // project does not use. It says why and waits for the operator.
    const project = scratchDir('gate-linear-');
    cpSync(join(PROJECT, '.ralph'), join(project, '.ralph'), { recursive: true });
    const configPath = join(project, '.ralph', 'config.json');
    // `sentinel` goes with the non-coder loops: loggd rosters senti and carries
    // the block since loggd#2909, and a block with no sentinel rostered is refused.
    const { ciDoctor, prMedic, sentinel, loops, ...rest } = JSON.parse(readFileSync(configPath, 'utf8'));
    void ciDoctor;
    void prMedic;
    void sentinel;
    writeFileSync(
      configPath,
      JSON.stringify({
        ...rest,
        loops: (loops as unknown[]).filter((loop) => typeof loop === 'string'),
        tracker: { kind: 'linear', team: 'AND', workspace: 'acme' },
      }),
    );
    const run = runGate(['--once'], { RALPH_PROJECT: project, RALPH_LOOP_NAME: 'ralph', XDG_CONFIG_HOME: scratchDir('gate-noconfig-') });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain("the project's tracker is not connected");
    expect(run.stdout).not.toContain('the frontier is empty');
    expect(run.argv.filter((line) => line.startsWith('gh issue'))).toEqual([]);
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('reports an unreadable census as undetermined, not as an empty frontier', () => {
    // Both fakes share FAKE_GH_STATUS, so the pull request list fails too and
    // the run would stop there. Let it succeed and fail only the census by
    // giving `gh` output that parses as a PR list but not as a census.
    const run = runGate(['--once'], { FAKE_PR_JSON: 'not json at all' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('the open-issue census could not be read');
    expect(run.stdout).not.toContain('the frontier is empty');
  });

  it('never calls the frontier at all when a pull request is waiting to be shepherded', () => {
    // Cheap probe first: an idle loop asks this question on every poll, and
    // the frontier costs dozens of API calls to the shepherd probe's one.
    const run = runGate(['--once'], {
      FAKE_PR_JSON: JSON.stringify([{ number: 9, isDraft: false, body: STAMPED }]),
    });
    expect(run.status).toBe(0);
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('continues to the frontier when only the other loop has a pull request', () => {
    const run = runGate(['--once'], {
      RALPH_LOOP_NAME: 'ralph',
      FAKE_PR_JSON: JSON.stringify([{ number: 9, isDraft: false, body: STAMPED_RAFA }]),
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 656, title: 'Import IMDb' })),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('#656');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(true);
  });

  it('short-circuits on the calling loop\'s own pull request', () => {
    const run = runGate(['--once'], {
      RALPH_LOOP_NAME: 'rafa',
      FAKE_PR_JSON: JSON.stringify([{ number: 9, isDraft: false, body: STAMPED_RAFA }]),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('#9');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('--once reports this loop\'s resumable claim as work and never reaches the frontier', () => {
    const run = runGate(['--once'], { FAKE_CLAIMS_JSON: '[{"number":628}]' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('#628');
    expect(run.stdout).toContain('unfinished claim');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('--once passes over a claim whose pull request another loop adopted (#424)', () => {
    const run = runGate(['--once'], {
      FAKE_CLAIMS_JSON: '[{"number":628}]',
      FAKE_PR_JSON: JSON.stringify([
        { number: 70, isDraft: false, body: STAMPED, headRefName: 'ralph/628-x', labels: [{ name: 'medi-wip' }] },
      ]),
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 656, title: 'Import IMDb' })),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('#656');
    expect(run.stdout).not.toContain('unfinished claim');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(true);
  });

  it('--once reports dirty same-worktree recovery even without a surviving claim', () => {
    const run = runGate(['--once'], { FAKE_LOCAL_STATUS: ' M src/recovery.ts' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('local recovery work');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('--once asks git for tracked changes only, so a stray untracked file is not recovery work', () => {
    // The probe's question, not the fake's answer, is the regression: an
    // untracked path is work no iteration can finish, so a gate that counts it
    // disagrees with every iteration forever and stops the supervisor.
    const run = runGate(['--once'], {});
    expect(run.argv).toContain('git status --porcelain --untracked-files=no');
  });

  it('--once reaches the frontier from a clean squash-merged loop branch', () => {
    const run = runGate(['--once'], {
      RALPH_LOOP_NAME: 'rafa',
      FAKE_LOCAL_BRANCH: 'rafa/658-background-import',
      FAKE_LOCAL_AHEAD: '2',
      FAKE_MERGED_PR_JSON: '[{"number":701,"labels":[{"name":"rafa-done"}]}]',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('the frontier is empty');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(true);
    expect(run.argv).toContain(
      'gh pr list --state merged --head rafa/658-background-import --limit 1 --json number,labels',
    );
  });

  it('--once recovers squash-merged work whose post-merge cleanup was interrupted', () => {
    const run = runGate(['--once'], {
      RALPH_LOOP_NAME: 'rafa',
      FAKE_LOCAL_BRANCH: 'rafa/658-background-import',
      FAKE_LOCAL_AHEAD: '2',
      FAKE_MERGED_PR_JSON: '[{"number":701,"labels":[]}]',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('local recovery work');
    expect(run.argv.some((line) => line.startsWith('bun '))).toBe(false);
  });

  it('asks for the claim by the calling loop\'s label, not the other loop\'s', () => {
    // The other loop's `-wip` is live work an iteration must not take.
    const run = runGate(['--once'], { RALPH_LOOP_NAME: 'rafa' });
    expect(run.argv.filter((line) => line.startsWith('gh '))[1]).toContain('--label rafa-wip');
  });

  it('reads the exclusion fences from origin/main, not the working tree', () => {
    // The freshness guard deliberately lets a mid-ticket worktree run old, so
    // the working-tree plan can lag main; the iteration reads main (§0), and
    // the gate has to predict that iteration. A fence only main knows about
    // must therefore reach the frontier call — and with the default (empty)
    // frontier answer, fencing the last ticket turns into "nothing to do"
    // rather than a spawn the iteration would have refused.
    const run = runGate(['--once'], {
      FAKE_ORIGIN_PLAN: [
        '# Ralph plan',
        '',
        '## Out of scope — never pick',
        '',
        '- #999 fenced on main.',
        '',
      ].join('\n'),
    });
    const frontier = run.argv.find((line) => line.startsWith('bun '));
    expect(frontier).toContain('--exclude 999');
  });

  it('rejects a bad poll interval instead of polling in a tight loop', () => {
    const run = runGate(['soon']);
    expect(run.status).toBe(2);
  });

  it('stops when the supervisor pid is gone, with its own parent still alive', () => {
    // The point of the whole change, and only provable through a process: the
    // gate's parent here is the live test runner, so a check on `process.ppid`
    // would never fire and this would poll out the full hour. Asking the pid in
    // `RALPH_SUPERVISOR_PID` — already exited — it stops in the first slice.
    const dead = spawnSync('true');
    expect(dead.status).toBe(0);
    const argvFile = join(fakeBinDir, 'argv-supervisor-gone');
    writeFileSync(argvFile, '');
    const run = spawnSync(REAL_BUN, [GATE, '3600'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: gateEnv({
        FAKE_ARGV_FILE: argvFile,
        RALPH_SUPERVISOR_PID: String(dead.pid),
        RALPH_CONTROL_POLL_SECONDS: '1',
      }),
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`supervisor ${dead.pid} is gone — stopping.`);
  });

  it('waits and reports instead of exiting when there is nothing to do', async () => {
    const argvFile = join(fakeBinDir, 'argv-wait');
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, '1'], {
      cwd: REPO_ROOT,
      env: gateEnv({ FAKE_ARGV_FILE: argvFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    child.stdout.setEncoding('utf8');
    const sawTwoPolls = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        lines.push(...chunk.split('\n').filter(Boolean));
        if (lines.filter((l) => l.includes('waiting')).length >= 2) resolve();
      });
    });

    try {
      await sawTwoPolls;
    } finally {
      child.kill('SIGKILL');
    }

    // Still alive after the first empty answer, and saying so each time.
    expect(lines[0]).toContain('the frontier is empty');
    expect(lines[0]).toContain('poll 1');
    expect(lines[1]).toContain('poll 2');
  });

  // The blocking gate, run until it has reported two polls, then killed.
  const twoPolls = async (
    over: Record<string, string>,
    args: string[] = ['1'],
  ): Promise<{ lines: string[]; argv: string[] }> => {
    const argvFile = join(fakeBinDir, `argv-sweep-${Math.random().toString(36).slice(2)}`);
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, ...args], {
      cwd: REPO_ROOT,
      env: gateEnv({ FAKE_ARGV_FILE: argvFile, RALPH_PARK_SWEEP_IN_GATE: '', ...over }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    child.stdout.setEncoding('utf8');
    const sawTwoPolls = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        lines.push(...chunk.split('\n').filter(Boolean));
        if (lines.filter((l) => l.includes('waiting')).length >= 2) resolve();
      });
      // Exiting early is a failure, not a hang: resolve and let the assertions say so.
      child.on('close', () => resolve());
    });
    try {
      await sawTwoPolls;
    } finally {
      child.kill('SIGKILL');
    }
    return { lines, argv: readFileSync(argvFile, 'utf8').split('\n').filter(Boolean) };
  };
  const bunCalls = (argv: string[]): string[] =>
    argv.filter((line) => line.startsWith('bun ')).map((line) => (line.includes('park-probe.ts sweep') ? 'sweep' : 'probe'));

  it('runs the park sweep before every poll when the supervisor asks for it (#775)', async () => {
    const run = await twoPolls({ RALPH_PARK_SWEEP_IN_GATE: '1' });
    // A sweep, then the probe it is for — on every poll, not just the first.
    expect(bunCalls(run.argv).slice(0, 4)).toEqual(['sweep', 'probe', 'sweep', 'probe']);
    expect(run.argv.find((line) => line.includes('park-probe.ts'))).toMatch(/^bun \/\S+\/park-probe\.ts sweep$/);
    // Its output reaches the gate's, ahead of the poll it ran before.
    expect(run.lines[0]).toBe('park-probe: swept');
    expect(run.lines[1]).toContain('poll 1');
  });

  it('spawns no sweep without RALPH_PARK_SWEEP_IN_GATE (#775)', async () => {
    const run = await twoPolls({});
    expect(bunCalls(run.argv)).not.toContain('sweep');
    expect(run.lines[0]).toContain('poll 1');
  });

  it('keeps polling when the park sweep fails (#775)', async () => {
    const run = await twoPolls({ RALPH_PARK_SWEEP_IN_GATE: '1', FAKE_SWEEP_STATUS: '7' });
    expect(run.lines).toContain('frontier-gate: park sweep exited with status 7; polling anyway.');
    expect(run.lines.filter((l) => l.includes('waiting'))).toHaveLength(2);
    expect(bunCalls(run.argv).filter((call) => call === 'probe').length).toBeGreaterThanOrEqual(2);
  });

  it('--claim keeps waiting when the claim race is lost, and never reports work', async () => {
    const run = await twoPolls(
      {
        FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 601, title: 'Do the thing' })),
        FAKE_CLAIM_JSON: JSON.stringify(
          pick({ ticket: null, claimed: false, obstructed: [{ number: 601, reason: 'labeled rafa-wip' }] }),
        ),
      },
      ['1', '--claim'],
    );
    expect(run.lines.join('\n')).not.toContain('work available');
    const waits = run.lines.filter((l) => l.includes('waiting'));
    expect(waits).toHaveLength(2);
    expect(waits[0]).toContain('claim race lost for #601');
    expect(waits[0]).toContain('poll 1');
    // A claim attempt on every poll that would have reported work.
    expect(run.argv.filter((l) => l.includes('frontier/next.ts') && !l.includes('--dry-run')).length).toBeGreaterThanOrEqual(2);
  });

  it('exits as soon as a poll finds work, without waiting out the interval', async () => {
    // The gate must not sleep through work that appeared while it was idle;
    // with a 3600s interval, finishing at all proves it re-checked and left.
    const argvFile = join(fakeBinDir, 'argv-appears');
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, '3600'], {
      cwd: REPO_ROOT,
      env: gateEnv({
        FAKE_ARGV_FILE: argvFile,
        FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 42, title: 'appeared' })),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const status = await new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
    });

    expect(status).toBe(0);
    expect(stdout).toContain('work available');
    expect(stdout).toContain('#42');
  });
});

describe('the gate as a process, claiming for the supervisor (--claim)', () => {
  const OFFERS_601 = JSON.stringify(pick({ ticket: 601, title: 'Do the thing' }));
  const frontierCalls = (run: GateRun): string[] => run.argv.filter((line) => line.includes('frontier/next.ts'));
  const claimCalls = (run: GateRun): string[] => frontierCalls(run).filter((line) => !line.includes('--dry-run'));
  const excludesOf = (line: string): string[] => line.match(/--exclude \d+/g) ?? [];

  it('a hand-run --once claims nothing, even with a ticket on the frontier', () => {
    const run = runGate(['--once'], { FAKE_FRONTIER_JSON: OFFERS_601 });
    expect(run.status).toBe(0);
    expect(frontierCalls(run)).toHaveLength(1);
    expect(claimCalls(run)).toEqual([]);
    expect(run.stdout).not.toContain('claim held by this loop');
  });

  it('claims the ticket with the same fences as the dry run, then reports it held', () => {
    const run = runGate(['--once', '--claim'], {
      FAKE_FRONTIER_JSON: OFFERS_601,
      FAKE_CLAIM_JSON: JSON.stringify(pick({ ticket: 601, title: 'Do the thing', claimed: true })),
    });
    expect(run.status).toBe(0);
    const [dry, claim] = frontierCalls(run);
    expect(frontierCalls(run)).toHaveLength(2);
    expect(dry).toMatch(/^bun \/\S+\/frontier\/next\.ts --take-one --dry-run( --exclude \d+)*$/);
    expect(claim).toMatch(/^bun \/\S+\/frontier\/next\.ts --take-one( --exclude \d+)*$/);
    expect(excludesOf(claim!)).toEqual(excludesOf(dry!));
    expect(run.stdout).toMatch(/work available — frontier ticket #601/);
    expect(run.stdout).toContain('claim held by this loop');
  });

  it('names the ticket it actually claimed, not the one it lost on the way', () => {
    const run = runGate(['--once', '--claim'], {
      FAKE_FRONTIER_JSON: OFFERS_601,
      FAKE_CLAIM_JSON: JSON.stringify(
        pick({ ticket: 602, title: 'The next one', claimed: true, obstructed: [{ number: 601, reason: 'labeled rafa-wip' }] }),
      ),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/work available — frontier ticket #602 — The next one — claim held by this loop/);
  });

  const LOST = JSON.stringify(pick({ ticket: null, claimed: false, obstructed: [{ number: 601, reason: 'labeled rafa-wip' }] }));

  it('--once --claim exits 1 when the claim race is lost', () => {
    const run = runGate(['--once', '--claim'], { FAKE_FRONTIER_JSON: OFFERS_601, FAKE_CLAIM_JSON: LOST });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('work available');
    expect(run.stdout).toContain('claim race lost for #601');
    expect(run.stdout).toContain('every frontier candidate is held (#601)');
  });

  it('--once --claim waits on an unreadable claim run instead of reporting work', () => {
    const run = runGate(['--once', '--claim'], {
      FAKE_FRONTIER_JSON: OFFERS_601,
      FAKE_CLAIM_JSON: 'not json',
      FAKE_CLAIM_STATUS: '1',
    });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('work available');
    expect(run.stdout).toContain('the frontier could not be read');
  });

  it('leaves a triager byte-identical: dry run with its role, no claim', () => {
    const ROLES_PROJECT = scratchProject('gate-claim-roles', ['codo', { name: 'tria', role: 'triager' }]);
    const run = runGate(['--once', '--claim'], {
      RALPH_PROJECT: ROLES_PROJECT,
      RALPH_LOOP_NAME: 'tria',
      FAKE_FRONTIER_JSON: OFFERS_601,
      FAKE_CLAIM_JSON: JSON.stringify(pick({ ticket: 601, title: 'Do the thing', claimed: true })),
    });
    expect(frontierCalls(run)).toHaveLength(1);
    expect(frontierCalls(run)[0]).toMatch(/^bun \/\S+\/frontier\/next\.ts --take-one --dry-run( --exclude \d+)* --role triager$/);
    expect(claimCalls(run)).toEqual([]);
  });

  it('leaves the claim to the session when the pull request list is unreadable', () => {
    const run = runGate(['--once', '--claim'], { FAKE_FRONTIER_JSON: OFFERS_601, FAKE_PR_JSON: 'not json at all' });
    expect(run.status).toBe(0);
    expect(claimCalls(run)).toEqual([]);
    expect(run.stdout).toContain('(open PRs unreadable; the iteration re-checks)');
  });

  it("leaves the claim to the session when this loop's claim list is unreadable", () => {
    const run = runGate(['--once', '--claim'], { FAKE_FRONTIER_JSON: OFFERS_601, FAKE_CLAIMS_STATUS: '1' });
    expect(run.argv.some((line) => line.includes('--label ralph-wip'))).toBe(true);
    expect(run.status).toBe(0);
    expect(claimCalls(run)).toEqual([]);
    expect(run.stdout).toMatch(/work available — frontier ticket #601/);
  });

  it("resumes its own gate claim whose session never started, claiming nothing more (#5)", () => {
    // The gate claimed #601 and the supervisor died before the model session
    // began: #601 still carries this loop's `-wip`. The next gate must hand
    // #601 back as the resumable claim, never claim #602 on top of it.
    const run = runGate(['--once', '--claim'], {
      FAKE_CLAIMS_JSON: '[{"number":601}]',
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 602, title: 'The next one' })),
      FAKE_CLAIM_JSON: JSON.stringify(pick({ ticket: 602, title: 'The next one', claimed: true })),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("issue #601 carries this loop's unfinished claim");
    expect(frontierCalls(run)).toEqual([]);
  });

  it('never claims a closure pick', () => {
    const run = runGate(['--once', '--claim'], {
      FAKE_FRONTIER_JSON: JSON.stringify(pick({ ticket: 50, title: 'Spec', closure: true })),
    });
    expect(run.status).toBe(0);
    expect(claimCalls(run)).toEqual([]);
  });
});

describe('the gate as a process, holding on a refuted verdict (#771)', () => {
  // The record lives in a scratch file named by RALPH_GATE_VERDICT_STORE, never this checkout's `.ralph/`.
  const record = (over: Partial<HeldVerdict> = {}): string => {
    const path = join(scratchDir('gate-verdict-'), 'gate-verdict.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1, kind: 'frontier-ticket', ticket: 42, first: new Date().toISOString(), notified: false, released: false, reholds: 0, ...over,
      }),
    );
    return path;
  };
  const OFFERS_42 = JSON.stringify(pick({ ticket: 42, title: 'Still offered' }));

  it('never claims a held subject under --claim', async () => {
    const argvFile = join(fakeBinDir, `argv-hold-claim-${Math.random().toString(36).slice(2)}`);
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, '1', '--claim'], {
      cwd: REPO_ROOT,
      env: gateEnv({
        FAKE_ARGV_FILE: argvFile,
        FAKE_FRONTIER_JSON: OFFERS_42,
        FAKE_CLAIM_JSON: JSON.stringify(pick({ ticket: 42, title: 'Still offered', claimed: true })),
        RALPH_GATE_VERDICT_STORE: record(),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    child.stdout.setEncoding('utf8');
    const sawTwoPolls = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        lines.push(...chunk.split('\n').filter(Boolean));
        if (lines.filter((l) => l.includes('waiting')).length >= 2) resolve();
      });
      child.on('close', () => resolve());
    });
    try {
      await sawTwoPolls;
    } finally {
      child.kill('SIGKILL');
    }
    expect(lines.join('\n')).not.toContain('work available');
    expect(lines.filter((l) => l.includes('holding on an unchanged verdict'))).toHaveLength(2);
    const argv = readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    expect(argv.filter((l) => l.includes('frontier/next.ts') && !l.includes('--dry-run'))).toEqual([]);
  });

  it('holds instead of reporting the same ticket as work', async () => {
    const argvFile = join(fakeBinDir, 'argv-hold');
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, '1'], {
      cwd: REPO_ROOT,
      env: gateEnv({ FAKE_ARGV_FILE: argvFile, FAKE_FRONTIER_JSON: OFFERS_42, RALPH_GATE_VERDICT_STORE: record() }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    child.stdout.setEncoding('utf8');
    const sawTwoPolls = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        lines.push(...chunk.split('\n').filter(Boolean));
        if (lines.filter((l) => l.includes('waiting')).length >= 2) resolve();
      });
      // Exiting early is a failure, not a hang: resolve and let the assertions say so.
      child.on('close', () => resolve());
    });

    try {
      await sawTwoPolls;
    } finally {
      child.kill('SIGKILL');
    }

    expect(lines.join('\n')).not.toContain('work available');
    expect(lines[0]).toContain('holding on an unchanged verdict (frontier ticket #42');
    expect(lines[0]).toContain('poll 1');
    expect(lines[1]).toContain('holding on an unchanged verdict');
    expect(lines[1]).toContain('poll 2');
  });

  it('keeps holding past the budget once the operator was notified', async () => {
    const argvFile = join(fakeBinDir, 'argv-hold-notified');
    writeFileSync(argvFile, '');
    const child = spawn(REAL_BUN, [GATE, '1'], {
      cwd: REPO_ROOT,
      env: gateEnv({
        FAKE_ARGV_FILE: argvFile,
        FAKE_FRONTIER_JSON: OFFERS_42,
        RALPH_GATE_VERDICT_STORE: record({ first: new Date(Date.now() - 72 * 3_600_000).toISOString(), notified: true }),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    child.stdout.setEncoding('utf8');
    const sawTwoPolls = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        lines.push(...chunk.split('\n').filter(Boolean));
        if (lines.filter((l) => l.includes('waiting')).length >= 2) resolve();
      });
      // Exiting early is a failure, not a hang: resolve and let the assertions say so.
      child.on('close', () => resolve());
    });

    try {
      await sawTwoPolls;
    } finally {
      child.kill('SIGKILL');
    }

    const out = lines.join('\n');
    expect(out).not.toContain('work available');
    expect(out).not.toContain('hold budget spent');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toContain('holding on an unchanged verdict (frontier ticket #42');
  });

  it('hands back once the hold budget is spent', () => {
    const run = runGate(['1'], {
      FAKE_FRONTIER_JSON: OFFERS_42,
      RALPH_GATE_VERDICT_STORE: record({ first: new Date(Date.now() - 72 * 3_600_000).toISOString() }),
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^frontier-gate: hold budget spent — frontier ticket #42 held since .* — after poll 1$/m);
    expect(run.stdout).not.toContain('work available');
  });

  it('releases the hold when the frontier is definitely empty', () => {
    const run = runGate(['1'], { RALPH_GATE_VERDICT_STORE: record() });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^frontier-gate: hold released — the frontier is empty/m);
  });

  it('leaves --once unchanged: the held ticket is still reported as work', () => {
    const run = runGate(['--once'], { FAKE_FRONTIER_JSON: OFFERS_42, RALPH_GATE_VERDICT_STORE: record() });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('work available');
    expect(run.stdout).toContain('#42');
  });
});
