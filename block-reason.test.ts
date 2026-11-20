/**
 * What `block-reason.ts` promises the dashboard: a stuck ticket waiting only
 * on a person to apply a migration reads apart from one stuck for any other
 * reason. The fixtures are the comments loggd #1219 (migration) and #1109
 * (red CI) actually carry, trimmed of their token footers.
 */
import { describe, expect, it } from 'vitest';

import {
  UNKNOWN_BLOCK,
  blockReasonOf,
  journalBlockKind,
  latestBlockReason,
  rescuableBlock,
} from './block-reason';

const FOOTER = '<details><summary>token usage — step 6</summary>\n\n| scope |\n</details>';

const claim = { body: `rafa loop starting on this. Branch: rafa/1219-streaming-region.\n\n${FOOTER}`, createdAt: '2026-09-23T10:00:00Z' };
const prOpened = { body: `### PR #1242 opened for #1219\n\nhttps://github.com/felipearos/loggd/pull/1242\n\n${FOOTER}`, createdAt: '2026-09-23T10:10:00Z' };
const hardRail = {
  body:
    '**needs-migration** — draft PR #1242 carries the finished code for this ticket. It is waiting on a database migration that a person has to apply.\n\n' +
    '**What the database needs, and why.** A member\'s Streaming Region…\n\n```sql\nALTER TABLE "user" ADD COLUMN "streaming_region" text;\n```\n\n' +
    'Apply `drizzle/0062_streaming_region.sql`, then mark PR #1242 ready.',
  createdAt: '2026-09-23T10:20:00Z',
};
const mirror1219 = {
  body: `### Ticket #1219 blocked\n\nneeds-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql (additive column) before merging\n\n${FOOTER}`,
  createdAt: '2026-09-23T10:21:00Z',
};
const mirror1109 = {
  body: `### Ticket #1109 blocked\n\nPR #1276: Buildkite job red twice (#2001, #2005), same ~2.5min exit 1; TS7 typecheck/full lint unrun locally (host busy). Needs the job log.\n\n${FOOTER}`,
  createdAt: '2026-09-23T12:00:00Z',
};
const blocked1109 = {
  body: `Blocked: PR #1276 had two red Buildkite runs (#2001 and #2005) that I couldn't reproduce locally. Details on the PR: https://github.com/felipearos/loggd/pull/1276. The PR is now a draft.\n\n${FOOTER}`,
  createdAt: '2026-09-23T12:01:00Z',
};

describe('blockReasonOf', () => {
  it('reads the ticket-blocked mirror of a migration block, with its PR and file', () => {
    expect(blockReasonOf(mirror1219)).toEqual({
      kind: 'migration',
      reason: 'needs-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql (additive column) before merging',
      pr: 1242,
      migration: 'drizzle/0062_streaming_region.sql',
      at: '2026-09-23T10:21:00Z',
    });
  });

  it('reads the HARD RAIL comment itself, bold lead and all, and finds the file past the first paragraph', () => {
    expect(blockReasonOf(hardRail)).toMatchObject({ kind: 'migration', pr: 1242, migration: 'drizzle/0062_streaming_region.sql' });
  });

  it('reads a mirror whose reason is anything else as another reason', () => {
    expect(blockReasonOf(mirror1109)).toMatchObject({ kind: 'other', pr: 1276, migration: null });
  });

  it('reads a comment that leads with "Blocked:" as another reason', () => {
    expect(blockReasonOf(blocked1109)).toMatchObject({ kind: 'other', pr: 1276 });
  });

  it('does not take a migration file from the body of a non-migration block', () => {
    const body = 'Blocked: CI red on PR #9.\n\nUnrelated: drizzle/0001_init.sql looked fine.';
    expect(blockReasonOf({ body })).toMatchObject({ kind: 'other', migration: null, at: null });
  });

  it('ignores comments that are not block records', () => {
    expect(blockReasonOf(claim)).toBeNull();
    expect(blockReasonOf(prOpened)).toBeNull();
    expect(blockReasonOf({ body: 'This is blocked: see above.' })).toBeNull();
    expect(blockReasonOf({ body: '' })).toBeNull();
  });

  it('cuts a very long reason to a readable line', () => {
    const reason = blockReasonOf({ body: `Blocked: ${'x'.repeat(1000)}` })!.reason!;
    expect(reason.length).toBe(300);
    expect(reason.endsWith('…')).toBe(true);
  });
});

describe('latestBlockReason', () => {
  it('classifies #1219 as migration-blocked', () => {
    expect(latestBlockReason([claim, prOpened, hardRail, mirror1219]).kind).toBe('migration');
  });

  it('classifies #1109 as blocked for another reason', () => {
    expect(latestBlockReason([mirror1109, blocked1109])).toMatchObject({ kind: 'other', at: '2026-09-23T12:01:00Z' });
  });

  it('lets the newest record win when a ticket was wedged again for another reason', () => {
    expect(latestBlockReason([hardRail, mirror1219, claim, mirror1109]).kind).toBe('other');
    expect(latestBlockReason([mirror1109, hardRail]).kind).toBe('migration');
  });

  it('says unknown, not other, when nothing on the ticket is a block record', () => {
    expect(latestBlockReason([claim, prOpened])).toEqual(UNKNOWN_BLOCK);
    expect(latestBlockReason([])).toEqual(UNKNOWN_BLOCK);
  });
});

describe('journalBlockKind', () => {
  it('reads every wording of a migration block the journal has used', () => {
    expect(journalBlockKind('blocked (needs-migration)')).toBe('migration');
    expect(journalBlockKind('blocked on a migration — code complete')).toBe('migration');
    expect(journalBlockKind('blocked (migration hard rail)')).toBe('migration');
  });

  it('reads any other block as another reason, and a non-block as none', () => {
    expect(journalBlockKind('blocked (CI unreadable)')).toBe('other');
    expect(journalBlockKind('blocked')).toBe('other');
    expect(journalBlockKind('merged')).toBeNull();
    expect(journalBlockKind('all blocked')).toBeNull();
  });
});

/**
 * The `ci-flake` kind (felipearos/ralph#155 AC 4). The dashboard shows a flake
 * block as the ci-doctor's rather than as human triage, so the distinction has
 * to be on the record itself and not only in a predicate a caller remembers to
 * ask.
 */
describe('the ci-flake kind', () => {
  const reasonOf = (body: string) => blockReasonOf({ body, createdAt: '2026-09-29T12:00:00Z' })!;

  it('reads the block shape prompt.md §5.4 mandates for a flake as ci-flake', () => {
    expect(reasonOf('blocked: PR #1710 red on a flaky test (src/queue/retry.test.ts), not the diff')).toEqual({
      kind: 'ci-flake',
      reason: 'blocked: PR #1710 red on a flaky test (src/queue/retry.test.ts), not the diff',
      pr: 1710,
      migration: null,
      at: '2026-09-29T12:00:00Z',
    });
  });

  it('leaves the ordinary unreproducible red as another reason — that one is the triager\'s', () => {
    expect(reasonOf('blocked: PR #1276 red twice in CI; not reproducible locally').kind).toBe('other');
  });

  it('never reads a migration as a flake, however flaky the rest of the record says the suite was', () => {
    const migration = reasonOf(
      'needs-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql before merging\n\n' +
        'The suite was also flaky on this branch, unrelatedly.',
    );
    expect(migration.kind).toBe('migration');
  });

  it('still reads a non-record as no record at all', () => {
    expect(blockReasonOf({ body: 'This is blocked: see above, the test is flaky.' })).toBeNull();
    expect(blockReasonOf({ body: '' })).toBeNull();
  });
});

describe('the flake vocabulary', () => {
  // Read every fixture through blockReasonOf rather than hand-writing a
  // BlockReason, so the test fails if the two ever disagree about a line.
  const reasonOf = (body: string) => blockReasonOf({ body, createdAt: '2026-09-29T12:00:00Z' })!;

  it('reads a lightly reworded flake too, because the vocabulary is the signal', () => {
    // The narrower `blocked: PR #\d+ red on a flaky test` form felipearos/ralph#155
    // proposes would drop both of these, which is why the kind keys on the stem.
    expect(reasonOf('blocked: PR #1814 red on a flake in src/a.test.ts').kind).toBe('ci-flake');
    expect(reasonOf('### Ticket #1814 blocked\n\nblocked: the build is red on a known flaky spec').kind).toBe('ci-flake');
  });

  it('reads a bolded lead, since plain() strips the emphasis before the lead is tested', () => {
    expect(reasonOf('**blocked:** PR #1814 red on a flaky test (src/a.test.ts)').kind).toBe('ci-flake');
  });

  it('reads the flake off the FIRST LINE only — one named further down is an aside', () => {
    const aside = reasonOf('blocked: PR #1276 red twice in CI; not reproducible locally\n\nThe suite is also flaky.');
    expect(aside.kind).toBe('other');
  });
});

/**
 * The one gate the triager's rescue bucket and its `unblock` op both ask. They
 * render different refusals from it, so it is tested here rather than only
 * through them: a wrong answer means the bucket offers a ticket the op refuses,
 * and an iteration is claimed, planned and thrown away.
 */
describe('rescuableBlock', () => {
  const reasonOf = (body: string) => blockReasonOf({ body, createdAt: '2026-09-29T12:00:00Z' })!;

  it('says yes to an ordinary recorded reason — the only kind a re-spec reaches', () => {
    expect(rescuableBlock(reasonOf('blocked: PR #1276 red twice in CI; not reproducible locally'))).toBe(true);
    expect(rescuableBlock(reasonOf('blocked: the acceptance criteria contradict each other'))).toBe(true);
  });

  it('says no to a migration, which waits on a person with database access', () => {
    expect(rescuableBlock(reasonOf('needs-migration: apply drizzle/0062_x.sql before merging'))).toBe(false);
  });

  it("says no to a flake, which is the ci-doctor's", () => {
    expect(rescuableBlock(reasonOf('blocked: PR #1814 red on a flaky test (src/a.test.ts), not the diff'))).toBe(false);
  });

  it('says no when nothing says what the coder gave up on', () => {
    // Not the same as "ordinary": guessing ordinary is the one guess that acts.
    expect(rescuableBlock(UNKNOWN_BLOCK)).toBe(false);
    expect(rescuableBlock(latestBlockReason([]))).toBe(false);
  });

  it('is exactly the ordinary kind, so the bucket and the op cannot disagree', () => {
    for (const body of [
      'blocked: PR #1276 red twice in CI; not reproducible locally',
      'needs-migration: apply drizzle/0062_x.sql before merging',
      'blocked: PR #1814 red on a flaky test (src/a.test.ts), not the diff',
    ]) {
      const reason = reasonOf(body);
      expect(rescuableBlock(reason)).toBe(reason.kind === 'other');
    }
  });
});
