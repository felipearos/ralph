/**
 * What `triage-marker.ts` promises the frontier: an issue the triager has
 * already decided about stays out of its intake, and comes back the moment the
 * request changes or somebody answers it.
 *
 * The rejection cases matter more than the happy path. A marker read as
 * "partially valid" would make the frontier skip a ticket nobody triaged, and
 * the only symptom would be a ticket that silently never gets offered.
 */
import { describe, expect, it } from 'vitest';

import { stuckLabelFor } from './frontier/next-tasks';
import {
  BLOCKED_SUFFIX,
  MAX_UNBLOCKS,
  UNBLOCK_MARKER_OP,
  blockedLoopOf,
  firstLine,
  formatTriageMarker,
  hasCurrentTriage,
  latestTriageMarker,
  leadsWithUnblock,
  rescueBar,
  triageBodyHash,
  triageGaveUp,
  triageMarkerOf,
  triageMarkersWithOp,
  unblockLead,
  type IssueComment,
  type TriageOutcome,
} from './triage-marker';

const BODY = '## What to build\n\nA thing.\n';
const hash = triageBodyHash(BODY);

const marked = (
  attempt: number,
  outcome: TriageOutcome,
  body = hash,
  createdAt?: string,
): IssueComment => ({
  body: `Triaged: routed to the api loop.\n\n${formatTriageMarker({ attempt, outcome, body })}`,
  ...(createdAt === undefined ? {} : { createdAt }),
});

const plain = (body = 'Any thoughts?'): IssueComment => ({ body });

describe('triageBodyHash', () => {
  it('is stable, and short enough to read in a comment', () => {
    expect(triageBodyHash(BODY)).toBe(triageBodyHash(BODY));
    expect(triageBodyHash(BODY)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('ignores the CRLF and trailing whitespace GitHub editors introduce', () => {
    expect(triageBodyHash('a\r\nb  \n')).toBe(triageBodyHash('a\nb\n'));
  });

  it('changes when the request changes', () => {
    expect(triageBodyHash(BODY)).not.toBe(triageBodyHash(`${BODY}\nAnd another thing.\n`));
  });
});

describe('triageMarkerOf', () => {
  it('round-trips what formatTriageMarker writes', () => {
    expect(triageMarkerOf(marked(1, 'routed'))).toEqual({
      attempt: 1,
      outcome: 'routed',
      body: hash,
      op: null,
      at: null,
    });
  });

  it.each(['propose', 'to-person'] as const)('round-trips the keyed intake outcome %s', (outcome) => {
    expect(triageMarkerOf(marked(1, outcome))).toEqual({
      attempt: 1,
      outcome,
      body: hash,
      op: null,
      at: null,
    });
  });

  it("carries the comment's timestamp when the read supplied one", () => {
    expect(triageMarkerOf(marked(1, 'split', hash, '2026-09-30T09:00:00Z'))?.at).toBe(
      '2026-09-30T09:00:00Z',
    );
  });

  it('is null for a comment with no marker', () => {
    expect(triageMarkerOf(plain())).toBeNull();
  });

  it.each([
    ['an unknown outcome', `<!-- ralph:triage attempt=1 outcome=pondered body=${hash} -->`],
    ['a missing key', `<!-- ralph:triage attempt=1 body=${hash} -->`],
    ['attempt zero', `<!-- ralph:triage attempt=0 outcome=routed body=${hash} -->`],
    ['a fractional attempt', `<!-- ralph:triage attempt=1.5 outcome=routed body=${hash} -->`],
    ['a non-numeric attempt', `<!-- ralph:triage attempt=one outcome=routed body=${hash} -->`],
    ['a short hash', '<!-- ralph:triage attempt=1 outcome=routed body=3f2a -->'],
    ['a non-hex hash', '<!-- ralph:triage attempt=1 outcome=routed body=zzzzzzzzzzzz -->'],
    ['a valueless field', `<!-- ralph:triage attempt outcome=routed body=${hash} -->`],
  ])('is null for %s rather than a partial marker', (_name, body) => {
    expect(triageMarkerOf({ body })).toBeNull();
  });

  it('takes the last marker in a comment, which is the newest decision', () => {
    const body = [
      formatTriageMarker({ attempt: 1, outcome: 'info', body: hash }),
      formatTriageMarker({ attempt: 2, outcome: 'routed', body: hash }),
    ].join('\n\n');
    expect(triageMarkerOf({ body })?.attempt).toBe(2);
  });
});

describe('latestTriageMarker', () => {
  it('is the newest marker, comments oldest first', () => {
    expect(latestTriageMarker([marked(1, 'info'), plain(), marked(2, 'routed')])?.attempt).toBe(2);
  });

  it('is null when nothing is marked', () => {
    expect(latestTriageMarker([plain(), plain('still nothing')])).toBeNull();
  });
});

describe('hasCurrentTriage', () => {
  it('is true when the newest comment marks this exact body', () => {
    expect(hasCurrentTriage(BODY, [plain(), marked(1, 'routed')])).toBe(true);
  });

  it('is false when the body was edited after the decision', () => {
    expect(hasCurrentTriage(`${BODY}\nNow with mobile too.\n`, [marked(1, 'routed')])).toBe(false);
  });

  it('is false when somebody answered after the marker', () => {
    expect(hasCurrentTriage(BODY, [marked(1, 'info'), plain('here is the answer')])).toBe(false);
  });

  it('is true for the newest of several markers', () => {
    expect(hasCurrentTriage(BODY, [marked(1, 'info'), plain(), marked(2, 'routed')])).toBe(true);
  });

  it('is false when the issue has never been triaged', () => {
    expect(hasCurrentTriage(BODY, [plain()])).toBe(false);
    expect(hasCurrentTriage(BODY, [])).toBe(false);
  });
});

describe('triageGaveUp', () => {
  it('is true only once the second attempt has given up', () => {
    expect(triageGaveUp([marked(2, 'gave-up')])).toBe(true);
    expect(triageGaveUp([marked(1, 'gave-up')])).toBe(false);
  });

  it('is false when the latest marker is any other outcome', () => {
    expect(triageGaveUp([marked(2, 'gave-up'), marked(3, 'routed')])).toBe(false);
  });

  it('is false with no markers at all', () => {
    expect(triageGaveUp([plain()])).toBe(false);
  });
});

describe("formatTriageMarker with apply details", () => {
  it("carries the loop, unit, op and labels as extra fields the reader ignores", () => {
    const text = formatTriageMarker(
      { attempt: 2, outcome: "split", body: triageBodyHash("a body") },
      { loop: "tessa", unit: 142, op: "release-2", labels: ["spec", "needs-info"] },
    );
    expect(text).toContain("loop=tessa");
    expect(text).toContain("unit=142");
    expect(text).toContain("op=release-2");
    expect(text).toContain("labels=spec,needs-info");
    // The whole point of extending the format rather than inventing one: the
    // module that decides whether an issue is still untriaged must read it.
    expect(triageMarkerOf({ body: text })).toMatchObject({ attempt: 2, outcome: "split" });
    expect(hasCurrentTriage("a body", [{ body: text }])).toBe(true);
  });

  it("stays readable when a label carries spaces, which real repositories have", () => {
    const text = formatTriageMarker(
      { attempt: 1, outcome: "info", body: triageBodyHash("a body") },
      { loop: "tessa", unit: 142, op: "release-1", labels: ["good first issue", "help wanted"] },
    );
    expect(text).toContain("labels=good%20first%20issue,help%20wanted");
    // Unencoded, `parseFields` would split "good first issue" into tokens with
    // no `=` and reject the whole marker, hiding the decision from the frontier.
    expect(triageMarkerOf({ body: text })).not.toBeNull();
    expect(hasCurrentTriage("a body", [{ body: text }])).toBe(true);
  });
});

describe('the op a marker names', () => {
  const withOp = (op: string, createdAt?: string, attempt = 1): IssueComment => ({
    body: `Did a thing.\n\n${formatTriageMarker({ attempt, outcome: 'specced', body: hash }, {
      loop: 'tessa',
      unit: 150,
      op,
      labels: ['ready-for-agent'],
    })}`,
    ...(createdAt === undefined ? {} : { createdAt }),
  });

  it('round-trips an op through the percent-encoding', () => {
    expect(triageMarkerOf(withOp(UNBLOCK_MARKER_OP))?.op).toBe('unblock');
    expect(triageMarkerOf(withOp('release-2'))?.op).toBe('release-2');
    expect(triageMarkerOf(withOp('a b=c>d'))?.op).toBe('a b=c>d');
  });

  it('reads a marker with no apply details as naming no op', () => {
    expect(triageMarkerOf(marked(1, 'routed'))?.op).toBeNull();
  });

  it('still reads the decision when the op will not decode', () => {
    const marker = triageMarkerOf({ body: `<!-- ralph:triage attempt=1 outcome=routed body=${hash} op=%ZZ -->` });
    expect(marker).toMatchObject({ attempt: 1, outcome: 'routed', op: null });
  });
});

describe('triageMarkersWithOp', () => {
  const unblocked = (createdAt: string, attempt: number): IssueComment => ({
    body: `unblocked: rescue count for rafa reset\n\n${formatTriageMarker(
      { attempt, outcome: 'specced', body: hash },
      { loop: 'tessa', unit: 150, op: UNBLOCK_MARKER_OP, labels: [] },
    )}`,
    createdAt,
  });

  it('returns every matching marker oldest first, with its timestamp', () => {
    const found = triageMarkersWithOp(
      [unblocked('2026-08-01T00:00:00Z', 1), marked(1, 'routed'), unblocked('2026-09-01T00:00:00Z', 2)],
      UNBLOCK_MARKER_OP,
    );
    expect(found.map((marker) => marker.at)).toEqual(['2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z']);
    expect(found.map((marker) => marker.attempt)).toEqual([1, 2]);
  });

  it('is empty when no comment names that op', () => {
    expect(triageMarkersWithOp([marked(1, 'routed'), plain()], UNBLOCK_MARKER_OP)).toEqual([]);
    expect(triageMarkersWithOp([], UNBLOCK_MARKER_OP)).toEqual([]);
  });

  it('does not mistake a release marker for an unblock', () => {
    expect(triageMarkersWithOp([{ body: `x\n\n${formatTriageMarker({ attempt: 1, outcome: 'routed', body: hash }, { loop: 'tessa', unit: 1, op: 'release-1', labels: [] })}` }], UNBLOCK_MARKER_OP)).toEqual([]);
  });
});

/**
 * The gate `frontier/next-tasks.ts`'s rescue bucket and `triage/validate.ts`'s
 * `unblock` op both hang off, tested here rather than only through them: the
 * two callers render different messages from the same five answers, and a
 * wrong answer means the bucket offers a ticket the op refuses.
 */
describe('rescueBar', () => {
  const NOW = new Date('2026-06-01T00:00:00Z');
  const mark = (createdAt: string | null, attempt = 1): IssueComment => ({
    body: `${unblockLead('rafa')}\n\n${formatTriageMarker(
      { attempt, outcome: 'specced', body: hash },
      { loop: 'tessa', unit: 12, op: UNBLOCK_MARKER_OP, labels: ['rafa-blocked'] },
    )}`,
    ...(createdAt === null ? {} : { createdAt }),
  });
  const bar = (comments: IssueComment[], days = 7) => rescueBar(comments, { now: NOW, days });

  it('bars nothing when the ticket has never been rescued', () => {
    expect(bar([])).toBeNull();
    expect(bar([plain(), marked(1, 'routed')])).toBeNull();
  });

  it('bars a rescue inside the window, and stops once it is outside', () => {
    expect(bar([mark('2026-05-28T00:00:00Z')])).toMatchObject({ reason: 'recent', count: 1 });
    expect(bar([mark('2026-04-01T00:00:00Z')])).toBeNull();
    // The boundary: exactly `days` old is outside, which is the direction that
    // lets a ticket come back rather than one that strands it.
    expect(bar([mark('2026-05-25T00:00:00Z')])).toBeNull();
    expect(bar([mark('2026-05-25T00:00:01Z')])).toMatchObject({ reason: 'recent' });
  });

  it('honours the window it is given rather than a fixed one', () => {
    expect(bar([mark('2026-04-01T00:00:00Z')], 90)).toMatchObject({ reason: 'recent' });
  });

  it('caps the ticket once it has been rescued MAX_UNBLOCKS times, however old', () => {
    const ancient = [mark('2024-01-01T00:00:00Z', 1), mark('2024-02-01T00:00:00Z', 2)];
    expect(ancient).toHaveLength(MAX_UNBLOCKS);
    // Far outside any window, so it is the CAP answering and not the clock.
    expect(bar(ancient, 1)).toMatchObject({ reason: 'capped', count: MAX_UNBLOCKS });
    // And the cap outranks the window when both would fire.
    expect(bar([mark('2026-05-28T00:00:00Z', 1), mark('2026-05-29T00:00:00Z', 2)])).toMatchObject({
      reason: 'capped',
    });
  });

  it('bars an undated marker rather than assuming it is old', () => {
    expect(bar([mark(null)])).toMatchObject({ reason: 'undated', count: 1 });
  });

  it('bars a marker whose date will not parse', () => {
    expect(bar([mark('the other day')])).toMatchObject({ reason: 'unparseable', count: 1 });
  });

  it('always carries the marker it is barring on, capped included', () => {
    // `capped` is the reason that used to answer `marker: null`, which is why
    // the field is non-nullable now.
    const cases = [
      [mark('2026-05-28T00:00:00Z')],
      [mark(null)],
      [mark('nonsense')],
      [mark('2024-01-01T00:00:00Z', 1), mark('2024-02-01T00:00:00Z', 2)],
    ];
    for (const comments of cases) expect(bar(comments)?.marker).toBeDefined();
    expect(bar([mark('2026-05-28T00:00:00Z')])?.marker.at).toBe('2026-05-28T00:00:00Z');
    expect(bar(cases[3]!)?.marker.at).toBe('2024-02-01T00:00:00Z');
  });

  it('counts only unblock markers, not a release or a plain decision', () => {
    const release: IssueComment = {
      body: `Triaged.\n\n${formatTriageMarker({ attempt: 1, outcome: 'routed', body: hash }, {
        loop: 'tessa',
        unit: 12,
        op: 'release-1',
        labels: [],
      })}`,
      createdAt: '2026-05-30T00:00:00Z',
    };
    expect(bar([marked(1, 'routed'), release, mark('2026-04-01T00:00:00Z')])).toBeNull();
    // Two releases are not two rescues, however recent.
    expect(bar([release, release])).toBeNull();
  });
});

describe('unblockLead and leadsWithUnblock', () => {
  it('names the loop whose count the comment resets', () => {
    expect(unblockLead('rafa')).toBe('unblocked: rescue count for rafa reset');
  });

  it('reads a lead line past any leading blank lines, and only as the FIRST line', () => {
    expect(leadsWithUnblock(`\n\n  ${unblockLead('rafa')}  \n\nwhy\n`, 'rafa')).toBe(true);
    expect(leadsWithUnblock(`Rescuing this.\n\n${unblockLead('rafa')}`, 'rafa')).toBe(false);
    expect(leadsWithUnblock(unblockLead('rafa'), 'ralph')).toBe(false);
  });
});

describe('blockedLoopOf', () => {
  it('inverts a block label, and says no to anything else', () => {
    expect(blockedLoopOf('rafa-blocked')).toBe('rafa');
    expect(blockedLoopOf('rafa-wip')).toBeNull();
    expect(blockedLoopOf('ready-for-agent')).toBeNull();
  });

  it('round-trips stuckLabelFor, which composes the same suffix in another module', () => {
    // The two halves live apart and the types do not link them, so this is the
    // only thing that says a renamed suffix breaks both or neither.
    for (const loop of ['ralph', 'rafa', 'tria']) {
      expect(blockedLoopOf(stuckLabelFor(loop))).toBe(loop);
    }
    expect(stuckLabelFor('rafa').endsWith(BLOCKED_SUFFIX)).toBe(true);
  });
});

describe('firstLine', () => {
  it('answers the empty string for a body with no line in it', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine('\n  \n')).toBe('');
  });
});
