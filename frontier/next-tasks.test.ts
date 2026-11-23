/**
 * The edge logic is where this tool can lie: a wrong parse silently invents or
 * drops a blocker, and either direction produces confident, wrong output. These
 * tests pin the parses and the readiness decisions that depend on them.
 *
 * `render` output is asserted with ANSI stripped, so the assertions read as the
 * thing a human would see.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { type BlockReason } from '../block-reason';
import { claimLease, writeLeaseStore, type LeaseStore } from '../claim-lease';
import { DEFAULT_JAV, routeByDifficulty, type JavConfig } from '../jav';
import { cleanupFixtures, scratchProject, writeProjectConfig } from '../dashboard/fixtures';

import {
  readFrontierInputs,
  buildDependents,
  claimLeaseIo,
  buildTickets,
  buildTree,
  claimObstruction,
  classify,
  currentLoop,
  findLoopNameFile,
  classifyDependencyFailure,
  issueRefsUnderHeading,
  useOwnRepository,
  useReferenceKey,
  leaseHeldReason,
  leaseIdentity,
  loopClaimObstruction,
  loopReadOnly,
  parseFlags,
  parseBodyReferences,
  parseParent,
  parseProseBlockers,
  parseStaffingGroup,
  readStaffingGroup,
  primaryBlocker,
  frontierReport,
  humanReason,
  readParks,
  readPlanHolds,
  readStuckReasons,
  render,
  reportJavLabels,
  untriagedTickets,
  renderClaims,
  renderTakeOne,
  renderTree,
  takeOne,
  takeOneCandidates,
  stuckLabelOf,
  roleUnits,
  routeBatch,
  TRIAGE_BUCKETS,
  treeOf,
  triageBuckets,
  triagerUnits,
  truncate,
  waitingOnOperator,
  wipLabelFor,
  wipLabelOf,
  unblockingPower,
  claimLockPath,
  withClaimLock,
  withoutCycles,
  type BlockerRef,
  type ClosedIssue,
  type FrontierUnit,
  type LiveIssue,
  type OpenPullRequest,
  type RawIssue,
  type TakeOneOutcome,
  type Ticket,
  type TreeGroup,
  type TreeNode,
  CommandError,
  classifyGhFailure,
  closableParent,
} from './next-tasks';
import { RateLimitedError } from './github-rate-limit';
import { createGithubTracker } from '../tracker/github';
import { decide, frontierOutcome } from '../frontier-gate';
import type { IssueComment } from '../block-reason';
import type { BranchClaim } from './branch-claims';
import { UNBLOCK_MARKER_OP, formatTriageMarker, triageBodyHash, type TriageOutcome } from '../triage-marker';
import { subprocessSuite } from '../test-timeouts';
import { park as parkIn, withStore, type ListedPark } from '../park-store';

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite('runs next-tasks.ts under bun against fixture git repos');

// The claim owner is the project's `owner` (`.ralph/config.json`), which the
// supervisor exports as RALPH_PROJECT_OWNER. The suite runs outside any project,
// so it names loggd's owner the way the supervisor would.
process.env.RALPH_PROJECT_OWNER = 'felipearosr';
// Its roster too: a scratch project naming loggd's loops is the project the
// in-process reads resolve to.
process.env.RALPH_PROJECT = scratchProject('next-tasks');

// oxlint-disable-next-line no-control-regex -- matching the ANSI escape byte is the point
const stripAnsi = (s: string): string => s.replace(/\x1b\[\d+m/g, '');

/**
 * Renders the way production does — through one shared classification — so the
 * branch under test is the branch that ships.
 */
const show = (tickets: Map<number, Ticket>, closedChildParents: number[] = []): string =>
  stripAnsi(render(tickets, classify(tickets, closedChildParents)));

/** The READY NOW block alone — later sections legitimately repeat a number. */
const readySection = (out: string): string =>
  out.split(/^(?:OCCUPIED|UNTRIAGED|SPECS|IN FLIGHT|BLOCKED|STUCK)/m)[0] ?? '';

/** A branch claim whose tip is `tipMs` (default: an hour ago). */
const branchClaim = (branch: string, tipMs = Date.now() - 3_600_000): BranchClaim => ({ branch, tipMs });

const issue = (
  number: number,
  title: string,
  body: string,
  labels: string[] = ['ready-for-agent'],
  assignees: string[] = [],
  extra: { author?: string | null; comments?: IssueComment[] } = {},
): RawIssue => ({
  number,
  title,
  body,
  labels: labels.map((name) => ({ name })),
  assignees: assignees.map((login) => ({ login })),
  // The owner by default: the triager's intake only offers the project owner's
  // own issues, so a fixture that said nothing would be silently out of scope.
  author: extra.author === undefined ? { login: 'felipearosr' } : extra.author === null ? null : { login: extra.author },
  comments: extra.comments ?? [],
});

const blockedBy = (...refs: number[]): string =>
  `## What to build\n\nStuff.\n\n## Blocked by\n\n${refs.map((r) => `- #${r}`).join('\n')}\n`;

describe('issueRefsUnderHeading', () => {
  it('reads refs from the named section only', () => {
    const body = `## Parent\n\n#100\n\n## Blocked by\n\n- #200\n- #201\n`;
    expect(issueRefsUnderHeading(body, 'Blocked by')).toEqual([200, 201]);
    expect(issueRefsUnderHeading(body, 'Parent')).toEqual([100]);
  });

  it('ignores refs mentioned outside the section', () => {
    // The failure this guards: prose elsewhere in the body inventing an edge.
    const body = `## What to build\n\nSupersedes #999 and relates to #998.\n\n## Blocked by\n\n- #200\n`;
    expect(issueRefsUnderHeading(body, 'Blocked by')).toEqual([200]);
  });

  it('stops at the next heading rather than running to the end of the body', () => {
    const body = `## Blocked by\n\n- #200\n\n## Acceptance criteria\n\n- [ ] closes #300\n`;
    expect(issueRefsUnderHeading(body, 'Blocked by')).toEqual([200]);
  });

  it('returns nothing when the section is absent or says none', () => {
    expect(
      issueRefsUnderHeading('## Blocked by\n\nNone — can start immediately.\n', 'Blocked by'),
    ).toEqual([]);
    expect(issueRefsUnderHeading('## What to build\n\nStuff.\n', 'Blocked by')).toEqual([]);
  });

  it('deduplicates repeated refs', () => {
    expect(issueRefsUnderHeading('## Blocked by\n\n- #7\n- #7\n', 'Blocked by')).toEqual([7]);
  });

  it('anchors the whole heading unless asked not to', () => {
    // Issue bodies follow a template, so an exact anchor is right for them:
    // `## Blocked by something else` must not answer to `Blocked by`.
    const body = '## Out of scope — never pick\n\n- #228, #65\n';
    expect(issueRefsUnderHeading(body, 'Out of scope')).toEqual([]);
    expect(issueRefsUnderHeading(body, 'Out of scope', { prefix: true })).toEqual([228, 65]);
  });
});

describe('cross-repository references (#22)', () => {
  // Moved tickets cite another repository's numbers; bound to ours, each one
  // would one day gate on (or count as progress from) an unrelated issue.
  const body =
    '## Parent\n\nacme/widgets-archive#165\n\n' +
    '## Blocked by\n\n- #12\n- acme/widgets#13\n- ACME/Widgets#14\n- acme/widgets-archive#171\n- example-org/other#15\n';

  const withRepository = <T>(repo: string | null, run: (errors: () => string[]) => T): T => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    useOwnRepository(repo);
    try {
      return run(() => error.mock.calls.map((call) => String(call[0])));
    } finally {
      useOwnRepository(null);
      error.mockRestore();
    }
  };

  it('keeps bare refs and the own repository, in any case, and drops another repository', () => {
    withRepository('acme/widgets', () => {
      expect(parseProseBlockers(body)).toEqual([12, 13, 14]);
      expect(parseParent(body)).toBeNull();
    });
  });

  it('says each dropped reference once on stderr', () => {
    // Refs no other test names: the once-per-process memory is module state.
    const own = '## Blocked by\n\n- example-org/once#16\n- example-org/once#16\n- acme/widgets#17\n';
    const errors = withRepository('acme/widgets', (calls) => {
      expect(parseProseBlockers(own)).toEqual([17]);
      parseProseBlockers(own);
      return calls();
    });
    expect(errors).toEqual([
      'next-tasks: ignoring example-org/once#16: it is not an issue of acme/widgets, so it is no edge here',
    ]);
  });

  it('counts a slug as before while the own repository is unknown', () => {
    withRepository(null, (calls) => {
      expect(parseProseBlockers(body)).toEqual([12, 13, 14, 171, 15]);
      expect(parseParent(body)).toBe(165);
      expect(calls()).toEqual([]);
    });
  });

  it('leaves keyed references alone', () => {
    useReferenceKey('AND');
    try {
      withRepository('acme/widgets', () => {
        expect(parseProseBlockers('## Blocked by\n\n- AND-7\n- acme/widgets#13\n')).toEqual([7]);
      });
    } finally {
      useReferenceKey(null);
    }
  });
});

describe('parseStaffingGroup', () => {
  it('reads one normalized group from its own section', () => {
    const body = `## Parent\n\n#649\n\n## Staffing group\n\naccount-onboarding\n\n## Blocked by\n\nNone.\n`;
    expect(parseStaffingGroup(body)).toBe('account-onboarding');
  });

  it('keeps legacy tickets on the parent-wide default', () => {
    expect(parseStaffingGroup('## Parent\n\n#649\n')).toBeNull();
  });

  it.each(['', 'Account onboarding', 'account_onboarding', 'one\ntwo'])(
    'refuses a malformed staffing group (%j)',
    (value) => {
      const body = `## Staffing group\n\n${value}\n\n## Blocked by\n\nNone.\n`;
      expect(() => parseStaffingGroup(body)).toThrow(/Staffing group/);
    },
  );

  // loggd#2427, 2026-10-17: the group was the last section, so an agent's
  // footer landed inside it and every frontier call for every loop threw.
  it.each([
    ['an agent footer', 'mobile-scroll-taps\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'],
    ['a separator and footer', 'mobile-scroll-taps\n\n---\nGenerated with [Claude Code](https://claude.com/claude-code)\n'],
    ['a co-author trailer', 'mobile-scroll-taps\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'],
    ['an HTML comment', 'mobile-scroll-taps\n<!-- ralph:triage attempt=1 -->\n'],
    ['blank lines around it', '\n\n  mobile-scroll-taps  \n\n\n'],
  ])('reads the group past %s', (_, value) => {
    expect(readStaffingGroup(`## Staffing group\n\n${value}`)).toEqual({ group: 'mobile-scroll-taps', problem: null });
  });

  it('reports a malformed group instead of throwing', () => {
    expect(readStaffingGroup('## Staffing group\n\nWeb UI\n')).toEqual({
      group: null,
      problem: '## Staffing group must contain one lowercase kebab-case name; got "Web UI"',
    });
  });
});

describe('a malformed ticket', () => {
  const tree = (): RawIssue[] => [
    issue(100, 'spec', '## What to build\n\nA spec.\n', ['spec']),
    issue(101, 'broken', '## Parent\n\n#100\n\n## Staffing group\n\nWeb UI\n'),
    issue(102, 'fine', '## Parent\n\n#100\n\n## Staffing group\n\napi\n'),
    issue(200, 'standalone', '## What to build\n\nIt.\n'),
  ];

  it('is held out alone: the rest of the backlog stays offerable', () => {
    const { frontier } = frontierOf(tree());
    expect(frontier.malformed.map((t) => t.number)).toEqual([101]);
    const offered = frontier.readyTasks.map((t) => t.number);
    expect(offered).not.toContain(101);
    expect(offered).toContain(200);
    // Its tree falls back to the conservative parent-wide domain, so the one
    // healthy sibling is still offered — just never alongside an unknown one.
    expect(offered).toContain(102);
    expect(takeOneCandidates(frontier).map((t) => t.number)).not.toContain(101);
  });

  it('is named in both views and in the JSON report, so someone fixes it', () => {
    const { tickets, frontier } = frontierOf(tree());
    const line = '⚠ malformed: #101 — ## Staffing group must contain one lowercase kebab-case name; got "Web UI"';
    expect(stripAnsi(render(tickets, frontier))).toContain(line);
    expect(stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])))).toContain(line);
    expect(frontierReport(tickets, frontier, []).malformed).toEqual([
      { number: 101, title: 'broken', problem: '## Staffing group must contain one lowercase kebab-case name; got "Web UI"' },
    ]);
  });
});

describe('parseParent', () => {
  it('takes the first ref only', () => {
    expect(parseParent('## Parent\n\nSpec: #542\n')).toBe(542);
  });

  it('is null when there is no parent section', () => {
    expect(parseParent('## Blocked by\n\n- #1\n')).toBeNull();
  });
});

describe('parseProseBlockers', () => {
  it('reads the Blocked by section', () => {
    expect(parseProseBlockers(blockedBy(1, 2))).toEqual([1, 2]);
  });
});

describe('classifyDependencyFailure', () => {
  // This rule decides whether a blocked ticket gets promoted into READY NOW.
  it('treats a missing dependencies endpoint as absent data', () => {
    expect(classifyDependencyFailure('gh: Not Found (HTTP 404)')).toBe('no-dependency-data');
    expect(classifyDependencyFailure('gh: Gone (HTTP 410)')).toBe('no-dependency-data');
  });

  it('treats everything else as fatal rather than "no blockers"', () => {
    expect(classifyDependencyFailure('dial tcp: lookup api.github.com')).toBe('fatal');
    expect(classifyDependencyFailure('gh: Bad credentials (HTTP 401)')).toBe('fatal');
    expect(classifyDependencyFailure('gh: rate limit exceeded (HTTP 403)')).toBe('fatal');
    expect(classifyDependencyFailure('gh: Server Error (HTTP 500)')).toBe('fatal');
  });
});

describe('classifyGhFailure', () => {
  // The exact failure of 2026-09-28, headers included as `--include` prints them.
  const message =
    'gh api repos/{owner}/{repo}/issues/1656/dependencies/blocked_by --jq [.[] | {number, state}] failed: ' +
    'gh: API rate limit exceeded for user ID 21047325. If you reach out to GitHub Support for help, ' +
    'please include the request ID C87C:278AC2 (HTTP 403)';

  it('reads the headers a failed `gh api --include` left on stdout', () => {
    const quotaLeft = new CommandError(message, 'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 4870\n\n{}');
    expect(classifyGhFailure(quotaLeft)).toEqual({ kind: 'secondary', retryAfterSeconds: null });

    const spent = new CommandError(
      message,
      'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 1060\n\n{}',
    );
    expect(classifyGhFailure(spent, 1000)).toEqual({ kind: 'quota', retryAfterSeconds: 60 });
  });

  it('falls back to the message when there are no headers, and leaves other failures alone', () => {
    expect(classifyGhFailure(new Error(message))).toEqual({ kind: 'unspecified', retryAfterSeconds: null });
    expect(classifyGhFailure(new Error('gh: Resource not accessible by integration (HTTP 403)'))).toBeNull();
  });
});

describe('buildTickets', () => {
  it('unions prose and native edges', () => {
    const raw = [issue(1, 'a', blockedBy(2)), issue(2, 'b', ''), issue(3, 'c', '')];
    const natives: BlockerRef[][] = [[{ number: 3, state: 'open' }], [], []];
    expect(buildTickets(raw, natives).get(1)!.openBlockers).toEqual([2, 3]);
  });

  it('counts a prose blocker as closed only when it is a verified closed issue', () => {
    const raw = [issue(1, 'a', blockedBy(543))];
    const tickets = buildTickets(raw, [[]], new Set([543]));
    expect(tickets.get(1)!.openBlockers).toEqual([]);
    expect(tickets.get(1)!.closedBlockers).toEqual([543]);
  });

  it('treats an unresolvable prose ref as neither gating nor progress', () => {
    // Regression: "absent from the open set" was read as closed, so a prose ref
    // to a pull request, a deleted issue, or a typo counted as a finished slice
    // and promoted a tree that never started.
    const raw = [issue(1, 'a', blockedBy(99999))];
    const ticket = buildTickets(raw, [[]], new Set()).get(1)!;
    expect(ticket.openBlockers).toEqual([]);
    expect(ticket.closedBlockers).toEqual([]);
  });

  it('records a closed NATIVE blocker as progress', () => {
    // Regression: filtering the API to open blockers made closedBlockers
    // unreachable via native edges, which silently disabled the primary
    // ordering rule once prose edges were backfilled away.
    const raw = [issue(1, 'a', '## Blocked by\n\nNone\n')];
    const natives: BlockerRef[][] = [[{ number: 543, state: 'closed' }]];
    const ticket = buildTickets(raw, natives).get(1)!;
    expect(ticket.openBlockers).toEqual([]);
    expect(ticket.closedBlockers).toEqual([543]);
  });

  it('lets a native state override a prose guess', () => {
    const raw = [issue(1, 'a', blockedBy(2))];
    const natives: BlockerRef[][] = [[{ number: 2, state: 'open' }]];
    const ticket = buildTickets(raw, natives, new Set([2])).get(1)!;
    expect(ticket.openBlockers).toEqual([2]);
    expect(ticket.closedBlockers).toEqual([]);
  });

  it('flags prose edges with no native counterpart, and only those', () => {
    const raw = [issue(1, 'a', blockedBy(2, 3)), issue(2, 'b', ''), issue(3, 'c', '')];
    const natives: BlockerRef[][] = [[{ number: 2, state: 'open' }], [], []];
    expect(buildTickets(raw, natives).get(1)!.proseOnlyBlockers).toEqual([3]);
  });

  it('does not flag a prose edge to an already-closed issue', () => {
    // Nothing to backfill: a dependency on a closed issue gates nothing.
    const raw = [issue(1, 'a', blockedBy(543))];
    expect(buildTickets(raw, [[]], new Set([543])).get(1)!.proseOnlyBlockers).toEqual([]);
  });

  it('carries the open PR that closes a ticket, and null for one no PR closes', () => {
    const raw = [issue(1, 'a', ''), issue(2, 'b', '')];
    const prs: OpenPullRequest[] = [{ number: 742, closingIssuesReferences: [{ number: 1 }] }];
    const tickets = buildTickets(raw, [[], []], new Set(), prs);
    expect(tickets.get(1)!.openPullRequest).toBe(742);
    expect(tickets.get(2)!.openPullRequest).toBeNull();
  });

  it('keeps the lowest PR number when two open PRs close one issue', () => {
    // The value must be stable across calls, not dependent on the order GitHub
    // happened to return the PRs in.
    const raw = [issue(1, 'a', '')];
    const heldBy = (order: OpenPullRequest[]): number =>
      buildTickets(raw, [[]], new Set(), order).get(1)!.openPullRequest!;
    expect(
      heldBy([
        { number: 800, closingIssuesReferences: [{ number: 1 }] },
        { number: 742, closingIssuesReferences: [{ number: 1 }] },
      ]),
    ).toBe(742);
    expect(
      heldBy([
        { number: 742, closingIssuesReferences: [{ number: 1 }] },
        { number: 800, closingIssuesReferences: [{ number: 1 }] },
      ]),
    ).toBe(742);
  });

  it('carries the live loop branch that claims a ticket, and null for one none claims', () => {
    const raw = [issue(1, 'a', ''), issue(2, 'b', '')];
    const tickets = buildTickets(raw, [[], []], new Set(), [], new Map([[1, branchClaim('rafa/1-a')]]));
    expect(tickets.get(1)!.liveBranch).toBe('rafa/1-a');
    expect(tickets.get(2)!.liveBranch).toBeNull();
    expect(buildTickets(raw, [[], []]).get(1)!.liveBranch).toBeNull();
  });

  describe('a deliberate hand-back releases the branch claim', () => {
    const tipMs = Date.parse('2026-10-22T10:00:00Z');
    const liveBranch = (labels: string[], comments: IssueComment[]): string | null =>
      buildTickets(
        [issue(1, 'a', '', labels, [], { comments })],
        [[]],
        new Set(),
        [],
        new Map([[1, branchClaim('rafa/1-a', tipMs)]]),
      ).get(1)!.liveBranch;

    it('releases it for a stuck label', () => {
      expect(liveBranch(['ready-for-agent', 'rafa-blocked'], [])).toBeNull();
    });

    it('releases it for a hand-back comment newer than the tip', () => {
      // The coder's stuck comment, a triager's decision and an operator's
      // decision each speak after the last commit.
      const after = '2026-10-22T11:00:00Z';
      expect(liveBranch(['ready-for-agent'], [{ body: 'blocked: PR #9 red twice in CI', createdAt: after }])).toBeNull();
      const marker = formatTriageMarker({ attempt: 1, outcome: 'routed', body: triageBodyHash('') });
      expect(liveBranch(['ready-for-agent'], [{ body: `unblocked\n\n${marker}`, createdAt: after }])).toBeNull();
      expect(
        liveBranch(['ready-for-agent'], [{ body: '### Operator decision\n\nTake it again.', createdAt: after }]),
      ).toBeNull();
    });

    it('keeps it for a comment newer than the tip that hands nothing back', () => {
      // A question or a bot's note is not a hand-back: releasing on it would
      // reopen the race the branch claim closes.
      expect(
        liveBranch(['ready-for-agent'], [{ body: 'Is this still on track?', createdAt: '2026-10-22T11:00:00Z' }]),
      ).toBe('rafa/1-a');
    });

    it('keeps it for a comment older than the tip', () => {
      expect(
        liveBranch(['ready-for-agent'], [{ body: 'blocked: an older attempt', createdAt: '2026-10-22T09:00:00Z' }]),
      ).toBe('rafa/1-a');
    });

    it('keeps it for comments without a readable time', () => {
      expect(
        liveBranch(['ready-for-agent'], [{ body: 'no time' }, { body: 'bad time', createdAt: 'yesterday' }]),
      ).toBe('rafa/1-a');
    });
  });
});

describe('unblockingPower', () => {
  it('counts transitively, not just direct dependents', () => {
    const dependents = new Map([
      [1, [2, 3]],
      [2, [4]],
      [4, [5]],
    ]);
    expect(unblockingPower(1, dependents)).toBe(4);
    expect(unblockingPower(2, dependents)).toBe(2);
    expect(unblockingPower(5, dependents)).toBe(0);
  });

  it('terminates on a cycle', () => {
    const dependents = new Map([
      [1, [2]],
      [2, [1]],
    ]);
    expect(unblockingPower(1, dependents)).toBe(2);
  });

  it('counts a diamond dependent once', () => {
    const dependents = new Map([
      [1, [2, 3]],
      [2, [4]],
      [3, [4]],
    ]);
    expect(unblockingPower(1, dependents)).toBe(3);
  });
});

describe('buildDependents', () => {
  it('inverts open edges only', () => {
    const raw = [issue(1, 'a', blockedBy(2, 543)), issue(2, 'b', '')];
    const dependents = buildDependents(buildTickets(raw, [[], []], new Set([543])));
    expect(dependents.get(2)).toEqual([1]);
    expect(dependents.get(543)).toBeUndefined();
  });
});

describe('render', () => {
  it('keeps a queued, unblocked epic pickable even though others name it as parent', () => {
    // Regression: filtering out anything named as a parent dropped #528 — a
    // queued, unblocked epic — from every section. Nothing may vanish.
    const raw = [
      issue(528, 'Epic', ''),
      issue(531, 'Child', `## Parent\n\n#528\n\n${blockedBy(530)}`),
      issue(530, 'Blocker', ''),
    ];
    const out = show(buildTickets(raw, [[], [], []]));
    expect(out).toContain('#528');
    expect(out).toContain('parent of 1');
  });

  it('keeps a queued spec out of READY NOW and names it as a container', () => {
    // Implementing the spec IS implementing its children, so offering both
    // stages one worker against another. The spec still has to be visible:
    // silently dropping it reads as "nobody wrote it".
    const raw = [
      issue(542, 'Spec: Poster Slot', ''),
      issue(544, 'migrate A', `## Parent\n\n#542\n`),
      issue(545, 'migrate B', `## Parent\n\n#542\n`),
    ];
    const out = show(buildTickets(raw, [[], [], []]));
    expect(out).toMatch(/READY NOW — 1 ticket, 1 independent staffing group\b/);
    // The spec may still head its group as a title; what it must not be is a
    // pickable line, in this block or in the count.
    expect(readySection(out)).toContain('Spec: Poster Slot (#542)');
    expect(readySection(out)).not.toMatch(/^\s+#542\s/m);
    expect(out).toContain('SPECS — containers, not work');
    expect(out).toContain('#542  Spec: Poster Slot — parent of 2');
  });

  it('keeps a spec a container after every child has closed', () => {
    // The silent-flip case: inferring from open children alone would make the
    // container staffable — and auto-assigned — exactly when it looks finished.
    const tickets = buildTickets([issue(542, 'Spec: Poster Slot', '')], [[]]);
    // The closed slice #544 named #542 as its parent; only that name survives.
    const out = show(tickets, [542]);
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('#542  Spec: Poster Slot — parent of 1');
  });

  it('lets a claimed spec hold its whole tree', () => {
    // Whoever took the container is implementing the children, so this is the
    // one case where every ticket in the tree really is spoken for.
    const raw = [
      issue(542, 'Spec', '', ['ready-for-agent'], ['felipearosr']),
      issue(544, 'migrate A', `## Parent\n\n#542\n`),
    ];
    const out = show(buildTickets(raw, [[], []]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('staffing group held by #542');
  });

  it('lets a claimed nested spec hold its children rather than its siblings', () => {
    const raw = [
      issue(1, 'Parent spec', ''),
      issue(2, 'Claimed nested spec', `## Parent\n\n#1\n`, ['ready-for-agent', 'rafa-wip']),
      issue(3, 'nested account work', `## Parent\n\n#2\n\n## Staffing group\n\naccount\n`),
      issue(4, 'nested import work', `## Parent\n\n#2\n\n## Staffing group\n\nimports\n`),
      issue(5, 'parent sibling work', `## Parent\n\n#1\n\n## Staffing group\n\nrelease\n`),
    ];

    const out = show(buildTickets(raw, [[], [], [], [], []]));
    expect(readySection(out)).toContain('#5');
    expect(out).toMatch(/#3 .*staffing group held by #2/);
    expect(out).toMatch(/#4 .*staffing group held by #2/);
  });

  it('treats a childless ticket labelled spec as a container too', () => {
    // A spec whose tickets are not written yet has no children to infer from.
    const raw = [issue(1, 'Spec: unwritten', '', ['ready-for-agent', 'spec'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('#1  Spec: unwritten — labeled spec');
  });

  it('keeps legacy siblings in one parent-wide staffing group', () => {
    // READY NOW has to mean "start an agent on every line": siblings under one
    // spec are unblocked, not collision-free.
    const raw = [
      issue(542, 'Spec', ''),
      issue(544, 'migrate A', `## Parent\n\n#542\n`),
      issue(545, 'migrate B', `## Parent\n\n#542\n`),
      issue(546, 'migrate C', `## Parent\n\n#542\n`),
    ];
    const out = show(buildTickets(raw, [[], [], [], []]));
    expect(out).toMatch(/READY NOW — 1 ticket, 1 independent staffing group\b/);
    expect(out).toContain('2 siblings behind this one');
    expect(out).toMatch(/#545 .*staffing group held by #544/);
    expect(out).toMatch(/#546 .*staffing group held by #544/);
  });

  it('picks the sibling that frees the most work, ties by number', () => {
    const raw = [
      issue(542, 'Spec', ''),
      issue(544, 'frees nothing', `## Parent\n\n#542\n`),
      issue(545, 'frees one', `## Parent\n\n#542\n`),
      issue(546, 'downstream', blockedBy(545)),
    ];
    const byPower = show(buildTickets(raw, [[], [], [], []]));
    expect(byPower).toMatch(/^\s+#545\s/m);
    expect(byPower).toMatch(/#544 .*staffing group held by #545/);

    // With nothing to break the tie, the authored batch order survives.
    const flat = [
      issue(542, 'Spec', ''),
      issue(545, 'b', `## Parent\n\n#542\n`),
      issue(544, 'a', `## Parent\n\n#542\n`),
    ];
    expect(show(buildTickets(flat, [[], [], []]))).toMatch(/^\s+#544\s/m);
  });

  it('does not mention siblings for a lone slice under a spec', () => {
    const raw = [issue(542, 'Spec', ''), issue(544, 'only child', `## Parent\n\n#542\n`)];
    const out = show(buildTickets(raw, [[], []]));
    expect(out).not.toContain('behind this one');
  });

  it('counts unparented tickets as separate trees', () => {
    // Two standalone tickets are independently staffable; lumping them into one
    // bucket understated parallelism, which is the number the tool exists for.
    const raw = [issue(1, 'a', ''), issue(2, 'b', '')];
    const out = show(buildTickets(raw, [[], []]));
    expect(out).toMatch(/READY NOW — 2 tickets, 2 independent staffing groups\b/);
  });

  it('sorts a tree with a closed blocker ahead of an untouched one', () => {
    const raw = [issue(100, 'fresh start', ''), issue(200, 'continues work', blockedBy(543))];
    const out = show(buildTickets(raw, [[], []], new Set([543])));
    expect(out.indexOf('#200')).toBeLessThan(out.indexOf('#100'));
  });

  it('sorts by unblocking power when neither tree is in progress', () => {
    const raw = [
      issue(100, 'frees nothing', ''),
      issue(200, 'frees two', ''),
      issue(300, 'downstream', blockedBy(200)),
      issue(400, 'further downstream', blockedBy(300)),
    ];
    const out = show(buildTickets(raw, [[], [], [], []]));
    expect(out.indexOf('#200')).toBeLessThan(out.indexOf('#100'));
    expect(out).toContain('frees 2');
  });

  it('falls back to issue number when progress and power tie', () => {
    const raw = [issue(200, 'later', ''), issue(100, 'earlier', '')];
    const out = show(buildTickets(raw, [[], []]));
    expect(out.indexOf('#100')).toBeLessThan(out.indexOf('#200'));
  });

  it('shows an in-flight ticket that has lost its queue label', () => {
    // A claim that strips ready-for-agent must not erase the ticket.
    const raw = [issue(530, 'claimed', '', ['ralph-wip'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('IN FLIGHT');
    expect(out).toContain('#530');
    expect(out).toContain('not ready-for-agent');
  });

  it('excludes an in-flight ticket from the frontier', () => {
    const raw = [issue(530, 'claimed', '', ['ready-for-agent', 'ralph-wip'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('IN FLIGHT');
  });

  it('shows a stuck ticket that appears in no other section', () => {
    const raw = [issue(600, 'wedged', '', ['ralph-blocked'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('STUCK');
    expect(out).toContain('#600');
  });

  it('keeps a stuck ticket out of READY NOW even though it stays queued', () => {
    // ralph swaps ralph-wip -> ralph-blocked and KEEPS ready-for-agent
    // (ralph/prompt.md), so the label alone would advertise it as ready.
    const raw = [issue(600, 'wedged', '', ['ready-for-agent', 'ralph-blocked'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('STUCK');
  });

  it('treats a GitHub assignee as a claim', () => {
    // ralph/prompt.md: "no assignee (an assignee means Felipe or another agent
    // claimed it)" — offering it again is how two workers land on one ticket.
    const raw = [issue(700, 'claimed by hand', '', ['ready-for-agent'], ['felipearosr'])];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('IN FLIGHT');
    expect(out).toContain('assigned to felipearosr');
  });

  it('treats an open PR as a claim: out of READY NOW, into IN FLIGHT', () => {
    // The window a loop opens by clearing its `<loop>-wip` label when it opens
    // the PR: from "PR opened" until "PR merged" the ticket carries no label
    // and no assignee, and without the PR fence it reappears under READY NOW.
    const raw = [issue(1, 'has a PR', '')];
    const prs: OpenPullRequest[] = [{ number: 742, closingIssuesReferences: [{ number: 1 }] }];
    const tickets = buildTickets(raw, [[]], new Set(), prs);
    const out = show(tickets);
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('IN FLIGHT');
    expect(out).toContain('PR #742');
  });

  it('treats a live loop branch as a claim when the -wip label is gone (#480)', () => {
    // A rate-limit restart can clear `rafa-wip` while rafa's commits sit on
    // its branch: the branch alone must keep the ticket from a second loop.
    const raw = [issue(1, 'lost its label', '', ['ready-for-agent'])];
    const tickets = buildTickets(raw, [[]], new Set(), [], new Map([[1, branchClaim('rafa/1-lost-its-label')]]));
    const frontier = classify(tickets, []);
    expect(frontier.inFlight.map((t) => t.number)).toEqual([1]);
    expect(frontier.readyTasks).toEqual([]);
    expect(frontier.claimed.has(1)).toBe(true);
    const out = show(tickets);
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('IN FLIGHT');
    expect(out).toContain('branch rafa/1-lost-its-label');
  });

  it('leaves a ticket READY NOW when its linked PR is merged or closed', () => {
    // The fence is "open PR", not "any PR": a merged PR is the finished work,
    // and a closed-unmerged PR is nobody's claim. Neither appears in the open
    // census, so neither may fence the ticket.
    const raw = [issue(1, 'PR merged', '')];
    const out = show(buildTickets(raw, [[]]));
    expect(out).toMatch(/READY NOW — 1 ticket/);
    expect(out).not.toContain('IN FLIGHT');
  });

  it('leaves a claimed but blocked ticket in BLOCKED, not IN FLIGHT', () => {
    // A claim does not close a blocking edge, and dropping it out of BLOCKED
    // would hide the middle of a chain that other tickets hang off.
    const raw = [
      issue(1, 'gate', ''),
      issue(2, 'claimed and blocked', blockedBy(1), ['ready-for-agent'], ['felipearosr']),
      issue(3, 'downstream', blockedBy(2)),
    ];
    const out = show(buildTickets(raw, [[], [], []]));
    expect(out).toMatch(/BLOCKED — 2\b/);
    expect(out).not.toContain('IN FLIGHT');
  });

  it('withholds siblings whose tree is already occupied', () => {
    // One ticket per tree is the staffing rule; a tree with a claimed ticket
    // already has its one, so its siblings are unblocked but not free to take.
    const raw = [
      issue(500, 'Epic', ''),
      issue(501, 'claimed sibling', `## Parent\n\n#500\n`, ['ready-for-agent', 'ralph-wip']),
      issue(502, 'free sibling?', `## Parent\n\n#500\n`),
      issue(600, 'unrelated', ''),
    ];
    const out = show(buildTickets(raw, [[], [], [], []]));
    expect(out).toMatch(/READY NOW — 1 ticket, 1 independent staffing group\b/);
    expect(out).toContain('OCCUPIED');
    expect(out).toContain('#502');
    expect(out).toContain('staffing group held by #501');
    expect(out).toContain('#600');
  });

  it('staffs different named groups under one spec in parallel', () => {
    const raw = [
      issue(649, 'Spec', ''),
      issue(650, 'account work', `## Parent\n\n#649\n\n## Staffing group\n\naccount-onboarding\n`),
      issue(655, 'import work', `## Parent\n\n#649\n\n## Staffing group\n\nimports\n`),
    ];

    const out = show(buildTickets(raw, [[], [], []]));
    expect(out).toMatch(/READY NOW — 2 tickets, 2 independent staffing groups\b/);
    expect(readySection(out)).toContain('#650');
    expect(readySection(out)).toContain('#655');
  });

  it('preserves staffing names when the parent title needs truncation', () => {
    const raw = [
      issue(649, 'A spec title long enough to consume the entire heading width before metadata', ''),
      issue(650, 'account work', `## Parent\n\n#649\n\n## Staffing group\n\naccount-onboarding\n`),
      issue(655, 'import work', `## Parent\n\n#649\n\n## Staffing group\n\nimports\n`),
    ];

    const ready = readySection(show(buildTickets(raw, [[], [], []])));
    expect(ready).toContain('(#649) · account-onboarding');
    expect(ready).toContain('(#649) · imports');
  });

  it('withholds only the staffing group a sibling already occupies', () => {
    const raw = [
      issue(649, 'Spec', ''),
      issue(
        655,
        'claimed import',
        `## Parent\n\n#649\n\n## Staffing group\n\nimports\n`,
        ['ready-for-agent', 'ralph-wip'],
      ),
      issue(656, 'other import', `## Parent\n\n#649\n\n## Staffing group\n\nimports\n`),
      issue(650, 'account work', `## Parent\n\n#649\n\n## Staffing group\n\naccount-onboarding\n`),
    ];

    const out = show(buildTickets(raw, [[], [], [], []]));
    expect(readySection(out)).toContain('#650');
    expect(out).toMatch(/#656 .*staffing group held by #655/);
  });

  it('keeps a partially annotated tree parent-wide until every child is grouped', () => {
    const raw = [
      issue(649, 'Spec', ''),
      issue(655, 'legacy child', `## Parent\n\n#649\n`),
      issue(650, 'named child', `## Parent\n\n#649\n\n## Staffing group\n\nimports\n`),
    ];

    const out = show(buildTickets(raw, [[], [], []]));
    expect(out).toMatch(/READY NOW — 1 ticket, 1 independent staffing group\b/);
    expect(readySection(out)).not.toContain('· imports');
    expect(out).toMatch(/#655 .*staffing group held by #650/);
  });

  it('surfaces a blocker that gates work but is not queued', () => {
    const raw = [issue(1, 'blocked', blockedBy(2)), issue(2, 'untriaged', '', [])];
    const out = show(buildTickets(raw, [[], []]));
    expect(out).toContain('#2');
    expect(out).toContain('gates work but is not ready-for-agent');
  });

  it('points at the roadmap when the frontier is empty', () => {
    const raw = [issue(1, 'blocked', blockedBy(2)), issue(2, 'blocker', '', [])];
    const out = show(buildTickets(raw, [[], []]));
    expect(out).toContain('READY NOW — nothing');
    expect(out).toContain('roadmap');
  });

  it('reports the backfill worklist, and nothing when it is empty', () => {
    const withProse = [issue(1, 'a', blockedBy(2)), issue(2, 'b', '')];
    expect(show(buildTickets(withProse, [[], []]))).toContain(
      'prose-only edges',
    );

    const withNative = buildTickets(withProse, [[{ number: 2, state: 'open' }], []]);
    expect(show(withNative)).not.toContain('prose-only edges');
  });

  it('leaves no ANSI escapes unaccounted for in the stripped output', () => {
    // Guards the helper above: a stripAnsi that misses the escape byte would
    // make every assertion in this block quietly weaker.
    const raw = [issue(1, 'a', '')];
    // oxlint-disable-next-line no-control-regex -- matching the ANSI escape byte is the point
    expect(show(buildTickets(raw, [[]]))).not.toMatch(/\x1b/);
  });
});

describe('what waits on the operator', () => {
  const owned = { held: new Set<number>(), triager: false, container: false };
  const one = (labels: string[], assignees: string[] = []): Ticket =>
    buildTickets([issue(7, 'ticket', '', labels, assignees)], [[]]).get(7)!;

  it('names each reason a person, not a loop, has to act', () => {
    expect(humanReason(one(['ready-for-human']), owned)).toBe('ready-for-human');
    expect(humanReason(one(['needs-info']), owned)).toBe('needs-info');
    expect(humanReason(one(['ready-for-agent']), { ...owned, held: new Set([7]) })).toBe('held');
    expect(humanReason(one([]), owned)).toBe('untriaged');
    expect(humanReason(one(['ready-for-agent', 'needs-triage']), owned)).toBe('untriaged');
  });

  it('leaves agent work, containers, stuck and claimed tickets alone', () => {
    expect(humanReason(one(['ready-for-agent']), owned)).toBeNull();
    expect(humanReason(one(['ready-for-human']), { ...owned, container: true })).toBeNull();
    // The stuck view already says a person is needed, and why.
    expect(humanReason(one(['ready-for-agent', 'rafa-blocked']), { ...owned, held: new Set([7]) })).toBeNull();
    expect(humanReason(one(['ready-for-human', 'ralph-wip']), owned)).toBeNull();
    expect(humanReason(one(['ready-for-human'], ['felipearosr']), owned)).toBeNull();
    const branched = buildTickets([issue(7, 'ticket', '', ['ready-for-human'])], [[]], new Set(), [], new Map([[7, branchClaim('rafa/7-x')]]));
    expect(humanReason(branched.get(7)!, owned)).toBeNull();
  });

  it('leaves an untriaged ticket to the triager when one runs', () => {
    expect(humanReason(one([]), { ...owned, triager: true })).toBeNull();
  });

  it('marks the tree and the report alike, never a spec', () => {
    const raw = [
      issue(165, 'Spec: remote dashboard', '', ['spec']),
      issue(166, 'Store schema', '## Parent\n\n#165\n'),
      issue(176, 'Provision and go live', '## Parent\n\n#165\n', ['ready-for-human']),
      issue(125, 'Agent guide', '', []),
    ];
    const tickets = buildTickets(raw, [[], [], [], []]);
    const frontier = classify(tickets, []);
    const ownership = { held: new Set([166]), triager: false };

    const report = frontierReport(tickets, frontier, [], new Map(), [], 'felipearosr', ownership);
    expect(report.human).toEqual([
      { number: 125, title: 'Agent guide', reason: 'untriaged' },
      { number: 166, title: 'Store schema', reason: 'held' },
      { number: 176, title: 'Provision and go live', reason: 'ready-for-human' },
    ]);
    const marks = Object.fromEntries(
      report.tree.flatMap((group) => group.roots).map((node) => [node.number, node.human]),
    );
    expect(marks).toEqual({ 125: 'untriaged', 166: 'held', 176: 'ready-for-human' });

    const drawn = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [], ownership)));
    expect(drawn).toMatch(/#166 .*\[for you: held\]/);
    expect(drawn).toMatch(/#176 .*\[for you: ready-for-human\]/);
  });

  describe('counted for an empty take-one (#811)', () => {
    const raw = [
      issue(1, 'for a person', '', ['ready-for-human']),
      issue(2, 'asked the filer', '', ['needs-info']),
      issue(3, 'out of scope', '', ['ready-for-agent']),
      issue(4, 'nobody labelled it', '', []),
      // None of these is the operator's: claimed, stuck, and a container.
      issue(5, 'claimed', '', ['ready-for-human', 'ralph-wip']),
      issue(6, 'stuck', '', ['ready-for-human', 'rafa-blocked']),
      issue(7, 'Spec: something', '', ['spec', 'ready-for-human']),
    ];
    const tickets = buildTickets(raw, raw.map(() => []));
    const frontier = classify(tickets, []);
    const empty = { ticket: null, tickets: [], bucket: null, claimed: false, obstructed: [] };

    it('counts one per reason, the same set the report lists', () => {
      const ownership = { held: new Set([3]), triager: false };
      const counts = waitingOnOperator(tickets, frontier, ownership);

      expect(counts).toEqual({ 'ready-for-human': 1, 'needs-info': 1, held: 1, untriaged: 1 });
      const listed = frontierReport(tickets, frontier, [], new Map(), [], 'felipearosr', ownership).human;
      expect(listed.map((t) => t.number)).toEqual([1, 2, 3, 4]);
      const out = JSON.parse(renderTakeOne(empty, { dryRun: true, waitingOnOperator: counts })) as Record<string, unknown>;
      expect(out.waitingOnOperator).toEqual(counts);
    });

    it('leaves untriaged at zero when a triager runs, every key still present', () => {
      expect(waitingOnOperator(tickets, frontier, { held: new Set([3]), triager: true })).toEqual({
        'ready-for-human': 1,
        'needs-info': 1,
        held: 1,
        untriaged: 0,
      });
    });

    it('leaves the JSON untouched on an offer or an error', () => {
      const counts = waitingOnOperator(tickets, frontier, { held: new Set([3]), triager: false });
      const offered = {
        ticket: { number: 10, title: 'free', tree: 10 },
        tickets: [{ number: 10, title: 'free', tree: 10 }],
        bucket: 'ready' as const,
        claimed: true,
        obstructed: [],
      };
      const plain = renderTakeOne(offered, { dryRun: false });
      expect(renderTakeOne(offered, { dryRun: false, waitingOnOperator: counts })).toBe(plain);
      expect(JSON.parse(plain) as Record<string, unknown>).not.toHaveProperty('waitingOnOperator');

      const failed = renderTakeOne(empty, { dryRun: true, error: 'boom' });
      expect(renderTakeOne(empty, { dryRun: true, error: 'boom', waitingOnOperator: counts })).toBe(failed);
      expect(JSON.parse(failed) as Record<string, unknown>).not.toHaveProperty('waitingOnOperator');
      expect(renderTakeOne(empty, { dryRun: true, waitingOnOperator: null })).toBe(renderTakeOne(empty, { dryRun: true }));
    });
  });

  it('marks labels only for a caller that read no plan and no roster', () => {
    const tickets = buildTickets([issue(1, 'a', '', ['ready-for-human']), issue(2, 'b', '', [])], [[], []]);
    const report = frontierReport(tickets, classify(tickets, []), []);
    expect(report.human).toEqual([{ number: 1, title: 'a', reason: 'ready-for-human' }]);
  });

  it("reads the plan's out-of-scope list, falling back to the checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-holds-'));
    mkdirSync(join(root, '.ralph'));
    writeFileSync(
      join(root, '.ralph', 'plan.md'),
      '# Plan\n\n## Out of scope — never pick\n\n- #166, #167 (held).\n- #176 (HITL only).\n\n## Parent closure exceptions\n\n- #165\n',
    );
    expect([...(await readPlanHolds(root))].sort((a, b) => a - b)).toEqual([166, 167, 176]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('frontierReport', () => {
  it('carries every bucket render prints, keyed for a program', () => {
    const raw = [
      issue(542, 'Spec: Poster Slot', ''),
      issue(544, 'migrate A', `## Parent\n\n#542\n`),
      issue(545, 'migrate B', `## Parent\n\n#542\n`),
      issue(550, 'Claimed by remo', '', ['ready-for-agent', 'remo-wip']),
      issue(551, 'Waits on the claim', blockedBy(550)),
      issue(552, 'Waits on a gate', blockedBy(560)),
      issue(560, 'Gate off the queue', '', []),
      issue(561, 'Stuck off the queue', '', ['rafa-blocked']),
    ];
    const tickets = buildTickets(raw, [[], [], [], [], [{ number: 550, state: 'open' }], [{ number: 560, state: 'open' }], [], []]);
    const report = frontierReport(tickets, classify(tickets, []), []);

    expect(report.ready).toEqual([
      {
        spec: { number: 542, title: 'Spec: Poster Slot' },
        staffingGroup: null,
        waiting: 1,
        tickets: [{ number: 544, title: 'migrate A', frees: 0, stuck: null }],
      },
    ]);
    expect(report.occupied).toEqual([{ number: 545, title: 'migrate B', heldBy: 544 }]);
    expect(report.specs).toEqual([{ number: 542, title: 'Spec: Poster Slot', children: 2 }]);
    expect(report.inFlight).toEqual([
      { number: 550, title: 'Claimed by remo', loop: 'remo', claim: 'remo-wip', queued: true },
    ]);
    expect(report.blocked).toEqual([
      { number: 551, title: 'Waits on the claim', blockers: [550], stuck: null },
      { number: 552, title: 'Waits on a gate', blockers: [560], stuck: null },
    ]);
    expect(report.gates).toEqual([{ number: 560, title: 'Gate off the queue' }]);
    expect(report.stuck).toEqual([{ number: 561, title: 'Stuck off the queue', label: 'rafa-blocked' }]);
    // The tree is the same backlog by spec, in buildTree's own order.
    expect(report.tree).toEqual(classify(tickets, []) && buildTree(tickets, classify(tickets, []), []));
    expect(report.tree.find((g) => g.spec?.number === 542)?.roots.map((n) => [n.number, n.state, n.heldBy])).toEqual([
      [544, 'ready', null],
      [545, 'occupied', 544],
    ]);
    // The document is plain data: no colour escapes reach a consumer.
    // oxlint-disable-next-line no-control-regex -- matching the ANSI escape byte is the point
    expect(JSON.stringify(report)).not.toMatch(/\x1b/);
  });

  it('names an assignee or PR claim without inventing a loop', () => {
    const raw = [
      issue(10, 'Taken by hand', '', ['ready-for-agent'], ['felipearosr']),
      issue(11, 'Fenced by a PR', ''),
    ];
    const tickets = buildTickets(raw, [[], []], new Set(), [{ number: 99, closingIssuesReferences: [{ number: 11 }] }]);
    const report = frontierReport(tickets, classify(tickets, []), []);
    expect(report.inFlight).toEqual([
      { number: 10, title: 'Taken by hand', loop: null, claim: 'assigned to felipearosr', queued: true },
      { number: 11, title: 'Fenced by a PR', loop: null, claim: 'PR #99', queued: true },
    ]);
  });

  it('names a live loop branch claim after the PR, without inventing a loop', () => {
    const raw = [issue(12, 'Fenced by a branch', '', ['ready-for-agent'])];
    const tickets = buildTickets(raw, [[]], new Set(), [], new Map([[12, branchClaim('rafa/12-x')]]));
    const report = frontierReport(tickets, classify(tickets, []), []);
    expect(report.inFlight).toEqual([
      { number: 12, title: 'Fenced by a branch', loop: null, claim: 'branch rafa/12-x', queued: true },
    ]);
  });

  it('gives every stuck ticket a reason, wherever its bucket, and unknown where none was read', () => {
    const raw = [
      issue(20, 'Needs a migration', '', ['ready-for-agent', 'rafa-blocked']),
      issue(21, 'Red CI', '', ['ralph-blocked']),
      issue(22, 'Never read', '', ['ready-for-agent', 'remo-blocked']),
      issue(23, 'Not stuck', ''),
    ];
    const tickets = buildTickets(raw, [[], [], [], []]);
    const migration = { kind: 'migration' as const, reason: 'needs-migration: apply drizzle/0062_x.sql', pr: 1242, migration: 'drizzle/0062_x.sql', at: null };
    const other = { kind: 'other' as const, reason: 'Blocked: red CI', pr: 1276, migration: null, at: null };
    const report = frontierReport(tickets, classify(tickets, []), [], new Map<number, BlockReason>([[20, migration], [21, other]]));
    expect(report.stuckReasons).toEqual([
      { number: 20, title: 'Needs a migration', ...migration, park: null },
      { number: 21, title: 'Red CI', ...other, park: null },
      { number: 22, title: 'Never read', kind: 'unknown', reason: null, pr: null, migration: null, at: null, park: null },
    ]);
  });
});

describe('untriaged', () => {
  const JAV = ['difficulty:easy', 'difficulty:hard'];
  const section = (out: string): string =>
    out.split(/^UNTRIAGED/m)[1]?.split(/^(?:SPECS|IN FLIGHT|BLOCKED|STUCK)/m)[0] ?? '';

  // Every kind of open ticket, so each exclusion is checked against the rest.
  const raw = [
    issue(1, 'Ready, no label', ''),
    issue(2, 'Ready, labelled', '', ['ready-for-agent', 'difficulty:hard']),
    issue(3, 'Holder sibling, labelled', `## Parent\n\n#99\n`, ['ready-for-agent', 'difficulty:easy']),
    issue(4, 'Held sibling, no label', `## Parent\n\n#99\n`),
    issue(5, 'Claimed by a loop', '', ['ready-for-agent', 'remo-wip']),
    issue(6, 'Claimed by hand', '', ['ready-for-agent'], ['felipearosr']),
    issue(7, 'Stuck', '', ['ready-for-agent', 'rafa-blocked']),
    issue(8, 'A spec', '', ['ready-for-agent', 'spec']),
    issue(9, 'Blocked', blockedBy(1)),
    issue(10, 'Not queued', '', []),
    issue(11, 'Fenced by a PR', ''),
  ];
  const tickets = (): Map<number, Ticket> =>
    buildTickets(
      raw,
      raw.map((r) => (r.number === 9 ? [{ number: 1, state: 'open' as const }] : [])),
      new Set(),
      [{ number: 500, closingIssuesReferences: [{ number: 11 }] }],
    );

  it('lists unlabelled ready and occupied tickets, and never claimed, stuck, spec, blocked or unqueued ones', () => {
    const t = tickets();
    const frontier = classify(t, []);
    // #4 is OCCUPIED behind #3 (one legacy tree): unblocked, unclaimed, still unrouted.
    expect(frontier.occluded.map((x) => x.number)).toEqual([4]);
    expect(untriagedTickets(frontier, JAV).map((x) => x.number)).toEqual([1, 4]);

    const out = stripAnsi(render(t, frontier, JAV));
    expect(out).toContain('UNTRIAGED — 2 ready, but no loop takes them until they carry a difficulty label (difficulty:easy, difficulty:hard)');
    const listed = section(out);
    expect(listed).toMatch(/^\s+#1\s+Ready, no label$/m);
    expect(listed).toMatch(/^\s+#4\s+Held sibling, no label$/m);
    for (const n of [2, 3, 5, 6, 7, 8, 9, 10, 11]) expect(listed).not.toMatch(new RegExp(`#${n}\\b`));
    // Placed beside the other buckets: after OCCUPIED, before the claimed ones.
    expect(out.indexOf('OCCUPIED')).toBeLessThan(out.indexOf('UNTRIAGED'));
    expect(out.indexOf('UNTRIAGED')).toBeLessThan(out.indexOf('IN FLIGHT'));

    expect(frontierReport(t, frontier, [], new Map(), JAV).untriaged).toEqual([
      { number: 1, title: 'Ready, no label' },
      { number: 4, title: 'Held sibling, no label' },
    ]);
  });

  it('leaves out a routing-exempt ticket, which no triager needs to label', () => {
    // felipearos/ralph#233: routing offers a ci-doctor filing to every loop
    // already, so asking a triager for a difficulty it cannot know would park
    // the bucket on work nobody is waiting for.
    const withFilings = [
      ...raw,
      issue(12, 'Urgent filing, no label', '', ['ready-for-agent', 'ci-health', 'bug', 'priority:urgent']),
      issue(13, 'Forward fix, no label', '', ['ready-for-agent', 'ci-health', 'bug']),
    ];
    const t = buildTickets(
      withFilings,
      withFilings.map((r) => (r.number === 9 ? [{ number: 1, state: 'open' as const }] : [])),
      new Set(),
      [{ number: 500, closingIssuesReferences: [{ number: 11 }] }],
    );
    const frontier = classify(t, []);
    // Both filings are ready and unlabelled, so only the exemption keeps them
    // out — #1 and #4 are the controls, the same two the case above lists.
    expect(frontier.readyTasks.map((x) => x.number)).toEqual(expect.arrayContaining([1, 12, 13]));
    expect(untriagedTickets(frontier, JAV).map((x) => x.number)).toEqual([1, 4]);
    expect(frontierReport(t, frontier, [], new Map(), JAV).untriaged.map((x) => x.number)).toEqual([1, 4]);
    expect(triageBuckets(t, frontier, { javLabels: JAV, owner: 'felipearosr' }).routing.map((x) => x.number)).toEqual(
      [1, 4],
    );
  });

  it('leaves the report as it was when no Jav labels are configured', () => {
    const t = tickets();
    const frontier = classify(t, []);
    expect(untriagedTickets(frontier, [])).toEqual([]);
    expect(stripAnsi(render(t, frontier, []))).toBe(stripAnsi(render(t, frontier)));
    expect(stripAnsi(render(t, frontier))).not.toContain('UNTRIAGED');
    expect(frontierReport(t, frontier, []).untriaged).toEqual([]);
  });

  it('changes nothing a coder picks: the frontier, its candidates and every other bucket stay the same', () => {
    const t = tickets();
    const frontier = classify(t, []);
    const before = {
      ready: frontier.readyTasks.map((x) => x.number),
      occluded: frontier.occluded.map((x) => x.number),
      candidates: takeOneCandidates(frontier).map((x) => x.number),
    };
    const plain = frontierReport(t, frontier, []);
    const labelled = frontierReport(t, frontier, [], new Map(), JAV);
    render(t, frontier, JAV);

    // Listing is read-only: the frontier the claim walks is untouched.
    expect(frontier.readyTasks.map((x) => x.number)).toEqual(before.ready);
    expect(frontier.occluded.map((x) => x.number)).toEqual(before.occluded);
    expect(takeOneCandidates(frontier).map((x) => x.number)).toEqual(before.candidates);
    // Only the two fields the labels are ABOUT differ — `untriaged` and the
    // routing count over it. Every other bucket, triage's included, is the same
    // picture it was before anyone configured Jav.
    const { untriaged: _plain, triage: plainTriage, ...plainRest } = plain;
    const { untriaged: _labelled, triage: labelledTriage, ...labelledRest } = labelled;
    expect(labelledRest).toEqual(plainRest);
    expect(plainTriage.routing).toBe(0);
    expect(labelledTriage.routing).toBe(2);
    expect({ ...labelledTriage, routing: 0 }).toEqual(plainTriage);
    expect(readySection(stripAnsi(render(t, frontier, JAV)))).toBe(readySection(stripAnsi(render(t, frontier))));
    expect(readySection(stripAnsi(render(t, frontier, JAV)))).toMatch(/#1\b/);

    // Jav's route in `--take-one` is unchanged: a routed loop still never
    // reaches an untriaged ticket, and with Jav off every loop still does.
    const candidates = takeOneCandidates(frontier);
    const DIFFICULTY = ['difficulty:easy', 'difficulty:hard'];
    expect(routeByDifficulty(candidates, ['difficulty:hard'], DIFFICULTY).map((x) => x.number)).toEqual([2]);
    expect(routeByDifficulty(candidates, ['difficulty:easy'], DIFFICULTY).map((x) => x.number)).toEqual([3]);
    expect(routeByDifficulty(candidates, null, DIFFICULTY).map((x) => x.number)).toEqual(before.candidates);
  });
});

describe('reportJavLabels', () => {
  const config = (enabled: boolean): JavConfig => ({
    enabled,
    labels: ['difficulty:easy', 'difficulty:hard'],
    routes: { default: ['difficulty:easy', 'difficulty:hard'] },
  });

  it("returns the project's labels whether or not routing is enabled", () => {
    expect(reportJavLabels(() => config(true))).toEqual(['difficulty:easy', 'difficulty:hard']);
    expect(reportJavLabels(() => config(false))).toEqual(['difficulty:easy', 'difficulty:hard']);
    expect(reportJavLabels(() => DEFAULT_JAV)).toEqual([]);
  });

  it('falls back to no labels, with a warning, when jav.json cannot be read', () => {
    const warnings: string[] = [];
    const labels = reportJavLabels(
      () => {
        throw new Error('jav.json is not valid JSON');
      },
      (message) => warnings.push(message),
    );
    expect(labels).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('jav.json is not valid JSON')]);
  });
});

describe('readStuckReasons', () => {
  it('reads each stuck ticket\'s comments once and classifies the newest block record', async () => {
    const asked: string[][] = [];
    const comments: Record<string, { body: string }[]> = {
      '1219': [{ body: '### Ticket #1219 blocked\n\nneeds-migration: draft PR #1242 ready; apply drizzle/0062_streaming_region.sql' }],
      '1109': [{ body: 'Blocked: PR #1276 had two red Buildkite runs.' }],
    };
    const gh = async (args: string[]) => {
      asked.push(args);
      return JSON.stringify({ comments: comments[args[2]!] });
    };
    // Through the GitHub adapter the frontier runs, unpinned: the argv is what it always was.
    const reasons = await readStuckReasons([1109, 1219], createGithubTracker({ repo: 'o/r', owner: 'o', pinned: false, gh, read: gh }));
    expect(asked).toEqual([
      ['issue', 'view', '1109', '--json', 'comments'],
      ['issue', 'view', '1219', '--json', 'comments'],
    ]);
    expect(reasons.get(1219)).toMatchObject({ kind: 'migration', pr: 1242, migration: 'drizzle/0062_streaming_region.sql' });
    expect(reasons.get(1109)).toMatchObject({ kind: 'other', pr: 1276 });
  });

  it('leaves a ticket whose comments cannot be read unknown instead of failing the frontier', async () => {
    const reasons = await readStuckReasons([7], { comments: async () => { throw new Error('gh: HTTP 502'); } });
    expect(reasons.get(7)?.kind).toBe('unknown');
  });
});

describe('truncate', () => {
  it('leaves short strings alone and ellipsises long ones', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghijk', 5)).toBe('abcd…');
  });
});

describe('claimObstruction', () => {
  const live = (assignees: string[], labels: string[] = []) => ({
    assignees: assignees.map((login) => ({ login })),
    labels: labels.map((name) => ({ name })),
  });

  it('permits an unassigned, unlabelled ticket', async () => {
    expect(await claimObstruction(live([]))).toBeNull();
  });

  it('permits a ticket already assigned to the owner', async () => {
    expect(await claimObstruction(live(['felipearosr']))).toBeNull();
  });

  it('refuses a ticket someone else claimed inside the snapshot window', async () => {
    expect(await claimObstruction(live(['someone-else']))).toContain('assigned to someone-else');
  });

  it('refuses a ticket either loop claimed or flagged as stuck', async () => {
    expect(await claimObstruction(live([], ['ralph-wip']))).toContain('ralph-wip');
    expect(await claimObstruction(live([], ['ralph-blocked']))).toContain('ralph-blocked');
    // The fence is "somebody has this", so it cannot care which loop that is:
    // a `rafa-wip` this path failed to read is a claim it would write over.
    expect(await claimObstruction(live([], ['rafa-wip']))).toContain('rafa-wip');
    expect(await claimObstruction(live([], ['rafa-blocked']))).toContain('rafa-blocked');
  });

  it('ignores labels that merely mention the queue', async () => {
    expect(await claimObstruction(live([], ['ready-for-agent', 'bug']))).toBeNull();
  });

  it('refuses a ticket an open PR closes, on the maintainer path too', async () => {
    // The path that actually fired: `bun run next` assigning READY NOW. It
    // carries its own copy of the PR wiring, so covering only the loop's
    // fence would leave the maintainer's able to claim over an open PR.
    const withPr: LiveIssue = {
      assignees: [],
      labels: [],
      closedByPullRequestsReferences: [{ number: 742 }],
    };
    expect(await claimObstruction(withPr, async () => true)).toBe('open PR #742');
    expect(await claimObstruction(withPr, async () => false)).toBeNull();
    expect(await claimObstruction(withPr)).toBeNull();
  });
});

describe('claim set', () => {
  it('claims exactly what READY NOW prints, and nothing occupied or blocked', () => {
    const raw = [
      issue(1, 'ready', ''),
      issue(2, 'held', `## Parent\n\n#99\n`, ['ready-for-agent', 'ralph-wip']),
      issue(3, 'sibling of held', `## Parent\n\n#99\n`),
      issue(4, 'blocked', blockedBy(1)),
    ];
    // ONE frontier for both, exactly as main() does: a second classify() call
    // could not detect a print/claim divergence, which is the guarantee the
    // shared Frontier exists to give.
    const tickets = buildTickets(raw, [[], [], [], []]);
    const frontier = classify(tickets, []);
    const out = stripAnsi(render(tickets, frontier));
    const claimed = frontier.readyTasks.map((t) => t.number);

    expect(claimed).toEqual([1]);
    expect(out).toContain('READY NOW — 1 ticket');
  });
});

describe('renderClaims', () => {
  it('says nothing when there was nothing to claim', () => {
    expect(renderClaims([])).toBe('');
  });

  it('distinguishes a fresh claim from one left alone or failed', () => {
    const out = stripAnsi(
      renderClaims([
        { number: 1, status: 'claimed' },
        { number: 2, status: 'skipped', detail: 'labeled ralph-wip' },
        { number: 3, status: 'failed', detail: 'HTTP 500' },
        { number: 4, status: 'already-mine' },
      ]),
    );
    expect(out).toContain('CLAIMED — assigned to felipearosr');
    expect(out).toMatch(/#2 left alone — labeled ralph-wip/);
    expect(out).toMatch(/#3 claim failed — HTTP 500/);
    expect(out).toMatch(/#4 already mine/);
  });
});

/**
 * Single-ticket mode. A caller — a Ralph iteration, or a person — asks for one
 * ticket and gets one, already claimed, with no possibility that a second
 * caller receives the same one. The decision layer is pinned here: which
 * ticket comes back, which fence obstructs it, and what a second caller sees.
 */

const live = (assignees: string[], labels: string[] = []): LiveIssue => ({
  assignees: assignees.map((login) => ({ login })),
  labels: labels.map((name) => ({ name })),
});

/** A frontier built the way production builds it — one classification. */
/** A coder's units: one ticket each, which is what `--take-one` always claimed. */
const readyUnits = (tickets: Ticket[]): FrontierUnit[] =>
  tickets.map((ticket) => ({ bucket: 'ready' as const, tickets: [ticket] }));

const frontierOf = (raw: RawIssue[], closedChildParents: number[] = []) => {
  const tickets = buildTickets(
    raw,
    raw.map(() => []),
  );
  return { tickets, frontier: classify(tickets, closedChildParents) };
};

/**
 * A GitHub whose state a claim actually mutates, so "the second caller" is a
 * second call against the state the first one left behind rather than a
 * hand-written fixture asserting what we hope happened.
 */
const fakeHub = (
  initial: Record<number, { assignees?: string[]; labels?: string[]; prs?: number[] }> = {},
  /** PR numbers the probe reports open. Omitted entirely means no probe. */
  openPrNumbers?: number[],
) => {
  const state = new Map<number, { assignees: string[]; labels: string[]; prs: number[] }>();
  for (const [number, s] of Object.entries(initial)) {
    state.set(Number(number), {
      assignees: s.assignees ?? [],
      labels: s.labels ?? [],
      prs: s.prs ?? [],
    });
  }
  const reads: number[] = [];
  const writes: number[] = [];
  const at = (n: number) => state.get(n) ?? { assignees: [], labels: [], prs: [] };
  return {
    state,
    reads,
    writes,
    io: {
      readLive: async (n: number): Promise<LiveIssue> => {
        reads.push(n);
        return {
          ...live(at(n).assignees, at(n).labels),
          closedByPullRequestsReferences: at(n).prs.map((number) => ({ number })),
        };
      },
      ...(openPrNumbers === undefined
        ? {}
        : { isOpenPr: async (n: number): Promise<boolean> => openPrNumbers.includes(n) }),
      claim: async (n: number): Promise<void> => {
        writes.push(n);
        state.set(n, { ...at(n), labels: [...at(n).labels, 'ralph-wip'] });
      },

    },
  };
};

/** Two trees, where the second one printed is NOT the lower-numbered one. */
const twoTrees = (): RawIssue[] => [
  issue(10, 'tree A slice', '## Parent\n\n#1\n'),
  issue(11, 'tree A sibling', '## Parent\n\n#1\n'),
  issue(20, 'tree B slice', '## Parent\n\n#2\n'),
  issue(30, 'gated by tree B', `## Parent\n\n#2\n\n## Blocked by\n\n- #20\n`),
];

describe('loopClaimObstruction', () => {
  it('permits an unassigned, unlabelled ticket', async () => {
    expect(await loopClaimObstruction(live([]))).toBeNull();
  });

  it("refuses the maintainer's assignee, which the maintainer's own path permits", async () => {
    // The two fences must stay distinct: an assignee means a human took it, so
    // a loop must keep off it even though the maintainer may re-claim it.
    expect(await loopClaimObstruction(live(['felipearosr']))).toContain('felipearosr');
    expect(await claimObstruction(live(['felipearosr']))).toBeNull();
  });

  it('refuses a foreign assignee', async () => {
    expect(await loopClaimObstruction(live(['someone-else']))).toContain('someone-else');
  });

  it('refuses a ticket either loop already holds, or one flagged stuck', async () => {
    expect(await loopClaimObstruction(live([], ['ralph-wip']))).toContain('ralph-wip');
    expect(await loopClaimObstruction(live([], ['ralph-blocked']))).toContain('ralph-blocked');
    // Ralph reading rafa's claim, and the reverse: the whole point of running
    // two loops is that neither of them takes the other's ticket.
    expect(await loopClaimObstruction(live([], ['rafa-wip']))).toContain('rafa-wip');
    expect(await loopClaimObstruction(live([], ['rafa-blocked']))).toContain('rafa-blocked');
  });

  it('ignores labels that merely mention the queue', async () => {
    expect(await loopClaimObstruction(live([], ['ready-for-agent', 'bug']))).toBeNull();
  });

  it('lets a RESCUE claim past the block it names, and nothing else past it', async () => {
    // Every ticket the rescue bucket offers carries a coder's block by
    // definition, so without this the bucket is unreachable: the live re-read
    // would obstruct all of them and the hand-over would answer "obstructed"
    // forever.
    const rescuable = ['rafa-blocked'];
    expect(await loopClaimObstruction(live([], ['rafa-blocked']), undefined, { rescuable })).toBeNull();

    // A live claim and an assignee still refuse it.
    expect(await loopClaimObstruction(live([], ['rafa-wip']), undefined, { rescuable })).toContain('rafa-wip');
    expect(await loopClaimObstruction(live(['someone-else'], ['rafa-blocked']), undefined, { rescuable })).toContain(
      'someone-else',
    );

    // And so does a block it was NOT sent for: a ticket carrying a coder's
    // block and a triager's is one somebody put in front of a person, and a
    // claim would write a `-wip` over that.
    expect(await loopClaimObstruction(live([], ['rafa-blocked', 'rulo-blocked']), undefined, { rescuable })).toContain(
      'rulo-blocked',
    );
    expect(await loopClaimObstruction(live([], ['ralph-blocked']), undefined, { rescuable })).toContain('ralph-blocked');

    // It is opt-in: the default is unchanged.
    expect(await loopClaimObstruction(live([], ['rafa-blocked']))).toContain('rafa-blocked');
  });

  it('refuses a ticket an open PR closes, and only while the PR is open', async () => {
    const withPr = (refs: { number: number }[]): LiveIssue => ({
      assignees: [],
      labels: [],
      closedByPullRequestsReferences: refs,
    });
    const open = async (n: number): Promise<boolean> => n === 742;

    expect(await loopClaimObstruction(withPr([{ number: 742 }]), open)).toBe('open PR #742');
    // A closed-unmerged PR is nobody's claim: the field carries no state, so
    // the probe is what separates a holder from a finished attempt.
    expect(await loopClaimObstruction(withPr([{ number: 742 }]), async () => false)).toBeNull();
    // An absent probe must not invent a refusal.
    expect(await loopClaimObstruction(withPr([{ number: 742 }]))).toBeNull();
  });

  it('names the lowest open PR when several are linked', async () => {
    const withPr = (refs: { number: number }[]): LiveIssue => ({
      assignees: [],
      labels: [],
      closedByPullRequestsReferences: refs,
    });
    const open = async (n: number): Promise<boolean> => n === 800 || n === 742;
    expect(await loopClaimObstruction(withPr([{ number: 800 }, { number: 742 }]), open)).toBe(
      'open PR #742',
    );
  });

  it('lets the assignee and label checks outrank the PR probe', async () => {
    const open = async (): Promise<boolean> => true;
    expect(
      await loopClaimObstruction(
        {
          assignees: [{ login: 'someone-else' }],
          labels: [],
          closedByPullRequestsReferences: [{ number: 742 }],
        },
        open,
      ),
    ).toContain('someone-else');
    expect(
      await loopClaimObstruction(
        {
          assignees: [],
          labels: [{ name: 'ralph-wip' }],
          closedByPullRequestsReferences: [{ number: 742 }],
        },
        open,
      ),
    ).toContain('ralph-wip');
  });
});

/**
 * Two loops, one tracker. The labels carry the identity — `ralph-wip` and
 * `rafa-wip` — so an issue says who has it without a second lookup, and the
 * name in the label is the only thing that varies between the two.
 *
 * The asymmetry pinned here is the whole design: reads span both loops
 * (a claim is a claim, whoever wrote it) and the write names exactly one.
 */
describe('loop identity', () => {
  it('defaults to ralph, which is the identity already on the tracker', () => {
    // The loop-name file is named explicitly as absent. `currentLoop`'s second
    // parameter defaults to `findLoopNameFile()`, which walks up from the CWD
    // — so leaving it out asserted the default against whatever worktree the
    // suite happened to run in, and this case failed in every checkout whose
    // `.ralph/loop-name` was not `ralph`. The file's own semantics are the
    // nested describe's below.
    expect(currentLoop({}, null)).toBe('ralph');
    expect(currentLoop({ RALPH_LOOP_NAME: '' }, null)).toBe('ralph');
  });

  it('claims under the loop the supervisor names', () => {
    expect(wipLabelFor(currentLoop({ RALPH_LOOP_NAME: 'rafa' }))).toBe('rafa-wip');
    expect(wipLabelFor(currentLoop({ RALPH_LOOP_NAME: 'ralph' }))).toBe('ralph-wip');
  });

  it('refuses a name no reader consults rather than claiming under it', () => {
    // A claim written as `rafa2-wip` fences nothing: every read here asks for
    // a known loop, so the other supervisor would walk straight over it.
    expect(() => currentLoop({ RALPH_LOOP_NAME: 'rafa2' })).toThrow(/ralph, rafa/);
  });

  /**
   * The HAND path. Under the supervisor `RALPH_LOOP_NAME` is always exported,
   * so the file is never consulted; a maintainer running `bun run next --
   * --take-one` from the second worktree has no such export, and before this
   * was read here that claim went out as `ralph-wip` from a checkout whose
   * every other mark said `rafa`.
   */
  describe('resolved from the worktree when the environment is silent', () => {
    const loopNameFile = (contents: string | null): string => {
      const dir = join(tmpdir(), `loop-name-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, '.loop-name');
      if (contents !== null) writeFileSync(file, contents);
      return file;
    };

    it('reads the name the worktree carries', () => {
      expect(currentLoop({}, loopNameFile('rafa\n'))).toBe('rafa');
      expect(currentLoop({}, loopNameFile('rafa'))).toBe('rafa');
    });

    it('still lets the environment win, which is what the supervisor exports', () => {
      expect(currentLoop({ RALPH_LOOP_NAME: 'ralph' }, loopNameFile('rafa\n'))).toBe('ralph');
    });

    it('defaults to ralph only when the worktree makes no claim at all', () => {
      expect(currentLoop({}, loopNameFile(null))).toBe('ralph');
    });

    /**
     * The default is not neutral — it is the loop that owns the tracker's
     * original labels — so falling back from a file that EXISTS but says
     * nothing would hand the second loop the first one's claim at exactly the
     * moment its identity broke. Refusing costs a message; defaulting costs a
     * claim nobody can attribute.
     */
    it('refuses a file that exists but yields no name, rather than defaulting', () => {
      expect(() => currentLoop({}, loopNameFile(''))).toThrow(/is empty/);
      expect(() => currentLoop({}, loopNameFile('  \n'))).toThrow(/is empty/);
    });

    it('refuses an unreadable file rather than defaulting past it', () => {
      const dir = join(tmpdir(), `loop-name-${randomUUID()}`);
      mkdirSync(join(dir, '.loop-name'), { recursive: true });
      expect(() => currentLoop({}, join(dir, '.loop-name'))).toThrow(/could not be read/);
    });

    /**
     * `frontier/next.ts` runs the pinned `origin/main` payload out of a
     * temporary directory, so the identity cannot be resolved from this
     * file's own location — it would look beside `/tmp/ralph-next-*`, find
     * nothing, and claim `ralph-wip` from the rafa worktree. The cwd is the
     * operator's, and that is whose identity the claim carries.
     */
    it('finds the name by walking up from the working directory', () => {
      const root = join(tmpdir(), `worktree-${randomUUID()}`);
      mkdirSync(join(root, '.ralph'), { recursive: true });
      writeFileSync(join(root, '.ralph', 'loop-name'), 'rafa\n');
      mkdirSync(join(root, 'src', 'server'), { recursive: true });

      expect(findLoopNameFile(root)).toBe(join(root, '.ralph', 'loop-name'));
      // From a subdirectory it must resolve the same, or the answer depends
      // on where the operator happened to be standing.
      expect(findLoopNameFile(join(root, 'src', 'server'))).toBe(
        join(root, '.ralph', 'loop-name'),
      );
      expect(currentLoop({}, findLoopNameFile(join(root, 'src')))).toBe('rafa');
    });

    it('gives up at the filesystem root rather than walking forever', () => {
      const bare = join(tmpdir(), `no-worktree-${randomUUID()}`);
      mkdirSync(bare, { recursive: true });

      expect(findLoopNameFile(bare)).toBeNull();
      expect(currentLoop({}, findLoopNameFile(bare))).toBe('ralph');
    });

    it('names the file, not the variable, when the file is what is wrong', () => {
      // The operator has to know WHICH of the two inputs to go and fix.
      expect(() => currentLoop({}, loopNameFile('rafa2\n'))).toThrow(/\.loop-name must be one of/);
      expect(() => currentLoop({ RALPH_LOOP_NAME: 'rafa2' })).toThrow(/RALPH_LOOP_NAME must be/);
    });
  });

  it('reads a claim or a wedge from either loop, and names which', () => {
    expect(wipLabelOf(['ready-for-agent', 'rafa-wip'])).toBe('rafa-wip');
    expect(wipLabelOf(new Set(['ralph-wip']))).toBe('ralph-wip');
    expect(wipLabelOf(['ready-for-agent'])).toBeNull();
    expect(stuckLabelOf(['rafa-blocked'])).toBe('rafa-blocked');
    expect(stuckLabelOf(['ralph-wip'])).toBeNull();
  });
});

describe('takeOneCandidates', () => {
  it('offers the ticket the frontier prints first, ahead of a lower-numbered tree', () => {
    const { tickets, frontier } = frontierOf(twoTrees());
    const printed = readySection(stripAnsi(render(tickets, frontier)));
    const candidates = takeOneCandidates(frontier).map((t) => t.number);

    expect(candidates[0]).toBe(20);
    expect(printed.indexOf('#20')).toBeLessThan(printed.indexOf('#10'));
    expect(candidates).toEqual([20, 10]);
  });

  it('never offers two tickets from one tree', () => {
    const { frontier } = frontierOf(twoTrees());
    const trees = takeOneCandidates(frontier).map((t) => treeOf(t));
    expect(new Set(trees).size).toBe(trees.length);
    expect(takeOneCandidates(frontier).map((t) => t.number)).not.toContain(11);
  });

  it('withholds caller-excluded tickets from the atomic claim candidates', () => {
    const { frontier } = frontierOf(twoTrees());

    expect(takeOneCandidates(frontier, new Set([20])).map((ticket) => ticket.number)).toEqual([10]);
  });

  it('offers nothing when the frontier is empty', () => {
    const { frontier } = frontierOf([issue(1, 'held', '', ['ready-for-agent', 'ralph-wip'])]);
    expect(takeOneCandidates(frontier)).toEqual([]);
  });

  it('does not offer a ticket held by an open PR', () => {
    const raw = [issue(1, 'has a PR', ''), issue(2, 'free', '')];
    const prs: OpenPullRequest[] = [{ number: 742, closingIssuesReferences: [{ number: 1 }] }];
    const tickets = buildTickets(raw, [[], []], new Set(), prs);
    const frontier = classify(tickets, []);
    expect(takeOneCandidates(frontier).map((t) => t.number)).toEqual([2]);
  });

  /** Spec #373, its children #381 and #382, and an unrelated free ticket — the 2026-10-21 shape. */
  const splitSpec = (): RawIssue[] => [
    issue(373, 'the spec', ''),
    issue(381, 'child one', '## Parent\n#373'),
    issue(382, 'child two', '## Parent\n#373'),
    issue(400, 'unrelated', ''),
  ];

  it('fences the children of a spec a PR body references', () => {
    const raw = splitSpec();
    const prs: OpenPullRequest[] = [{ number: 375, closingIssuesReferences: [], references: [{ number: 373 }] }];
    const tickets = buildTickets(raw, raw.map(() => []), new Set(), prs);
    expect(takeOneCandidates(classify(tickets, [])).map((t) => t.number)).toEqual([400]);
    expect(tickets.get(381)!.openPullRequest).toBe(375);
    expect(tickets.get(382)!.openPullRequest).toBe(375);
  });

  it('fences the children of a spec a PR closes', () => {
    const raw = splitSpec();
    const prs: OpenPullRequest[] = [{ number: 375, closingIssuesReferences: [{ number: 373 }] }];
    const tickets = buildTickets(raw, raw.map(() => []), new Set(), prs);
    expect(takeOneCandidates(classify(tickets, [])).map((t) => t.number)).toEqual([400]);
    expect(tickets.get(381)!.openPullRequest).toBe(375);
    expect(tickets.get(382)!.openPullRequest).toBe(375);
  });

  it('lets a child keep its own PR over its parent\'s', () => {
    const raw = splitSpec();
    const prs: OpenPullRequest[] = [
      { number: 375, closingIssuesReferences: [], references: [{ number: 373 }] },
      { number: 390, closingIssuesReferences: [{ number: 382 }] },
    ];
    const tickets = buildTickets(raw, raw.map(() => []), new Set(), prs);
    expect(tickets.get(381)!.openPullRequest).toBe(375);
    expect(tickets.get(382)!.openPullRequest).toBe(390);
  });

  it('does not fence a grandchild with the grandparent\'s PR', () => {
    const raw = [...splitSpec(), issue(383, 'grandchild', '## Parent\n#381')];
    const prs: OpenPullRequest[] = [{ number: 375, closingIssuesReferences: [], references: [{ number: 373 }] }];
    const tickets = buildTickets(raw, raw.map(() => []), new Set(), prs);
    expect(tickets.get(381)!.openPullRequest).toBe(375);
    expect(tickets.get(383)!.openPullRequest).toBeNull();
  });
});

describe('parseBodyReferences', () => {
  it('reads a keyword reference', () => {
    expect(parseBodyReferences('Part of #373.')).toEqual([373]);
  });

  it('reads several keywords, with or without a colon', () => {
    expect(parseBodyReferences('Refs: #12, Related to #13')).toEqual([12, 13]);
    expect(parseBodyReferences('Part of: #373\nref #4\nREFERENCES #5')).toEqual([373, 4, 5]);
  });

  it('ignores a bare mention in prose', () => {
    expect(parseBodyReferences('see #9')).toEqual([]);
  });

  it('ignores a cross-repo reference even after a keyword', () => {
    expect(parseBodyReferences('Part of other/repo#5')).toEqual([]);
  });

  it('ignores a reference quoted as code', () => {
    expect(parseBodyReferences('every body starting `Part of #373.`')).toEqual([]);
    expect(parseBodyReferences('```\nPart of #373.\n```\nPart of #12')).toEqual([12]);
  });

  it('reads nothing from an empty or missing body', () => {
    expect(parseBodyReferences('')).toEqual([]);
    expect(parseBodyReferences(undefined)).toEqual([]);
    expect(parseBodyReferences(null)).toEqual([]);
  });
});

describe('priority:urgent', () => {
  const URGENT = ['ready-for-agent', 'priority:urgent'];

  /**
   * Three groups the existing keys would order 20, 10, 40: #20 has progress,
   * #10 frees two, #40 neither. #40 is the urgent one, so every key the
   * lane is supposed to outrank is actually in play.
   */
  const threeGroups = (urgentLabels: string[] = URGENT): RawIssue[] => [
    issue(10, 'frees two', ''),
    issue(11, 'waits on 10', blockedBy(10)),
    issue(12, 'waits on 11', blockedBy(11)),
    issue(20, 'has progress', blockedBy(99)),
    issue(40, 'the urgent one', '', urgentLabels),
  ];

  /** `#99` is closed, which is what makes #20's blocker progress rather than a gate. */
  const withClosed99 = (raw: RawIssue[]) =>
    buildTickets(
      raw,
      raw.map(() => []),
      new Set([99]),
    );

  const offered = (raw: RawIssue[], excluded: number[] = []): number[] => {
    const tickets = withClosed99(raw);
    return takeOneCandidates(classify(tickets, []), new Set(excluded)).map((t) => t.number);
  };

  it('offers the urgent ticket before every other READY NOW group', () => {
    expect(offered(threeGroups())).toEqual([40, 20, 10]);
  });

  it('orders the groups exactly as today when nothing is urgent', () => {
    // The same fixture with the label dropped: the lane must be invisible, not
    // merely harmless, or every project pays for a feature it does not use.
    expect(offered(threeGroups(['ready-for-agent']))).toEqual([20, 10, 40]);
  });

  it('prints the urgent ticket first under READY NOW, tagged', () => {
    const tickets = withClosed99(threeGroups());
    const ready = readySection(stripAnsi(render(tickets, classify(tickets, []))));

    // The whole printed order, not just "#40 before #10": the weaker
    // assertion also passes with the urgent key demoted below `hasProgress`,
    // which is the one placement this test exists to rule out.
    expect([...ready.matchAll(/#(\d+)\s{2}/g)].map((m) => Number(m[1]))).toEqual([40, 20, 10]);
    expect(ready).toMatch(/#40\s+the urgent one.*URGENT/);
    // The tag belongs to the ticket that carries the label, not to the section.
    expect(ready).not.toMatch(/#10\s+frees two.*URGENT/);
  });

  it('leaves URGENT off every line when no ticket carries the label', () => {
    const tickets = withClosed99(threeGroups(['ready-for-agent']));
    expect(stripAnsi(render(tickets, classify(tickets, [])))).not.toContain('URGENT');
  });

  it('picks an urgent member over a sibling that frees more work', () => {
    // #11 frees two and would be the pick on unblocking power alone; #10 frees
    // nothing and is urgent. Same tree, no staffing group, so one of the two
    // is offered and the choice is the whole assertion.
    const raw = [
      issue(10, 'urgent slice', '## Parent\n\n#1\n', URGENT),
      issue(11, 'high-power slice', '## Parent\n\n#1\n'),
      issue(12, 'waits on 11', `## Parent\n\n#1\n\n${blockedBy(11)}`),
      issue(13, 'waits on 12', `## Parent\n\n#1\n\n${blockedBy(12)}`),
    ];
    const { frontier } = frontierOf(raw);

    expect(takeOneCandidates(frontier).map((t) => t.number)).toEqual([10]);
    expect(frontier.occupiedByTicket.get(11)?.number).toBe(10);
  });

  it('is not offered when a loop already holds it', () => {
    expect(offered([issue(40, 'urgent', '', [...URGENT, 'ralph-wip']), issue(10, 'free', '')])).toEqual([10]);
  });

  it('is not offered when a person is assigned to it', () => {
    const raw = [issue(40, 'urgent', '', URGENT, ['felipearosr']), issue(10, 'free', '')];
    expect(offered(raw)).toEqual([10]);
  });

  it('is not offered when an open PR closes it', () => {
    const raw = [issue(40, 'urgent', '', URGENT), issue(10, 'free', '')];
    const tickets = buildTickets(raw, [[], []], new Set(), [
      { number: 742, closingIssuesReferences: [{ number: 40 }] },
    ]);
    expect(takeOneCandidates(classify(tickets, [])).map((t) => t.number)).toEqual([10]);
  });

  it('is not offered when it is stuck', () => {
    expect(offered([issue(40, 'urgent', '', [...URGENT, 'ralph-blocked']), issue(10, 'free', '')])).toEqual([10]);
  });

  it('is not offered when it has an open blocker', () => {
    const raw = [issue(40, 'urgent', blockedBy(41), URGENT), issue(41, 'blocker', ''), issue(10, 'free', '')];
    const tickets = buildTickets(
      raw,
      raw.map(() => []),
    );
    const frontier = classify(tickets, []);

    expect(takeOneCandidates(frontier).map((t) => t.number)).not.toContain(40);
    expect(frontier.blocked.map((t) => t.number)).toContain(40);
  });

  it('is not offered when the caller fenced it off', () => {
    expect(offered(threeGroups(), [40])).toEqual([20, 10]);
  });

  it('leads the staffing list --tree restates, tagged there too', () => {
    // The two human views must not name a different ticket as next: --tree
    // restates the list, and before this it restated `readyTasks`, which
    // carries none of the ordering keys.
    const tickets = withClosed99(threeGroups());
    const frontier = classify(tickets, []);
    const out = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])));

    expect(out).toContain('READY NOW — #40 URGENT #20 #10');
  });

  it('is still filtered out by a route that does not take it', () => {
    // Jav applies AFTER the ordering, so urgency must not survive it: the lane
    // decides what a loop is offered first, never that a loop is offered work
    // routed away from it. Asserted through `roleUnits`, the only path from the
    // frontier to a claim — calling `routeByDifficulty` here directly would
    // pass with the filter deleted from that path, which is the whole risk.
    //
    // #40 carries `jav-3`, so it is a TRIAGED urgent ticket: #233's exemption
    // rescues only one routing would strand, and this one some loop takes.
    const raw = [
      issue(40, 'the urgent one', '', [...URGENT, 'jav-3']),
      issue(10, 'mine', '', ['ready-for-agent', 'jav-2']),
    ];
    const { tickets, frontier } = frontierOf(raw);
    const offeredTo = (route: string[] | null): number[] =>
      roleUnits('coder', tickets, frontier, { route, javLabels: () => ['jav-2', 'jav-3'] }).flatMap((unit) =>
        unit.tickets.map((t) => t.number),
      );

    expect(offeredTo(null)).toEqual([40, 10]);
    expect(offeredTo(['jav-2'])).toEqual([10]);
    // The urgent ticket is first for a loop that does take it — the filter
    // removes it, it never demotes it.
    expect(offeredTo(['jav-2', 'jav-3'])).toEqual([40, 10]);
  });

  it('preempts nothing in a staffing group that is already occupied', () => {
    // The one-per-group rule is what the lane must not buy its way past: #11
    // holds the tree, so the urgent sibling waits for it like any other.
    const raw = [
      issue(10, 'urgent slice', '## Parent\n\n#1\n', URGENT),
      issue(11, 'in flight', '## Parent\n\n#1\n', ['ready-for-agent', 'ralph-wip']),
      issue(20, 'another tree', '## Parent\n\n#2\n'),
    ];
    const { frontier } = frontierOf(raw);

    expect(takeOneCandidates(frontier).map((t) => t.number)).toEqual([20]);
    expect(frontier.occupiedByTicket.get(10)?.number).toBe(11);
  });

  it('marks the urgent ticket in the JSON report, and only it', () => {
    const tickets = withClosed99(threeGroups());
    const report = frontierReport(tickets, classify(tickets, []), []);
    const ready = report.ready.flatMap((group) => group.tickets);

    expect(ready[0]).toEqual({ number: 40, title: 'the urgent one', frees: 0, urgent: true, stuck: null });
    expect(ready.filter((t) => t.urgent === true).map((t) => t.number)).toEqual([40]);
  });

  it('leaves the report’s ready tickets without an urgent key when nothing is urgent', () => {
    // `toEqual` fails on a present-but-false key, which is the assertion: the
    // dashboard's document is unchanged for a project that never files one.
    const tickets = withClosed99(threeGroups(['ready-for-agent']));
    const report = frontierReport(tickets, classify(tickets, []), []);

    for (const ticket of report.ready.flatMap((group) => group.tickets)) {
      expect(Object.keys(ticket).sort()).toEqual(['frees', 'number', 'stuck', 'title']);
    }
  });

  it('carries urgency through the hand-over into the take-one JSON', async () => {
    const raw = [issue(40, 'the urgent one', '', URGENT), issue(10, 'free', '')];
    const { frontier } = frontierOf(raw);
    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), fakeHub().io);

    expect(outcome.ticket).toMatchObject({ number: 40, urgent: true });
    expect(JSON.parse(renderTakeOne(outcome, { dryRun: false })) as Record<string, unknown>).toMatchObject({
      ticket: 40,
      urgent: true,
    });
  });

  it('omits urgent from the take-one JSON for an ordinary ticket', () => {
    const out = JSON.parse(
      renderTakeOne(
        {
          ticket: { number: 10, title: 'free', tree: 10 },
          tickets: [{ number: 10, title: 'free', tree: 10 }],
          bucket: 'ready',
          claimed: true,
          obstructed: [],
        },
        { dryRun: false },
      ),
    ) as Record<string, unknown>;

    expect(out).not.toHaveProperty('urgent');
  });
});

describe('takeOne', () => {
  it('hands back the first free candidate and claims exactly it', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(outcome.ticket?.number).toBe(20);
    expect(outcome.claimed).toBe(true);
    expect(outcome.obstructed).toEqual([]);
    expect(hub.writes).toEqual([20]);
  });

  it('offers the next tree when the live re-read shows the first was taken', async () => {
    const { frontier } = frontierOf(twoTrees());
    // The snapshot said #20 was free; between the read and the write it was not.
    const hub = fakeHub({ 20: { labels: ['ralph-wip'] } });

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(outcome.ticket?.number).toBe(10);
    expect(hub.writes).toEqual([10]);
    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'labeled ralph-wip' }]);
  });

  it('walks past a ticket a PR opened inside the snapshot window, naming the PR', async () => {
    // The census fences PR-held tickets out of the candidate list, so this is
    // the other window: a PR opened between the census and the write. The
    // reason has to name the PR, because a supervisor polling this mode reads
    // "held by a PR" and "nothing ready" as different answers.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub({ 20: { prs: [742] } }, [742]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(outcome.ticket?.number).toBe(10);
    expect(hub.writes).toEqual([10]);
    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'open PR #742' }]);
  });

  it('fails the walk on a throttled re-read instead of recording every candidate as held', async () => {
    // Recorded as an obstruction, a throttle would read "every frontier
    // candidate is held" — a definite answer — for what is a GitHub wait.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();
    const reads: number[] = [];
    const io = {
      ...hub.io,
      readLive: async (n: number): Promise<LiveIssue> => {
        reads.push(n);
        throw new RateLimitedError('secondary', 30, 'gh: You have exceeded a secondary rate limit (HTTP 403)');
      },
    };

    await expect(takeOne(readyUnits(takeOneCandidates(frontier)), io)).rejects.toBeInstanceOf(RateLimitedError);
    expect(reads).toEqual([20]);
    expect(hub.writes).toEqual([]);
  });

  it('claims a ticket whose linked PR the probe reports closed', async () => {
    // The mirror of the test above, and the regression that keeps the fence
    // from being "any PR": a closed-unmerged PR is nobody's claim, and the
    // linked-PR field cannot tell the two apart on its own.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub({ 20: { prs: [742] } }, []);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(outcome.ticket?.number).toBe(20);
    expect(hub.writes).toEqual([20]);
    expect(outcome.obstructed).toEqual([]);
  });

  it('returns an empty result rather than throwing when every candidate is obstructed', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub({ 20: { labels: ['ralph-wip'] }, 10: { assignees: ['felipearosr'] } });

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(outcome.ticket).toBeNull();
    expect(hub.writes).toEqual([]);
    expect(outcome.obstructed.map((o) => o.number)).toEqual([20, 10]);
  });

  it('returns an empty result on an empty frontier without reading anything', async () => {
    const hub = fakeHub();
    const outcome = await takeOne([], hub.io);

    expect(outcome.ticket).toBeNull();
    expect(outcome.obstructed).toEqual([]);
    expect(hub.reads).toEqual([]);
  });

  it('moves to the next tree when a claim fails rather than losing the frontier', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();
    const io = {
      readLive: hub.io.readLive,
      claim: async (n: number): Promise<void> => {
        if (n === 20) throw new Error('HTTP 500');
        await hub.io.claim(n);
      },
    };

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), io);

    expect(outcome.ticket?.number).toBe(10);
    expect(outcome.obstructed[0]?.number).toBe(20);
    expect(outcome.obstructed[0]?.reason).toContain('HTTP 500');
  });

  it('stops at the first claim: later candidates are never even read', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();

    await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(hub.reads).toEqual([20]);
  });

  it('writes nothing on a dry run, and says so, while still naming the ticket', async () => {
    // The supervisor polls this constantly. It must learn which ticket it
    // would get without taking it, and `claimed` is what stops it believing
    // the poll was the claim.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io, { dryRun: true });

    expect(outcome.ticket?.number).toBe(20);
    expect(outcome.claimed).toBe(false);
    expect(hub.writes).toEqual([]);
  });

  it('still re-reads live state on a dry run, so a poll never names a held ticket', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub({ 20: { labels: ['ralph-wip'] } });

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io, { dryRun: true });

    expect(outcome.ticket?.number).toBe(10);
    expect(outcome.obstructed.map((o) => o.number)).toEqual([20]);
    expect(hub.writes).toEqual([]);
  });

  it('reports an empty frontier as unclaimed rather than merely ticketless', async () => {
    const outcome = await takeOne([], fakeHub().io);
    expect(outcome.claimed).toBe(false);
  });

  it('claims with the loop label and never with an assignee', async () => {
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();

    await takeOne(readyUnits(takeOneCandidates(frontier)), hub.io);

    expect(hub.state.get(20)?.labels).toContain('ralph-wip');
    expect(hub.state.get(20)?.assignees).toEqual([]);
  });
});

/**
 * #328 — a dry run used to NAME a ticket a live lease held. The lease refusal
 * lived only inside `writeClaim`, which a dry run never reaches, so the gate
 * and the iteration disagreed: on 2026-10-17 loggd's triager spent about 40 of
 * its 50 iterations being handed #2427 and failing to claim it.
 *
 * Every test here drives `claimLeaseIo` against a store of its own.
 * `leasePathFromGit()` resolves to the git common directory that every loop
 * worktree on this host shares, so a "foreign lease" written there would fence
 * the live loops off that issue number.
 */
describe('takeOne against the lease store (#328)', () => {
  const T0 = Date.parse('2026-10-17T20:00:00Z');
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** This process's identity, as `leaseIdentity()` would report it. */
  const mine = { run: 'rafa-run-20261017T121817-123053', loop: 'rafa' };
  const at = (nowMs: number) => () => ({ nowMs });

  const storeWith = (
    leases: {
      issue: number;
      run: string;
      loop: string;
      pid: number | null;
      claim?: string;
      leaseMs?: number;
    }[],
  ): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ralph-dry-run-lease-'));
    dirs.push(dir);
    const store: LeaseStore = { version: 1, leases: {} };
    for (const lease of leases) {
      claimLease(store, {
        issue: lease.issue,
        run: lease.run,
        loop: lease.loop,
        pid: lease.pid,
        worktree: dir,
        branch: null,
        claim: lease.claim ?? `${lease.loop}-wip`,
        nowMs: T0,
        leaseMs: lease.leaseMs,
      });
    }
    const path = join(dir, 'ralph-claim-leases.json');
    writeLeaseStore(path, store);
    return path;
  };

  /** One candidate, because a dry run that obstructs one moves on to the next. */
  const oneCandidate = () => frontierOf([issue(20, 'the only slice', '## Parent\n\n#2\n')]);

  const withLease = (
    hub: ReturnType<typeof fakeHub>,
    path: string,
    clock: () => { nowMs: number } = at(T0),
  ) => ({ ...hub.io, ...claimLeaseIo({ path, identity: mine, clock }) });

  it('reports the identity the real claim writes, both fields', () => {
    // What this pins is the `run` fallback, which is the field with a shape to
    // get wrong: `RALPH_RUN_ID` is the supervisor's, and a hand run has none.
    // That both paths read the same `loop` is a property of there being one
    // function, not of this assertion.
    //
    // The loop is pinned to one the fixture roster names: otherwise it comes
    // from the checkout's `.ralph/loop-name`, and a worktree whose loop is not
    // on the loggd fixture's roster (`rita`) failed this test for nothing.
    const run = process.env.RALPH_RUN_ID;
    const loop = process.env.RALPH_LOOP_NAME;
    try {
      process.env.RALPH_LOOP_NAME = 'rafa';
      process.env.RALPH_RUN_ID = 'rafa-run-9';
      expect(leaseIdentity()).toEqual({ run: 'rafa-run-9', loop: 'rafa' });
      delete process.env.RALPH_RUN_ID;
      expect(leaseIdentity()).toEqual({ run: `rafa-manual-${process.pid}`, loop: 'rafa' });
    } finally {
      if (run === undefined) delete process.env.RALPH_RUN_ID;
      else process.env.RALPH_RUN_ID = run;
      if (loop === undefined) delete process.env.RALPH_LOOP_NAME;
      else process.env.RALPH_LOOP_NAME = loop;
    }
  });

  it('obstructs a candidate another loop holds an active lease on, in the words the real claim uses', async () => {
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: process.pid }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path), { dryRun: true });

    expect(outcome.ticket).toBeNull();
    // `writeClaim`'s own wording (`next-tasks.ts`): the gate reads this text.
    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'lease active for issue #20' }]);
    expect(hub.writes).toEqual([]);
  });

  it('obstructs on a reconnecting lease too, not only an active one', async () => {
    // `leaseBlocksClaim` lets only `expired` through, so a dry run that keyed on
    // `active` would still disagree with the claim in three cases out of four.
    // `reconnecting` is the one of those three that does not depend on the host:
    // a null pid with a fresh heartbeat.
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: null }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path), { dryRun: true });

    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'lease reconnecting for issue #20' }]);
  });

  it('never lets an expired lease reclaim a ticket the live read calls closed (#655)', async () => {
    // A dead loop's leftover claim on a ticket that has since closed: the
    // expired lease releases the claim, it must not release the close.
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: null, leaseMs: 1_000 }]);
    const open = fakeHub({ 20: { labels: ['ralph-wip'] } });
    const reclaimed = await takeOne(
      readyUnits(takeOneCandidates(oneCandidate().frontier)),
      withLease(open, path, at(T0 + 60_000)),
      { dryRun: true },
    );
    expect(reclaimed.ticket?.number).toBe(20);

    const closed = fakeHub({ 20: { labels: ['ralph-wip'] } });
    const io = withLease(closed, path, at(T0 + 60_000));
    const readLive = io.readLive;
    io.readLive = async (n: number): Promise<LiveIssue> => ({ ...(await readLive(n)), state: 'closed', status: 'Mergeado' });
    const refused = await takeOne(readyUnits(takeOneCandidates(oneCandidate().frontier)), io, { dryRun: true });
    expect(refused.ticket).toBeNull();
    expect(refused.obstructed).toEqual([{ number: 20, reason: 'closed (Mergeado)' }]);
  });

  it('still offers a candidate whose foreign lease has expired, with no claim label on the issue', async () => {
    // The leaked-lease case this ticket came from: the real claim takes it
    // (`claimLease` refuses only on `leaseBlocksClaim`), and routing the check
    // through `canReclaimExpired` would obstruct it, since that helper also
    // wants the lease's label on the issue.
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: null, leaseMs: 1_000 }]);

    const outcome = await takeOne(
      readyUnits(takeOneCandidates(frontier)),
      withLease(hub, path, at(T0 + 60_000)),
      { dryRun: true },
    );

    expect(outcome.ticket?.number).toBe(20);
    expect(outcome.obstructed).toEqual([]);
  });

  it('never obstructs on this loop\'s own lease, and matches on run AND loop to say so', async () => {
    const hub = fakeHub();
    const ownPath = storeWith([{ issue: 20, run: mine.run, loop: mine.loop, pid: process.pid }]);

    const own = await takeOne(
      readyUnits(takeOneCandidates(oneCandidate().frontier)),
      withLease(hub, ownPath),
      { dryRun: true },
    );

    expect(own.ticket?.number).toBe(20);
    expect(own.obstructed).toEqual([]);

    // Matching on `run` alone would pass the assertion above while fencing a
    // loop off its own ticket, so the run is kept and only the loop differs.
    const strangerPath = storeWith([{ issue: 20, run: mine.run, loop: 'ralph', pid: process.pid }]);
    const stranger = await takeOne(
      readyUnits(takeOneCandidates(oneCandidate().frontier)),
      withLease(hub, strangerPath),
      { dryRun: true },
    );

    expect(stranger.obstructed).toEqual([{ number: 20, reason: 'lease active for issue #20' }]);
  });

  it('falls back to offering the candidate when the store cannot be read', async () => {
    // `CLAUDE.md`: a malformed signal falls back to existing behaviour, never to
    // a stuck loop. A deliberate divergence from the real claim, which throws.
    const dir = mkdtempSync(join(tmpdir(), 'ralph-dry-run-lease-bad-'));
    dirs.push(dir);
    const unreadable = {
      absent: join(dir, 'missing.json'),
      invalid: join(dir, 'invalid.json'),
      unsupported: join(dir, 'unsupported.json'),
    };
    writeFileSync(unreadable.invalid, '{ not json');
    writeFileSync(unreadable.unsupported, JSON.stringify({ version: 2, leases: {} }));

    // `absent` is in the list as a case, not as a mutant of the fallback:
    // `readLeaseStore` answers ENOENT with an empty store, so it never reaches
    // the catch. The other two do.
    for (const path of Object.values(unreadable)) {
      const hub = fakeHub();
      const outcome = await takeOne(
        readyUnits(takeOneCandidates(oneCandidate().frontier)),
        withLease(hub, path),
        { dryRun: true },
      );

      expect(outcome.ticket?.number).toBe(20);
      expect(outcome.obstructed).toEqual([]);
    }
  });

  it('reads the store without writing it, without the claim lock, and without touching the claim seams', async () => {
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: process.pid }]);
    const before = readFileSync(path, 'utf8');
    // Held, `withLeaseStoreLock` returns `undefined` and the answer would
    // become "nothing is held", so the obstruction below is the proof that it
    // is not in the read's path. `withClaimLock` polls the same NAME in the git
    // common dir rather than here, so what this catches there is its minute of
    // polling and its throw, not a silent pass. Asserting the file is absent
    // afterwards would prove nothing: both helpers delete it on exit.
    const lock = join(dirname(path), 'next-tasks-claim.lock');
    writeFileSync(lock, String(process.pid));

    const released: number[] = [];
    const seams = claimLeaseIo({ path, identity: mine, clock: at(T0) });
    const outcome = await takeOne(
      readyUnits(takeOneCandidates(frontier)),
      {
        ...hub.io,
        ...seams,
        releaseExpired: async (n: number): Promise<void> => {
          released.push(n);
          await seams.releaseExpired(n);
        },
      },
      { dryRun: true },
    );

    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'lease active for issue #20' }]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(lock)).toBe(true);
    expect(hub.writes).toEqual([]);
    expect(released).toEqual([]);
  });

  it('obstructs a real claim before it writes, in the words writeClaim would have thrown', async () => {
    // The check runs in both modes, so in the real one it refuses a candidate
    // `writeClaim` would have refused a line later — `io.claim` is never
    // reached, which is what `writes` being empty says. The wording is one
    // exported formatter shared with `writeClaim` (`leaseHeldReason`), which is
    // why this reads the same text the dry run reports.
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: process.pid }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path));

    expect(outcome.claimed).toBe(false);
    expect(outcome.obstructed).toEqual([{ number: 20, reason: leaseHeldReason('active', 20) }]);
    expect(hub.writes).toEqual([]);
  });

  it('claims this loop\'s own ticket in the real mode too, so a resuming loop is never fenced out', async () => {
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: mine.run, loop: mine.loop, pid: process.pid }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path));

    expect(outcome.claimed).toBe(true);
    expect(hub.writes).toEqual([20]);
  });

  it('obstructs on a lease this loop\'s PREVIOUS run still holds', async () => {
    // The realistic #328 shape: a supervisor died, its heartbeat outlived the
    // label, and the restarted loop reads the store under the same loop name.
    // Keyed on `loop` alone, the own-lease check would hand the ticket over.
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'rafa-run-older', loop: mine.loop, pid: process.pid }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path), { dryRun: true });

    expect(outcome.obstructed).toEqual([{ number: 20, reason: leaseHeldReason('active', 20) }]);
    expect(hub.writes).toEqual([]);
  });

  it('keeps the label\'s own wording when a candidate carries both a label and a lease', async () => {
    // The lease check is the LAST word, not the first: a reason a human can act
    // on ("labeled ralph-wip") beats one about the loops' own bookkeeping.
    const { frontier } = oneCandidate();
    const hub = fakeHub({ 20: { labels: ['ralph-wip'] } });
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: process.pid }]);

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontier)), withLease(hub, path), { dryRun: true });

    expect(outcome.obstructed).toEqual([{ number: 20, reason: 'labeled ralph-wip' }]);
  });

  it('leaves a label-obstructed candidate exactly as it is today when the store will not parse', async () => {
    // The fallback is for the new check only. `isExpired` still lets the parse
    // error through, as the inline literal it replaced did, so the reclaim
    // branch behaves as it does on `main`.
    const dir = mkdtempSync(join(tmpdir(), 'ralph-dry-run-lease-labelled-'));
    dirs.push(dir);
    const path = join(dir, 'invalid.json');
    writeFileSync(path, '{ not json');
    const hub = fakeHub({ 20: { labels: ['ralph-wip'] } });

    const outcome = await takeOne(
      readyUnits(takeOneCandidates(oneCandidate().frontier)),
      withLease(hub, path),
      { dryRun: true },
    );

    expect(outcome.obstructed[0]?.number).toBe(20);
    expect(outcome.obstructed[0]?.reason).toContain('invalid lease store');
  });

  it('makes the gate wait instead of spawning an iteration for a held ticket', async () => {
    // The gate's own chain, end to end: `takeOne` → `renderTakeOne` →
    // `frontierOutcome` → `decide`. Hand-building a `pick` would prove nothing —
    // `decide` only counts `obstructed`, so such a test passes on `main`.
    const { frontier } = oneCandidate();
    const hub = fakeHub();
    const path = storeWith([{ issue: 20, run: 'ralph-run-1', loop: 'ralph', pid: process.pid }]);
    const probe = (io: Parameters<typeof takeOne>[1]) =>
      takeOne(readyUnits(takeOneCandidates(frontier)), io, { dryRun: true });

    const held = await probe(withLease(hub, path));
    const { pick } = frontierOutcome(true, renderTakeOne(held, { dryRun: true, loop: 'rafa' }));
    const verdict = decide({ prs: [], pick, claims: [] }, 'rafa');

    expect(verdict.work).toBe(false);
    expect(verdict.why).toBe('every frontier candidate is held (#20)');

    // The same fixture with the lease check gone reports work, so the
    // assertions above are about the new seam and not about the fixture.
    const { leaseObstruction: _removed, ...noLeaseCheck } = withLease(hub, path);
    const offered = await probe(noLeaseCheck);
    const bare = frontierOutcome(true, renderTakeOne(offered, { dryRun: true, loop: 'rafa' }));
    expect(decide({ prs: [], pick: bare.pick, claims: [] }, 'rafa').work).toBe(true);
  });
});

describe('a second caller against the same frontier', () => {
  it('is refused the first caller\'s ticket and handed another tree', async () => {
    const raw = twoTrees();
    const hub = fakeHub();

    const first = await takeOne(readyUnits(takeOneCandidates(frontierOf(raw).frontier)), hub.io);

    // The second caller recomputes the frontier from live issue state, which
    // now carries the first caller's claim.
    const afterFirst = raw.map((i) =>
      i.number === first.ticket?.number
        ? { ...i, labels: [...i.labels, { name: 'ralph-wip' }] }
        : i,
    );
    const second = await takeOne(readyUnits(takeOneCandidates(frontierOf(afterFirst).frontier)), hub.io);

    expect(first.ticket?.number).toBe(20);
    expect(second.ticket?.number).not.toBe(first.ticket?.number);
    expect(second.ticket?.number).toBe(10);
    expect(hub.writes).toEqual([20, 10]);
  });

  it('is refused a ticket the OTHER loop claimed under its own label', async () => {
    // The realistic shape now: rafa took #20 and stamped `rafa-wip`. Ralph
    // recomputes the frontier and must read that as held, not as free.
    const raw = twoTrees().map((i) =>
      i.number === 20 ? { ...i, labels: [...i.labels, { name: 'rafa-wip' }] } : i,
    );
    const hub = fakeHub({ 20: { labels: ['rafa-wip'] } });

    const outcome = await takeOne(readyUnits(takeOneCandidates(frontierOf(raw).frontier)), hub.io);

    expect(outcome.ticket?.number).toBe(10);
    expect(hub.writes).toEqual([10]);
  });

  it('is never handed a sibling of the ticket the first caller still holds', async () => {
    // Tree A is the only tree, so once #10 is held there is nothing left to give.
    const raw = [
      issue(10, 'tree A slice', '## Parent\n\n#1\n'),
      issue(11, 'tree A sibling', '## Parent\n\n#1\n'),
    ];
    const hub = fakeHub();

    const first = await takeOne(readyUnits(takeOneCandidates(frontierOf(raw).frontier)), hub.io);
    const afterFirst = raw.map((i) =>
      i.number === first.ticket?.number
        ? { ...i, labels: [...i.labels, { name: 'ralph-wip' }] }
        : i,
    );
    const second = await takeOne(readyUnits(takeOneCandidates(frontierOf(afterFirst).frontier)), hub.io);

    expect(first.ticket?.number).toBe(10);
    expect(second.ticket).toBeNull();
    expect(hub.writes).toEqual([10]);
  });
});

/**
 * Concurrency is the case single-ticket mode exists for, and the one the tests
 * above cannot reach: each of them awaits the first caller before starting the
 * second, which is the sequential path. Two callers that OVERLAP are what two
 * Ralph loops actually are, and until the claim lock landed they both claimed
 * the same ticket and were both told they had won.
 */
const lock = (): string => join(tmpdir(), `next-tasks-test-${randomUUID()}.lock`);

describe('two callers that overlap', () => {

  it('both claim the same ticket when nothing serialises them — why the lock exists', async () => {
    // The hazard, pinned: `takeOne` alone does NOT arbitrate, because
    // re-reading before writing narrows the race without winning it (adding a
    // label that is already there succeeds). This is deliberately a
    // characterisation test, not a wish — it records the behaviour the lock is
    // compensating for.
    //
    // If it ever goes red, `takeOne` has become internally safe and this test
    // should be REWRITTEN rather than repaired: re-derive whether the lock is
    // still load-bearing, and delete it if it is not.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();

    const [a, b] = await Promise.all([
      takeOne(readyUnits(takeOneCandidates(frontier)), hub.io),
      takeOne(readyUnits(takeOneCandidates(frontier)), hub.io),
    ]);

    expect(a.ticket?.number).toBe(b.ticket?.number);
    expect(hub.writes).toEqual([20, 20]);
  });

  it('are handed different tickets when the walk runs under the claim lock', async () => {
    const path = lock();
    // Both callers compute their candidates from the SAME snapshot, before
    // either has claimed — which is what two supervisors polling one frontier
    // on one interval produce. The lock has to make that safe, not a
    // conveniently re-read frontier.
    const { frontier } = frontierOf(twoTrees());
    const hub = fakeHub();
    const candidates = readyUnits(takeOneCandidates(frontier));

    try {
      const [a, b] = await Promise.all([
        withClaimLock(path, () => takeOne(candidates, hub.io)),
        withClaimLock(path, () => takeOne(candidates, hub.io)),
      ]);

      expect(a.ticket?.number).not.toBe(b.ticket?.number);
      expect([a.ticket?.number, b.ticket?.number].sort()).toEqual([10, 20]);
      expect(hub.writes.sort()).toEqual([10, 20]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('leaves the loser with nothing when only one tree is on offer', async () => {
    const path = lock();
    const raw = [
      issue(10, 'tree A slice', '## Parent\n\n#1\n'),
      issue(11, 'tree A sibling', '## Parent\n\n#1\n'),
    ];
    const { frontier } = frontierOf(raw);
    const hub = fakeHub();
    const candidates = readyUnits(takeOneCandidates(frontier));

    try {
      const outcomes = await Promise.all([
        withClaimLock(path, () => takeOne(candidates, hub.io)),
        withClaimLock(path, () => takeOne(candidates, hub.io)),
      ]);

      expect(outcomes.filter((o) => o.ticket !== null)).toHaveLength(1);
      expect(hub.writes).toEqual([10]);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('claimLockPath', () => {
  it('names a lock inside a real git directory, by absolute path', async () => {
    // The whole fence rests on two callers resolving the SAME file, and a
    // linked worktree only does that if the path is the shared git directory
    // rather than its own. Asserted by what is in that directory — a git dir
    // has a HEAD — rather than by re-running the command under test, which
    // would pass just as well if both were wrong.
    const path = await claimLockPath();

    expect(basename(path)).toBe('next-tasks-claim.lock');
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(join(dirname(path), 'HEAD'))).toBe(true);
  });

  it('answers the same path from a linked worktree as from the primary', async () => {
    // The property the whole fence rests on: a second Ralph loop is a second
    // WORKTREE, and two callers only serialise if both resolve one file.
    //
    // A worktree is created rather than borrowed from whatever `git worktree
    // list` happens to show, so this asserts something on a single-worktree
    // clone too — a CI checkout is exactly where a silently-vacuous version of
    // this test would stop covering the thing it is named after.
    //
    // The trade: this briefly mutates the real repository's worktree list, and
    // a SIGKILL between add and remove leaves an entry needing `git worktree
    // prune`. Worth it to keep the assertion real everywhere it runs.
    const here = await claimLockPath();
    const linked = join(tmpdir(), `next-tasks-worktree-${randomUUID()}`);
    execFileSync('git', ['worktree', 'add', '--detach', '--no-checkout', linked, 'HEAD'], {
      stdio: 'ignore',
    });

    try {
      const there = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: linked },
      )
        .toString()
        .trim();

      expect(join(there, 'next-tasks-claim.lock')).toBe(here);
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', linked], { stdio: 'ignore' });
    }
  });
});

describe('withClaimLock', () => {

  it('releases the lock once the critical section finishes', async () => {
    const path = lock();
    await withClaimLock(path, async () => 'done');
    expect(existsSync(path)).toBe(false);
  });

  it('releases the lock when the critical section throws', async () => {
    const path = lock();
    await expect(withClaimLock(path, async () => {
      throw new Error('claim exploded');
    })).rejects.toThrow('claim exploded');
    // A caller that died mid-claim must not wedge every later loop behind a
    // lock nobody holds.
    expect(existsSync(path)).toBe(false);
  });

  it('breaks a lock left behind by a holder that died', async () => {
    const path = lock();
    writeFileSync(path, 'a supervisor that was killed');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);

    try {
      const held = await withClaimLock(path, async () => 'acquired', { staleMs: 60_000 });
      expect(held).toBe('acquired');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('refuses rather than proceeding unlocked when the holder never lets go', async () => {
    const path = lock();
    writeFileSync(path, 'a live holder');

    try {
      // Proceeding without the lock here would silently restore the double
      // claim, so timing out has to be an error the caller sees.
      await expect(
        withClaimLock(path, async () => 'should never run', {
          timeoutMs: 150,
          pollMs: 10,
          staleMs: 60_000,
        }),
      ).rejects.toThrow(/could not acquire the claim lock/);
      expect(readFileSync(path, 'utf8')).toBe('a live holder');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('breaks a lock at once when the holder process is gone', async () => {
    const path = lock();
    // Already exited by the time spawnSync returns, so this pid is dead.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(path, `${dead}:${randomUUID()}`);

    try {
      // No age wait: a dead holder is abandoned however fresh its lock looks,
      // which is what makes a killed supervisor recoverable in seconds.
      const held = await withClaimLock(path, async () => 'acquired', {
        timeoutMs: 500,
        pollMs: 10,
      });
      expect(held).toBe('acquired');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('never breaks the lock of a holder that is alive but slow', async () => {
    const path = lock();
    // Our own pid, so the holder is definitively alive — and a lock far older
    // than staleMs, which is what a walk whose gh calls ran long looks like.
    writeFileSync(path, `${process.pid}:${randomUUID()}`);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);

    try {
      // Age alone must not authorise a break. It cannot tell a dead holder
      // from a slow one, and breaking a live walk silently restores the double
      // claim underneath a fence still reporting success.
      await expect(
        withClaimLock(path, async () => 'should never run', {
          timeoutMs: 150,
          pollMs: 10,
          staleMs: 60_000,
        }),
      ).rejects.toThrow(/could not acquire the claim lock/);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it('never removes a lock that replaced its own', async () => {
    const path = lock();

    try {
      await withClaimLock(path, async () => {
        // Whoever broke ours as stale now holds the fence. Deleting it on the
        // way out would put two callers inside the critical section at once,
        // which is the failure the lock exists to prevent.
        writeFileSync(path, 'a later caller that broke ours as stale');
      });

      expect(readFileSync(path, 'utf8')).toBe('a later caller that broke ours as stale');
    } finally {
      rmSync(path, { force: true });
    }
  });
});

/**
 * The single-ticket mode's surface: what a caller may ask for, and what it
 * gets back. A Ralph supervisor consumes this output in a shell loop, so the
 * failure mode is not an ugly line — it is a line that reads as a ticket
 * number when the frontier was empty, or that carries a colour escape into
 * whatever parses it.
 */
describe('parseFlags', () => {
  it('defaults to the human frontier that writes assignee claims', () => {
    expect(parseFlags([])).toEqual({ dryRun: false, tree: false, takeOne: false, json: false, excluded: [], role: 'coder' });
  });

  it('reads each mode', () => {
    expect(parseFlags(['--dry-run']).dryRun).toBe(true);
    expect(parseFlags(['--tree']).tree).toBe(true);
    expect(parseFlags(['--take-one']).takeOne).toBe(true);
  });

  it('lets a supervisor poll the single-ticket mode without writing', () => {
    expect(parseFlags(['--take-one', '--dry-run'])).toEqual({
      dryRun: true,
      tree: false,
      takeOne: true,
      json: false,
      excluded: [],
      role: 'coder',
    });
  });

  it('accepts repeated ticket exclusions for a supervisor scope fence', () => {
    expect(parseFlags(['--take-one', '--exclude', '228', '--exclude', '428'])).toMatchObject({
      takeOne: true,
      excluded: [228, 428],
    });
  });

  it('rejects a missing or invalid exclusion number before it can claim work', () => {
    expect(() => parseFlags(['--take-one', '--exclude'])).toThrow(/--exclude/);
    expect(() => parseFlags(['--take-one', '--exclude', 'not-a-ticket'])).toThrow(
      /not-a-ticket/,
    );
  });

  it('refuses an unknown flag rather than falling through to the writing path', () => {
    expect(() => parseFlags(['--takeone'])).toThrow(/--takeone/);
    expect(() => parseFlags(['--nope', '--also-nope'])).toThrow(/--nope --also-nope/);
  });

  it('reads the JSON frontier only as a dry run, and never beside another mode', () => {
    // A program drawing the backlog must not be able to assign it, so the
    // flag cannot reach the writing path or borrow another mode's output.
    expect(parseFlags(['--dry-run', '--json']).json).toBe(true);
    expect(() => parseFlags(['--json'])).toThrow(/--dry-run/);
    expect(() => parseFlags(['--dry-run', '--json', '--take-one'])).toThrow(/--json/);
    expect(() => parseFlags(['--dry-run', '--json', '--tree'])).toThrow(/--json/);
  });

  it('defaults the intake to a coder, and takes a role only as an exact spelling', () => {
    expect(parseFlags(['--take-one']).role).toBe('coder');
    expect(parseFlags(['--take-one', '--role', 'coder']).role).toBe('coder');
    expect(parseFlags(['--take-one', '--role', 'triager']).role).toBe('triager');
    expect(parseFlags(['--take-one', '--role', 'ci-doctor']).role).toBe('ci-doctor');
    // Defaulting an unrecognised role would hand it the coder's candidates and
    // claim work it never asked for.
    expect(() => parseFlags(['--take-one', '--role', 'reviewer'])).toThrow(/--role requires one of/);
    expect(() => parseFlags(['--take-one', '--role'])).toThrow(/received nothing/);
  });

  it('confines the role to single-ticket mode: the reports picture the whole backlog', () => {
    expect(() => parseFlags(['--dry-run', '--role', 'triager'])).toThrow(/--role is only valid with --take-one/);
    expect(() => parseFlags(['--tree', '--role', 'triager'])).toThrow(/--take-one/);
    // `--role coder` is the default, so it narrows nothing and is not an error.
    expect(parseFlags(['--dry-run', '--role', 'coder']).role).toBe('coder');
  });

  it('refuses the tree view combined with the single-ticket mode', () => {
    // The tree is a drawing for a human; single-ticket mode is consumed by a
    // program. Silently picking one would give a caller the other's output.
    expect(() => parseFlags(['--take-one', '--tree'])).toThrow();
  });
});

describe('loopReadOnly', () => {
  const loop = { RALPH_RUN_ID: 'rafa-run-x' };

  it('turns a bare or --tree run inside a loop into a dry run, and says so', () => {
    for (const argv of [[], ['--tree']]) {
      const { flags, notice } = loopReadOnly(parseFlags(argv), loop);
      expect(flags).toEqual({ ...parseFlags(argv), dryRun: true });
      expect(notice).toContain('RALPH_RUN_ID=rafa-run-x');
      expect(notice).toContain('--take-one');
    }
  });

  it('leaves --take-one and --dry-run untouched inside a loop', () => {
    for (const argv of [['--take-one'], ['--take-one', '--dry-run'], ['--dry-run']]) {
      expect(loopReadOnly(parseFlags(argv), loop)).toEqual({ flags: parseFlags(argv), notice: null });
    }
  });

  it('changes nothing outside a loop, including a blank RALPH_RUN_ID', () => {
    for (const env of [{}, { RALPH_RUN_ID: '  ' }]) {
      const { flags, notice } = loopReadOnly(parseFlags([]), env);
      expect(flags.dryRun).toBe(false);
      expect(notice).toBeNull();
    }
  });

  it('does not take RALPH_LOOP_NAME alone for a loop', () => {
    const { flags, notice } = loopReadOnly(parseFlags([]), { RALPH_LOOP_NAME: 'rafa' });
    expect(flags.dryRun).toBe(false);
    expect(notice).toBeNull();
  });
});

describe('renderTakeOne', () => {
  const outcome = (
    ticket: TakeOneOutcome['ticket'],
    claimed = ticket !== null,
    obstructed: TakeOneOutcome['obstructed'] = [],
  ) =>
    ({
      ticket,
      tickets: ticket === null ? [] : [ticket],
      bucket: ticket === null ? null : 'ready',
      claimed,
      obstructed,
    }) satisfies TakeOneOutcome;

  const parse = (s: string): Record<string, unknown> => JSON.parse(s) as Record<string, unknown>;

  it('hands the caller a ticket number, not a rendered frontier', () => {
    const out = renderTakeOne(outcome({ number: 20, title: 'tree B slice', tree: 2 }), {
      dryRun: false,
    });
    expect(parse(out)).toMatchObject({
      ticket: 20,
      title: 'tree B slice',
      tree: 2,
      claimed: true,
      dryRun: false,
    });
  });

  it('is one line of machine-readable output with no colour escapes', () => {
    const out = renderTakeOne(outcome({ number: 20, title: 'tree B slice', tree: 2 }), {
      dryRun: false,
    });
    expect(out.includes('\n')).toBe(false);
    expect(out).toBe(stripAnsi(out));
  });

  it('reports an empty frontier as an empty result, not an error', () => {
    // This is the supervisor's gate condition and will be hit constantly.
    const out = renderTakeOne(outcome(null), { dryRun: false });
    expect(parse(out)).toMatchObject({ ticket: null, claimed: false });
  });

  it('says a dry run claimed nothing even though it names the ticket', () => {
    // Reported, never re-derived: the walk knows whether it wrote, and a
    // second place deciding what `claimed` means is a second place to get it
    // wrong.
    const out = renderTakeOne(outcome({ number: 20, title: 'tree B slice', tree: 2 }, false), {
      dryRun: true,
    });
    expect(parse(out)).toMatchObject({ ticket: 20, claimed: false, dryRun: true });
  });

  it('separates a failure from an empty frontier, which reads identically otherwise', () => {
    // ralph/prompt.md §1 branches on this JSON, not on the exit status, and
    // reads "empty with no obstructions" as the frontier having truly offered
    // nothing — which ends the loop with ALL_BLOCKED. A caller that could not
    // even ask must not produce that shape: §1's own rule is "never misreport
    // an API failure as ALL_BLOCKED".
    const failed = parse(renderTakeOne(outcome(null), { dryRun: false, error: 'lock timeout' }));
    const empty = parse(renderTakeOne(outcome(null), { dryRun: false }));

    expect(failed.error).toBe('lock timeout');
    expect(empty.error).toBeNull();
    // Identical but for `error` — which is exactly why it has to be there.
    expect({ ...failed, error: null }).toEqual(empty);
    expect(failed.rateLimited).toBe(false);
  });

  it('marks a throttled read as rateLimited, which §1 ends RETRY_LATER on', () => {
    const throttled = parse(
      renderTakeOne(outcome(null), { dryRun: true, error: 'GitHub rate limit', rateLimit: { retryAfterSeconds: 90 } }),
    );
    expect(throttled).toMatchObject({ ticket: null, error: 'GitHub rate limit', rateLimited: true, retryAfterSeconds: 90 });
  });

  it('carries the refusals through so a caller can see why it got what it got', () => {
    const out = renderTakeOne(
      outcome({ number: 10, title: 'tree A slice', tree: 1 }, true, [
        { number: 20, reason: 'labeled ralph-wip' },
      ]),
      { dryRun: false },
    );
    expect(parse(out).obstructed).toEqual([{ number: 20, reason: 'labeled ralph-wip' }]);
  });
});

/**
 * The tree view exists to answer "then why is there nothing to do?", so its
 * failure mode is not an ugly diagram — it is a diagram that misplaces a
 * ticket and makes a stall look like someone else's problem. These pin the
 * placement rules.
 */
describe('tree', () => {
  const parentedBy = (spec: number, blockers: number[] = []): string =>
    `## Parent\n\n- #${spec}\n\n## What to build\n\nStuff.\n` +
    (blockers.length > 0
      ? `\n## Blocked by\n\n${blockers.map((b) => `- #${b}`).join('\n')}\n`
      : '');

  const done = (number: number, title: string, spec: number): ClosedIssue => ({
    number,
    title,
    body: `## Parent\n\n- #${spec}\n`,
  });

  const treeFor = (
    raw: RawIssue[],
    closed: ClosedIssue[] = [],
    openPrs: OpenPullRequest[] = [],
  ): TreeGroup[] => {
    const tickets = buildTickets(raw, raw.map(() => []), new Set(), openPrs);
    // The census a closed child contributes is what makes its parent a spec,
    // so it has to be fed in the same way production does.
    const frontier = classify(
      tickets,
      closed
        .map((c) => parseParent(c.body))
        .filter((n): n is number => n !== null),
    );
    return buildTree(tickets, frontier, closed);
  };

  const find = (nodes: TreeNode[], number: number): TreeNode | null => {
    for (const node of nodes) {
      if (node.number === number) return node;
      const hit = find(node.children, number);
      if (hit) return hit;
    }
    return null;
  };

  describe('primaryBlocker', () => {
    it('nests under the lowest-numbered blocker inside the same spec', () => {
      // The batch order an author wrote (2/5 before 3/5) is the order a reader
      // expects the chain to hang in.
      const ticket = { openBlockers: [7, 5, 9] } as Ticket;
      expect(primaryBlocker(ticket, new Set([5, 7, 9]))).toEqual({
        parent: 5,
        others: [7, 9],
      });
    });

    it('never nests under a blocker in another spec', () => {
      // Nesting across groups would print the same ticket in two trees, and
      // the staffing rule reads the groups as disjoint.
      const ticket = { openBlockers: [4, 8] } as Ticket;
      expect(primaryBlocker(ticket, new Set([8]))).toEqual({ parent: 8, others: [4] });
    });

    it('reports every blocker inline when none is a sibling', () => {
      const ticket = { openBlockers: [4, 6] } as Ticket;
      expect(primaryBlocker(ticket, new Set())).toEqual({ parent: null, others: [4, 6] });
    });
  });

  describe('withoutCycles', () => {
    it('keeps an ordinary chain intact', () => {
      const chain = new Map([
        [3, 2],
        [2, 1],
      ]);
      expect([...withoutCycles(chain)]).toEqual([
        [3, 2],
        [2, 1],
      ]);
    });

    it('keeps the safe edges of a component that contains a cycle', () => {
      // Regression: every candidate was tested against the ORIGINAL map, so
      // `3 → 1` walked into the 1 ↔ 2 cycle and was discarded with it —
      // flattening a whole component to explain one bad pair.
      const safe = withoutCycles(
        new Map([
          [1, 2],
          [2, 1],
          [3, 1],
        ]),
      );
      expect(safe.get(3)).toBe(1);
    });

    it('drops the edge that would close a cycle', () => {
      // A blocking cycle is a bug in the tickets, but rendering it would hang
      // the view whose whole job is explaining a stall.
      const cyclic = new Map([
        [1, 2],
        [2, 1],
      ]);
      const safe = withoutCycles(cyclic);
      expect(safe.size).toBeLessThan(2);
    });

    it('drops a self-edge', () => {
      expect([...withoutCycles(new Map([[1, 1]]))]).toEqual([]);
    });
  });

  it('nests a blocked ticket under the sibling that blocks it', () => {
    const groups = treeFor([
      issue(10, 'spec', '', ['spec']),
      issue(11, 'first', parentedBy(10)),
      issue(12, 'second', parentedBy(10, [11])),
    ]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.roots.map((r) => r.number)).toEqual([11]);
    expect(group.roots[0]!.children.map((c) => c.number)).toEqual([12]);
  });

  it('shows the blockers its position cannot, and only those', () => {
    // A ticket gated by five things must not read as gated by one just because
    // it can only hang under one of them.
    const groups = treeFor([
      issue(10, 'spec', '', ['spec']),
      issue(11, 'a', parentedBy(10)),
      issue(12, 'b', parentedBy(10)),
      issue(13, 'c', parentedBy(10, [11, 12])),
    ]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(find(group.roots, 13)!.otherBlockers).toEqual([12]);
  });

  it('carries closed children in as done, at the top level', () => {
    // Burying a finished slice under the ticket it happened to block would
    // hide the progress this view exists to show.
    const groups = treeFor(
      [issue(10, 'spec', '', ['spec']), issue(11, 'open one', parentedBy(10))],
      [done(9, 'already merged', 10)],
    );
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.roots.map((r) => r.number)).toEqual([9, 11]);
    expect(find(group.roots, 9)!.state).toBe('done');
    expect(group.total).toBe(2);
  });

  it('marks a tree with no open members complete, and flags a spec left open', () => {
    // The #507 case: eleven children closed, the container still sitting in
    // the queue because nobody closed it.
    const groups = treeFor([issue(10, 'spec', '', ['spec'])], [done(9, 'merged', 10)]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.complete).toBe(true);
    expect(group.specStillOpen).toBe(true);
  });

  it('names a group whose spec has since closed', () => {
    // Without the closed lookup these rendered as anonymous blocks of ticks.
    const groups = treeFor(
      [],
      [done(9, 'merged', 10), { number: 10, title: 'the spec itself', body: '' }],
    );
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.spec!.title).toBe('the spec itself');
    expect(group.complete).toBe(true);
    // ...and it is not reported as still open, because it has closed.
    expect(group.specStillOpen).toBe(false);
  });

  it('keeps a spec named by its children but absent from both fetch windows', () => {
    // Nameless, but calling it standalone would contradict the tickets, which
    // plainly declare a parent.
    const groups = treeFor([issue(11, 'orphan', parentedBy(999))]);
    const group = groups.find((g) => g.spec?.number === 999)!;
    expect(group.spec!.title).toBeNull();
    expect(group.roots.map((r) => r.number)).toEqual([11]);
  });

  it('gives a ticket with no spec no header', () => {
    const groups = treeFor([issue(11, 'lonely', '## What to build\n\nStuff.\n')]);
    expect(groups[0]!.spec).toBeNull();
    expect(groups[0]!.roots.map((r) => r.number)).toEqual([11]);
  });

  it('calls a blocked ticket blocked even when its tree is taken', () => {
    // Blocked outranks occupied: a ticket with an open blocker is not
    // startable whatever else is true, and the flat sections say the same.
    const groups = treeFor([
      issue(10, 'spec', '', ['spec']),
      issue(11, 'held', parentedBy(10), ['ready-for-agent'], ['someone']),
      issue(12, 'waiting', parentedBy(10, [11])),
    ]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(find(group.roots, 11)!.state).toBe('in-flight');
    expect(find(group.roots, 12)!.state).toBe('blocked');
  });

  it('draws a spec that has no tickets written yet', () => {
    // Regression: the guard that keeps a spec out of its own group also kept a
    // childless spec from seeding one, so it printed nowhere at all — while
    // the flat view lists it under SPECS. Nothing may vanish.
    const groups = treeFor([issue(10, 'empty spec', '', ['spec', 'ready-for-agent'])]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.total).toBe(0);
    expect(group.roots).toEqual([]);
    // Unstarted, not finished: filing it under COMPLETE would report "0 done"
    // as progress, and flag a brand-new spec as one nobody closed.
    expect(group.complete).toBe(false);
    expect(group.specStillOpen).toBe(false);
  });

  it('keeps both specs when one spec is a child of another', () => {
    // Regression: a sub-spec was excluded from its parent's group as a spec,
    // which left the parent with nothing and dropped it from the output —
    // taking the nesting with it.
    const groups = treeFor([
      issue(10, 'outer spec', '', ['spec', 'ready-for-agent']),
      issue(11, 'inner spec', parentedBy(10), ['spec', 'ready-for-agent']),
      issue(12, 'real work', parentedBy(11)),
    ]);
    const outer = groups.find((g) => g.spec?.number === 10)!;
    const inner = groups.find((g) => g.spec?.number === 11)!;
    expect(inner.under).toBe(10);
    expect(inner.roots.map((r) => r.number)).toEqual([12]);
    // The sub-spec heads its own group rather than nesting, so the count is
    // how the relationship stays visible from the parent's side — and is what
    // stops the parent claiming nothing has been written under it.
    expect(outer.subSpecs).toEqual([11]);
  });

  it('does not draw a closed sub-spec as a finished leaf of its parent', () => {
    // Regression: closed issues never entered the spec set, so a closed
    // sub-spec printed twice — as the header of its own live group, and as a
    // tick inside its parent's.
    const groups = treeFor(
      [issue(12, 'real work', parentedBy(11))],
      [{ number: 11, title: 'inner spec', body: '## Parent\n\n- #10\n' }],
    );
    const parent = groups.find((g) => g.spec?.number === 10)!;
    expect(parent.roots.map((r) => r.number)).toEqual([]);
    // ...and it is still recorded as the sub-spec's parent: that link lives in
    // the closed issue's body, which is the only copy of it left.
    expect(parent.subSpecs).toEqual([11]);
    const inner = groups.find((g) => g.spec?.number === 11)!;
    expect(inner.roots.map((r) => r.number)).toEqual([12]);
  });

  it('gives a COMPLETE line a name even when the spec cannot be named', () => {
    const raw = [issue(11, 'child', parentedBy(999))];
    const tickets = buildTickets(raw, [[]]);
    const frontier = classify(tickets, [999]);
    const out = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])));
    expect(out).toContain('#999  (outside the fetched graph)');
  });

  it('keeps a spec live while a sub-spec below it still has work', () => {
    // Regression: the outer spec's own children had all closed, so it was
    // filed under COMPLETE as "spec still open" while work under its sub-spec
    // was ready — inviting the one action this view must never encourage.
    const groups = treeFor(
      [
        issue(10, 'outer spec', '', ['spec']),
        issue(11, 'inner spec', parentedBy(10), ['spec']),
        issue(12, 'live work', parentedBy(11)),
      ],
      [done(9, 'merged direct child', 10)],
    );
    const outer = groups.find((g) => g.spec?.number === 10)!;
    expect(outer.complete).toBe(false);
    expect(outer.specStillOpen).toBe(false);
  });

  it('completes a parent whose only work lives in finished sub-specs', () => {
    // Regression: the parent owned no tickets directly, so `done.length` was
    // zero and it could never complete — sitting in the live section for ever
    // with every ticket under it closed.
    const groups = treeFor(
      [issue(10, 'outer spec', '', ['spec']), issue(11, 'inner spec', parentedBy(10), ['spec'])],
      [done(12, 'the only work', 11)],
    );
    const outer = groups.find((g) => g.spec?.number === 10)!;
    expect(outer.complete).toBe(true);
    expect(outer.specStillOpen).toBe(true);
    // ...and `total` counts direct tickets only, so the COMPLETE row has to
    // describe the sub-specs rather than report "0 done".
    expect(outer.total).toBe(0);
    expect(outer.subSpecs).toEqual([11]);
  });

  it('keeps the blocker on a spec header that is itself blocked', () => {
    // "blocked" without the edge explains nothing, and the flat BLOCKED
    // section still names it.
    const groups = treeFor([
      issue(9, 'gate', ''),
      issue(10, 'blocked spec', '## Blocked by\n\n- #9\n', ['spec']),
      issue(11, 'child', parentedBy(10)),
    ]);
    expect(groups.find((g) => g.spec?.number === 10)!.spec!.blockers).toEqual([9]);
  });

  it('does not call a cyclic parent component finished while a branch is live', () => {
    // A `## Parent` cycle is a broken ticket graph, and letting one member
    // vouch for another would close a spec with live work beneath it.
    const groups = treeFor([
      issue(10, 'ten', parentedBy(11), ['spec']),
      issue(11, 'eleven', parentedBy(10), ['spec']),
      issue(12, 'twelve', parentedBy(10), ['spec']),
      issue(13, 'live work', parentedBy(12)),
    ]);
    for (const n of [10, 11, 12]) {
      expect(groups.find((g) => g.spec?.number === n)?.complete ?? false).toBe(false);
    }
  });

  it('does not count a stuck ticket as one that is unlabelled', () => {
    // A ralph-blocked ticket keeps ready-for-agent but derives `open`, so the
    // empty-frontier note said the opposite of the truth about it.
    const raw = [issue(11, 'wedged', '', ['ready-for-agent', 'ralph-blocked'])];
    const tickets = buildTickets(raw, [[]]);
    const frontier = classify(tickets, []);
    const out = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])));
    expect(out).not.toContain('1 open ticket not labelled');
    // Both real labels, never the docs placeholder: this line is read in a
    // terminal, where `[<loop>-blocked]` names a token that appears in none
    // of the rows below it.
    expect(out).toContain('1 ticket tagged ralph-blocked / rafa-blocked');
    expect(out).not.toContain('<loop>');
  });

  it('carries a spec\'s own claim onto its header', () => {
    // Regression: promoting a spec to a header dropped it from the forest, so
    // a spec that was itself claimed rendered as a bare caption while the flat
    // view listed it under IN FLIGHT — hiding why the frontier was empty.
    const groups = treeFor([
      issue(10, 'held spec', '', ['spec', 'ready-for-agent'], ['felipearosr']),
      issue(11, 'child', parentedBy(10)),
    ]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    expect(group.spec!.state).toBe('in-flight');
    expect(group.spec!.detail).toBe('felipearosr');
  });

  it('names the open PR as the holder when there is no label and no assignee', () => {
    // The tree draws the same three-way fallback the flat view does, and the
    // PR branch is the one a ticket lands in for the whole life of its PR —
    // so a tree that showed it as an idle dot would hide every open PR.
    const groups = treeFor(
      [issue(10, 'held by a PR', '', ['ready-for-agent'])],
      [],
      [{ number: 742, closingIssuesReferences: [{ number: 10 }] }],
    );
    const held = groups.flatMap((g) => g.roots).find((r) => r.number === 10)!;
    expect(held.state).toBe('in-flight');
    expect(held.detail).toBe('PR #742');
  });

  it('names the live loop branch as the holder when nothing else claims the ticket', () => {
    const tickets = buildTickets(
      [issue(10, 'held by a branch', '', ['ready-for-agent'])],
      [[]],
      new Set(),
      [],
      new Map([[10, branchClaim('rafa/10-held')]]),
    );
    const groups = buildTree(tickets, classify(tickets, []), []);
    const held = groups.flatMap((g) => g.roots).find((r) => r.number === 10)!;
    expect(held.state).toBe('in-flight');
    expect(held.detail).toBe('branch rafa/10-held');
  });

  it('recovers a closed sub-spec\'s own parent for its header', () => {
    const groups = treeFor(
      [issue(12, 'real work', parentedBy(11))],
      [{ number: 11, title: 'inner spec', body: '## Parent\n\n- #10\n' }],
    );
    expect(groups.find((g) => g.spec?.number === 11)!.under).toBe(10);
  });

  it('treats a childless spec as a spec even when it is not queued', () => {
    // `frontier.specs` is the READY spec bucket, so a spec that is assigned,
    // stuck, or off the queue never reached it and rendered as an ordinary
    // standalone ticket.
    const groups = treeFor([
      issue(10, 'claimed spec', '', ['spec'], ['felipearosr']),
    ]);
    expect(groups.find((g) => g.spec?.number === 10)).toBeDefined();
  });

  it('tags a stuck ticket instead of printing it as idle', () => {
    // `classify` drops ralph-blocked from the queue, so without the tag a
    // stuck ticket rendered as an ordinary dot — the reader asking "why is
    // there nothing to do" was shown no answer where one existed.
    const groups = treeFor([
      issue(10, 'spec', '', ['spec']),
      issue(11, 'wedged', parentedBy(10), ['ready-for-agent', 'ralph-blocked']),
    ]);
    const group = groups.find((g) => g.spec?.number === 10)!;
    // The label rather than a flag: the tree says WHICH loop wedged here.
    expect(find(group.roots, 11)!.stuck).toBe('ralph-blocked');
  });

  it('keeps the warnings the flat view ends on', () => {
    // Both are readiness decisions rather than decoration; dropping them would
    // have made --tree quietly the less truthful of the two views.
    const raw = [
      issue(10, 'spec', '', ['spec']),
      issue(11, 'gate', parentedBy(10), []),
      issue(12, 'waiting', parentedBy(10, [11])),
    ];
    const tickets = buildTickets(raw, [[], [], []]);
    const frontier = classify(tickets, []);
    const out = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])));
    expect(out).toContain('gates work but is not ready-for-agent');
    expect(out).toContain('prose-only edges');
  });

  it('renders the staffing list even though the buckets are gone', () => {
    // --tree replaces the flat sections, and READY NOW is the tool's promise.
    const raw = [issue(10, 'spec', '', ['spec']), issue(11, 'startable', parentedBy(10))];
    const tickets = buildTickets(raw, [[], []]);
    const frontier = classify(tickets, []);
    const out = stripAnsi(renderTree(tickets, frontier, buildTree(tickets, frontier, [])));
    expect(out).toContain('READY NOW — #11');
  });

  it('collapses a finished tree to one line instead of dropping it', () => {
    // Nothing may vanish, but eleven ticks per finished spec buried the live
    // work under a page of them.
    const raw = [issue(10, 'spec', '', ['spec'])];
    const tickets = buildTickets(raw, [[]]);
    const frontier = classify(tickets, [10]);
    const out = stripAnsi(
      renderTree(tickets, frontier, buildTree(tickets, frontier, [done(9, 'merged', 10)])),
    );
    expect(out).toContain('COMPLETE — 1 tree');
    expect(out).toContain('spec still open');
    expect(out).not.toContain('merged\n├─');
  });
});


describe('readFrontierInputs', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  /** One GraphQL page of open issues, as `gh api graphql --include` prints it. */
  function page(
    issues: { raw: RawIssue; blockers?: BlockerRef[]; totalCount?: number }[],
    next: string | null = null,
  ): string {
    const nodes = issues.map(({ raw, blockers = [], totalCount }) => ({
      number: raw.number,
      title: raw.title,
      body: raw.body,
      author: raw.author ?? null,
      labels: { nodes: raw.labels },
      assignees: { nodes: raw.assignees ?? [] },
      comments: { nodes: raw.comments ?? [] },
      blockedBy: {
        totalCount: totalCount ?? blockers.length,
        nodes: blockers.map((b) => ({ number: b.number, state: b.state.toUpperCase() })),
      },
    }));
    const body = { data: { repository: { issues: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } };
    return `HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4000\n\n${JSON.stringify(body)}`;
  }

  it('asks for the author and the tail of each thread in the same census call', async () => {
    // The triager's exclusions need both, and a second request per issue would
    // make its poll cost more than a coder's — which is the one thing #143 said
    // it must not.
    const commands: string[][] = [];
    const raw = [issue(1, 'a ticket', '', ['ready-for-agent'], [], { comments: [{ body: 'hello', createdAt: '2026-09-30T09:00:00Z' }] })];
    const inputs = await readFrontierInputs({
      gh: async (args) => {
        commands.push(args);
        if (args[0] === 'api') return page(raw.map((r) => ({ raw: r })));
        return '[]';
      },
      nativeBlockers: async () => [],
    });
    const query = commands.find((args) => args[0] === 'api')!.find((arg) => arg.startsWith('query='))!;
    expect(query).toContain('author { login }');
    expect(query).toContain('comments(last: 20) { nodes { body createdAt } }');
    expect(inputs.raw[0]).toMatchObject({
      author: { login: 'felipearosr' },
      comments: [{ body: 'hello', createdAt: '2026-09-30T09:00:00Z' }],
    });
  });

  it('reads open issues with their blockers page by page, overlapping the other censuses', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const closed = deferred<string>();
    const prs = deferred<string>();
    const commands: string[][] = [];
    const raw = Array.from({ length: 10 }, (_, n) => issue(n + 1, `ticket ${n + 1}`, n === 0 ? blockedBy(99) : ''));
    const expectedNatives: BlockerRef[][] = raw.map((_, n) =>
      n === 1 ? [{ number: 3, state: 'open' }] : n === 4 ? [{ number: 99, state: 'closed' }] : [],
    );
    const closedIssues: ClosedIssue[] = [{ number: 99, title: 'done', body: '' }];
    const openPrs: OpenPullRequest[] = [{ number: 100, closingIssuesReferences: [{ number: 4 }] }];
    const nativeCalls: number[] = [];
    const result = readFrontierInputs({
      gh: async (args) => {
        commands.push(args);
        if (args[0] === 'api') return (args.includes('after=cursor-1') ? second : first).promise;
        return (args[0] === 'pr' ? prs : closed).promise;
      },
      nativeBlockers: async (number) => {
        nativeCalls.push(number);
        return [];
      },
    });
    // All three censuses start at once; the open one is GraphQL, not `issue list`.
    expect(commands.map((args) => args.slice(0, 2))).toEqual([['api', 'graphql'], ['issue', 'list'], ['pr', 'list']]);
    expect(commands[0]).toContain('--include');
    first.resolve(page(raw.slice(0, 6).map((r, n) => ({ raw: r, blockers: expectedNatives[n] })), 'cursor-1'));
    for (let n = 0; n < 10; n++) await Promise.resolve();
    // The second page is asked for with the first page's cursor.
    expect(commands.filter((args) => args[0] === 'api')).toHaveLength(2);
    second.resolve(page(raw.slice(6).map((r, n) => ({ raw: r, blockers: expectedNatives[n + 6] }))));
    closed.resolve(JSON.stringify(closedIssues));
    prs.resolve(JSON.stringify(openPrs));
    const inputs = await result;
    expect(inputs).toEqual({ raw, closed: closedIssues, openPrs, natives: expectedNatives });
    // Four calls for ten tickets, and no per-ticket dependency read at all.
    expect(commands).toHaveLength(4);
    expect(nativeCalls).toEqual([]);
    const tickets = buildTickets(inputs.raw, inputs.natives, new Set(inputs.closed.map((i) => i.number)), inputs.openPrs);
    const frontier = classify(tickets, []);
    expect(frontier.readyTasks.map((ticket) => ticket.number)).toContain(1);
    expect(frontier.blocked.map((ticket) => ticket.number)).toContain(2);
    expect(frontier.inFlight.map((ticket) => ticket.number)).toContain(4);
  });

  it('reads only a ticket whose blockers overflow one page per ticket, two at a time', async () => {
    const raw = Array.from({ length: 6 }, (_, n) => issue(n + 1, `ticket ${n + 1}`, ''));
    const gates = raw.map(() => deferred<BlockerRef[]>());
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const result = readFrontierInputs({
      gh: async (args) =>
        args[0] === 'api'
          ? page(raw.map((r) => ({ raw: r, totalCount: r.number === 1 ? 0 : 101 })))
          : '[]',
      nativeBlockers: async (number) => {
        started.push(number);
        peak = Math.max(peak, ++inFlight);
        const blockers = await gates[number - 1]!.promise;
        inFlight--;
        return blockers;
      },
    });
    for (let n = 0; n < 20; n++) await Promise.resolve();
    // #1's list was complete; the five truncated ones go to REST, two at a time.
    expect(started).toEqual([2, 3]);
    gates.forEach((gate) => gate.resolve([{ number: 50, state: 'open' }]));
    const inputs = await result;
    expect(started).toEqual([2, 3, 4, 5, 6]);
    expect(peak).toBe(2);
    expect(inputs.natives[0]).toEqual([]);
    expect(inputs.natives[5]).toEqual([{ number: 50, state: 'open' }]);
  });

  it('propagates a census failure and handles later census rejections', async () => {
    const closed = deferred<string>();
    const prs = deferred<string>();
    const result = readFrontierInputs({
      gh: async (args) =>
        args[0] === 'pr' ? prs.promise : args[0] === 'issue' ? closed.promise : page([{ raw: issue(1, 'one', '') }]),
      nativeBlockers: async () => [],
    });
    const rejected = expect(result).rejects.toThrow('closed census failed');
    for (let n = 0; n < 10; n++) await Promise.resolve();
    closed.reject(new Error('closed census failed'));
    await rejected;
    prs.reject(new Error('PR census failed later'));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('asks for each PR body and maps its keyword references', async () => {
    const commands: string[][] = [];
    const inputs = await readFrontierInputs({
      gh: async (args) => {
        commands.push(args);
        if (args[0] === 'api') return page([]);
        if (args[0] === 'pr') {
          return JSON.stringify([
            { number: 375, closingIssuesReferences: [], body: 'Part of #373. See #9 and other/repo#5.' },
            { number: 376, closingIssuesReferences: [{ number: 12 }], body: 'Closes #12' },
          ]);
        }
        return '[]';
      },
      nativeBlockers: async () => [],
    });
    const prList = commands.find((args) => args[0] === 'pr')!;
    expect(prList[prList.indexOf('--json') + 1]!.split(',')).toContain('body');
    expect(inputs.openPrs).toEqual([
      { number: 375, closingIssuesReferences: [], references: [{ number: 373 }] },
      { number: 376, closingIssuesReferences: [{ number: 12 }] },
    ]);
  });

  it('passes a throttled read through as RateLimitedError', async () => {
    const result = readFrontierInputs({
      gh: async (args) => {
        if (args[0] === 'api') throw new RateLimitedError('secondary', 60, 'gh: API rate limit exceeded (HTTP 403)');
        return '[]';
      },
      nativeBlockers: async () => [],
    });
    await expect(result).rejects.toBeInstanceOf(RateLimitedError);
  });
});

/* -------------------------------------------------------------------------
 * The claim label an expired lease leaves behind, end to end.
 *
 * The lease records the label its claim went out under, and that record — not
 * the lease's loop — is the one thing that says which label is on the ticket.
 * The two differ for a claim made before `.loop-name` was consulted: a `rafa`
 * checkout claiming under `ralph-wip`. Both claim paths are driven through the
 * real script against a fake `gh`, so the label they edit is the one shipped.
 * ----------------------------------------------------------------------- */

describe('reclaiming an expired lease', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** The bun running this suite, by absolute path — the fixture replaces PATH. */
  const bun = process.env.RALPH_TEST_BUN ?? ((): string => {
    try {
      return execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();
    } catch {
      return process.execPath;
    }
  })();

  /**
   * `liveLabels`, when set, is what the live `issue view` re-read answers
   * instead of `labels` — a claim that landed after the census was taken.
   */
  interface Tracked { labels: string[]; assignees: string[]; body?: string; author?: string; liveLabels?: string[] }

  function fixture(issues: Record<number, Tracked>) {
    const root = mkdtempSync(join(tmpdir(), 'ralph-expired-claim-'));
    roots.push(root);
    writeProjectConfig(root);
    const common = join(root, 'gitcommon');
    const bin = join(root, 'bin');
    mkdirSync(common);
    mkdirSync(bin);

    const git = join(bin, 'git');
    writeFileSync(
      git,
      [
        '#!/bin/sh',
        `if [ "$2" = "--path-format=absolute" ]; then printf '%s\\n' ${JSON.stringify(common)}; exit 0; fi`,
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(git, 0o755);

    // A tracker kept in one JSON file: the censuses and the live re-read answer
    // from it, and every edit is applied to it and logged.
    const trackerPath = join(root, 'tracker.json');
    const editLog = join(root, 'gh.edits');
    writeFileSync(trackerPath, JSON.stringify(issues));
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      [
        `#!${bun}`,
        'const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");',
        'const args = process.argv.slice(2);',
        `const path = ${JSON.stringify(trackerPath)};`,
        'const all = JSON.parse(readFileSync(path, "utf8"));',
        'const shape = (n) => ({ labels: all[n].labels.map((name) => ({ name })), assignees: all[n].assignees.map((login) => ({ login })) });',
        'const bodyOf = (n) => all[n].body ?? "";',
        `appendFileSync(${JSON.stringify(join(root, 'gh.calls'))}, args.slice(0, 2).join(" ") + (args.includes("closed") ? " closed" : "") + "\\n");`,
        'const [noun, verb, n, flag, value] = args;',
        'if (noun === "issue" && verb === "list") {',
        '  const open = args.includes("open");',
        '  console.log(JSON.stringify(open ? Object.keys(all).map((k) => ({ number: Number(k), title: `ticket ${k}`, body: bodyOf(k), ...shape(k) })) : []));',
        '} else if (noun === "pr" && verb === "list") {',
        '  console.log("[]");',
        '} else if (noun === "api" && process.env.FAKE_GH_THROTTLE) {',
        '  // GitHub\'s answer on 2026-09-28: a 403 worded like the primary limit, with quota left.',
        '  console.log("HTTP/2.0 403 Forbidden\\nX-Ratelimit-Remaining: 4999\\n\\n{\\"message\\":\\"API rate limit exceeded for user ID 1.\\"}");',
        '  console.error("gh: API rate limit exceeded for user ID 1. (HTTP 403)");',
        '  process.exit(1);',
        '} else if (noun === "api" && verb === "graphql") {',
        '  const nodes = Object.keys(all).map((k) => ({ number: Number(k), title: `ticket ${k}`, body: bodyOf(k),',
        '    author: { login: all[k].author ?? "felipearosr" },',
        '    labels: { nodes: shape(k).labels }, assignees: { nodes: shape(k).assignees },',
        '    comments: { nodes: [] }, blockedBy: { totalCount: 0, nodes: [] } }));',
        '  console.log("HTTP/2.0 200 OK\\nX-Ratelimit-Remaining: 4999\\n\\n" + JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }));',
        '} else if (noun === "api") {',
        '  console.log("[]");',
        '} else if (noun === "issue" && verb === "view") {',
        '  // Real gh answers every --json field asked for; the live read asks for state.',
        '  const live = all[n].liveLabels ? { labels: all[n].liveLabels.map((name) => ({ name })) } : {};',
        '  console.log(JSON.stringify({ ...shape(n), ...live, closedByPullRequestsReferences: [], state: all[n].state ?? "OPEN" }));',
        '} else if (noun === "issue" && verb === "edit") {',
        `  appendFileSync(${JSON.stringify(editLog)}, args.slice(2).join(" ") + "\\n");`,
        '  if (flag === "--remove-label") all[n].labels = all[n].labels.filter((name) => name !== value);',
        '  if (flag === "--add-label") all[n].labels.push(value);',
        '  if (flag === "--add-assignee") all[n].assignees.push(value);',
        '  writeFileSync(path, JSON.stringify(all));',
        '} else {',
        '  console.error("unexpected gh " + args.join(" "));',
        '  process.exit(2);',
        '}',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);

    return {
      root,
      bin,
      common,
      editLog,
      /** An expired lease held by `loop`, whose claim went out as `claim`. */
      expiredLease(issue: number, loop: string, claim: string): void {
        const store: LeaseStore = { version: 1, leases: {} };
        claimLease(store, {
          issue,
          run: `${loop}-run-0`,
          loop,
          pid: 1,
          host: 'test',
          worktree: root,
          branch: `${loop}/${issue}`,
          claim,
          nowMs: Date.now() - 60 * 60 * 1000,
        });
        writeFileSync(join(common, 'ralph-claim-leases.json'), JSON.stringify(store));
      },
      run(args: string[], loop: string, env: Record<string, string> = {}) {
        return spawnSync(bun, [join(__dirname, 'next-tasks.ts'), ...args], {
          encoding: 'utf8',
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            RALPH_LOOP_NAME: loop,
            RALPH_RUN_ID: `${loop}-run-1`,
            RALPH_JAV: join(root, 'jav.json'),
            RALPH_PROJECT: root,
            ...env,
          },
        });
      },
      tracker: (): Record<string, Tracked> => JSON.parse(readFileSync(trackerPath, 'utf8')),
      /** Every `gh` call so far, as `<noun> <verb>` (plus ` closed` for the closed census). */
      calls: (): string[] =>
        (existsSync(join(root, 'gh.calls')) ? readFileSync(join(root, 'gh.calls'), 'utf8') : '')
          .split('\n')
          .filter((line) => line !== ''),
      removed: (): string[] =>
        (existsSync(editLog) ? readFileSync(editLog, 'utf8') : '')
          .split('\n')
          .filter((line) => line.includes('--remove-label'))
          .map((line) => line.split(' ').at(-1)!),
    };
  }

  it("--take-one --dry-run fences, names and routes by the project's own roster", () => {
    const f = fixture({
      7: { labels: ['ready-for-agent', 'nova-wip'], assignees: [] },
      8: { labels: ['ready-for-agent', 'ralph-wip', 'size:s'], assignees: [] },
    });
    mkdirSync(join(f.root, '.ralph'), { recursive: true });
    writeFileSync(
      join(f.root, '.ralph', 'config.json'),
      JSON.stringify({
        repo: 'felipearos/other', owner: 'felipearosr', baseBranch: 'main', displayName: 'Other',
        secrets: { runner: 'none', withhold: [] }, refuseFiles: [], envCheck: [], requiredChecks: [], gates: {},
        promptFragment: '.ralph/prompt.md', coderFragment: '.ralph/coder.md', plan: '.ralph/plan.md',
        journal: { dir: 'journal/other' }, loops: ['nova', 'vera'],
      }),
    );
    // Jav keyed by project: loggd's block names loops this project does not have.
    writeFileSync(
      join(f.root, 'jav.json'),
      JSON.stringify({
        loggd: { enabled: true, labels: ['size:l'], routes: { ralph: ['size:l'] } },
        other: { enabled: true, labels: ['size:s'], routes: { vera: ['size:s'] } },
      }),
    );
    const env = { RALPH_PROJECT_ID: 'other', RALPH_PROJECT_OWNER: 'felipearosr' };

    // `nova-wip` is this project's claim, so #7 is fenced; `ralph-wip` is no
    // loop of this project's, so #8 is not — and Jav routes it to vera.
    const vera = f.run(['--take-one', '--dry-run'], 'vera', env);
    expect(vera.status, vera.stderr).toBe(0);
    expect(JSON.parse(vera.stdout)).toMatchObject({ ticket: 8, loop: 'vera', route: ['size:s'], error: null });

    // nova has no route in this project's block, so it picks nothing.
    expect(JSON.parse(f.run(['--take-one', '--dry-run'], 'nova', env).stdout)).toMatchObject({ ticket: null, route: [] });

    // A loop name from another project's roster is refused, naming this one's.
    const rafa = JSON.parse(f.run(['--take-one', '--dry-run'], 'rafa', env).stdout);
    expect(rafa.error).toContain('RALPH_LOOP_NAME must be one of nova, vera');
  });

  it('--take-one --role triager --dry-run offers the ungrouped tree before an unrouted ticket', () => {
    // #143's first acceptance criterion, through the shipped script: one child
    // of #10 is in flight and none of the three carries a `## Staffing group`,
    // so the two siblings sit in OCCUPIED behind work they do not touch. That
    // is the state a triager exists to clear, and it outranks #1 — which is
    // merely invisible to coders for want of a difficulty label.
    const parent = '## Parent\n\n#10\n';
    const f = fixture({
      1: { labels: ['ready-for-agent', 'difficulty:easy'], assignees: [] },
      10: { labels: ['spec'], assignees: [] },
      11: { labels: ['ready-for-agent', 'ralph-wip'], assignees: [], body: parent },
      12: { labels: ['ready-for-agent'], assignees: [], body: parent },
      13: { labels: ['ready-for-agent'], assignees: [], body: parent },
    });
    writeFileSync(
      join(f.root, 'jav.json'),
      JSON.stringify({ fixture: { enabled: true, labels: ['difficulty:easy'], routes: { rafa: ['difficulty:easy'] } } }),
    );
    const env = { RALPH_PROJECT_ID: 'fixture', RALPH_PROJECT_OWNER: 'felipearosr' };

    const pick = JSON.parse(f.run(['--take-one', '--role', 'triager', '--dry-run'], 'rafa', env).stdout);
    expect(pick).toMatchObject({ ticket: 10, bucket: 'staffing', tickets: [10], claimed: false, error: null });
    // A triager is not difficulty-routed, so an empty route never filters its
    // whole intake away.
    expect(pick.route).toBeNull();
    // Nothing was written, and the only live re-read was the unit's own ticket.
    expect(f.removed()).toEqual([]);

    // The coder's answer over the same backlog is unchanged: #1, the one ready
    // ticket outside the held tree, with no unit keys in its JSON.
    const coder = JSON.parse(f.run(['--take-one', '--dry-run'], 'rafa', env).stdout);
    expect(coder).toMatchObject({ ticket: 1, claimed: false });
    expect(coder).not.toHaveProperty('bucket');
    expect(coder).not.toHaveProperty('tickets');
  });

  it('--take-one reports GitHub throttling as rateLimited JSON and exit 75, not a generic failure', () => {
    // 2026-09-28: the census died with a stack trace, the gate logged "could
    // not be read", and one iteration ended NEEDS_TRIAGE over a throttle.
    const f = fixture({ 7: { labels: ['ready-for-agent'], assignees: [] } });
    const out = f.run(['--take-one', '--dry-run'], 'ralph', {
      FAKE_GH_THROTTLE: '1',
      RALPH_FRONTIER_RATE_LIMIT_BUDGET_SECONDS: '0',
    });
    expect(out.status).toBe(75);
    const pick = JSON.parse(out.stdout);
    expect(pick).toMatchObject({ ticket: null, claimed: false, obstructed: [], rateLimited: true });
    expect(pick.error).toContain('GitHub rate limit (secondary)');
    expect(pick.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('--take-one costs a fixed handful of gh calls however many tickets are open', () => {
    // Before: `issue list` + one REST `dependencies/blocked_by` per open
    // issue — ~120 requests per read on Loggd's backlog, times four loops and
    // their gates. Now the blockers ride along with the open-issue page.
    const tickets: Record<number, Tracked> = {};
    for (let n = 1; n <= 40; n++) tickets[n] = { labels: ['ready-for-agent'], assignees: [] };
    const f = fixture(tickets);
    const out = f.run(['--take-one', '--dry-run'], 'ralph');
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ticket: expect.any(Number), rateLimited: false, error: null });
    // One census each, then the live re-read of the one ticket it names.
    expect(f.calls().sort()).toEqual(['api graphql', 'issue list closed', 'issue view', 'pr list']);
  });

  it('--take-one takes off the label the lease names, not its loop label', () => {
    const f = fixture({ 7: { labels: ['ready-for-agent', 'ralph-wip'], assignees: [] } });
    f.expiredLease(7, 'rafa', 'ralph-wip');

    const out = f.run(['--take-one'], 'rulo');

    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ticket: 7, claimed: true });
    expect(f.tracker()[7]!.labels.sort()).toEqual(['ready-for-agent', 'rulo-wip']);
    expect(f.removed()).not.toContain('rafa-wip');
    expect(f.removed()).toContain('ralph-wip');
  });

  it('--take-one replacing an expired lease whose label is gone claims without removing anything', () => {
    // No label on the ticket, so there is nothing to release before the claim,
    // and the tracker treats removing an absent label as done (#333): `gh`
    // would 404 on it, failing a claim over a label nobody holds.
    const f = fixture({ 7: { labels: ['ready-for-agent'], assignees: [] } });
    f.expiredLease(7, 'rafa', 'ralph-wip');

    const out = f.run(['--take-one'], 'rulo');

    expect(out.status, out.stderr).toBe(0);
    expect(f.removed()).toEqual([]);
    expect(f.tracker()[7]!.labels.sort()).toEqual(['ready-for-agent', 'rulo-wip']);
  });

  describe('UNTRIAGED on the dry-run report', () => {
    const backlog = (): Record<number, Tracked> => ({
      1: { labels: ['ready-for-agent'], assignees: [] },
      2: { labels: ['ready-for-agent', 'difficulty:hard'], assignees: [] },
      3: { labels: ['ready-for-agent', 'difficulty:easy'], assignees: [] },
      4: { labels: ['ready-for-agent', 'rafa-blocked'], assignees: [] },
      5: { labels: ['ready-for-agent', 'remo-wip'], assignees: [] },
      6: { labels: ['ready-for-agent', 'spec'], assignees: [] },
      7: { labels: ['ready-for-agent'], assignees: ['felipearosr'] },
    });
    const jav = (enabled: boolean): string =>
      JSON.stringify({
        default: {
          enabled,
          labels: ['difficulty:easy', 'difficulty:hard'],
          routes: { ralph: ['difficulty:hard'], default: ['difficulty:easy'] },
        },
      });
    const untriagedLines = (stdout: string): string[] =>
      (stripAnsi(stdout).split(/^UNTRIAGED.*$/m)[1] ?? '').split(/\n\n/)[0]!.split('\n').filter((l) => l.trim() !== '');

    it('lists unlabelled ready tickets in the text and JSON reports, with Jav on or off', () => {
      for (const enabled of [true, false]) {
        const f = fixture(backlog());
        writeFileSync(join(f.root, 'jav.json'), jav(enabled));

        const text = f.run(['--dry-run'], 'ralph');
        expect(text.status, text.stderr).toBe(0);
        expect(stripAnsi(text.stdout)).toMatch(/^UNTRIAGED — 1 ready/m);
        expect(untriagedLines(text.stdout)).toEqual(['  #1  ticket 1']);

        const json = f.run(['--dry-run', '--json'], 'ralph');
        expect(json.status, json.stderr).toBe(0);
        expect(JSON.parse(json.stdout).untriaged).toEqual([{ number: 1, title: 'ticket 1' }]);
        // Read-only: nothing claimed, nothing labelled.
        expect(f.tracker()).toEqual(backlog());
      }
    });

    it('leaves the report unchanged without Jav labels, and survives a broken jav.json', () => {
      const f = fixture(backlog());
      const plain = f.run(['--dry-run'], 'ralph');
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stdout).not.toContain('UNTRIAGED');
      expect(JSON.parse(f.run(['--dry-run', '--json'], 'ralph').stdout).untriaged).toEqual([]);

      writeFileSync(join(f.root, 'jav.json'), '{ not json');
      const broken = f.run(['--dry-run'], 'ralph');
      expect(broken.status, broken.stderr).toBe(0);
      expect(broken.stdout).toBe(plain.stdout);
      expect(broken.stderr).toContain('could not read the Jav labels');
      const brokenJson = f.run(['--dry-run', '--json'], 'ralph');
      expect(brokenJson.status, brokenJson.stderr).toBe(0);
      expect(JSON.parse(brokenJson.stdout).untriaged).toEqual([]);
    });

    it('leaves every loop pick as it was: routed loops never take an untriaged ticket', () => {
      const f = fixture(backlog());
      const pick = (loop: string): unknown => JSON.parse(f.run(['--take-one', '--dry-run'], loop).stdout).ticket;

      // Jav off: the whole frontier, lowest first, untriaged or not.
      expect(pick('ralph')).toBe(1);
      writeFileSync(join(f.root, 'jav.json'), jav(false));
      expect(pick('ralph')).toBe(1);

      // Jav on: each loop sees only its route, and #1 goes to nobody.
      writeFileSync(join(f.root, 'jav.json'), jav(true));
      expect(pick('ralph')).toBe(2);
      expect(pick('rafa')).toBe(3);
    });
  });

  it('the bulk claim takes off the label the lease names, not its loop label', () => {
    const f = fixture({ 7: { labels: ['ready-for-agent', 'ralph-wip'], assignees: [] } });
    f.expiredLease(7, 'rafa', 'ralph-wip');

    // The bulk claim is the operator's: outside a loop session, so no run id
    // (inside one the run is read-only — see the next test).
    const out = f.run([], 'rulo', { RALPH_RUN_ID: '' });

    expect(out.status, out.stderr).toBe(0);
    expect(f.removed()).toEqual(['ralph-wip']);
    expect(f.tracker()[7]).toEqual({ labels: ['ready-for-agent'], assignees: ['felipearosr'] });
  });

  describe('parent closure through --take-one (#810)', () => {
    it('closableParent skips a parent a loop label or an assignee holds', () => {
      const free = { number: 50, body: '' };
      expect(closableParent([50], [free])).toBe(50);
      expect(closableParent([50], [{ ...free, assignees: ['someone'] }])).toBeNull();
      expect(closableParent([50], [{ ...free, labels: ['spec', 'ralph-wip'] }])).toBeNull();
      expect(closableParent([50], [{ ...free, labels: ['spec', 'ralph-blocked'] }])).toBeNull();
      // An unrelated label holds nothing, and absent fields read as free.
      expect(closableParent([50], [{ ...free, labels: ['spec'] }])).toBe(50);
    });

    /** A plan whose closure list names #50, read from the working tree (the fake git refuses `show`). */
    function closurePlan(root: string, parents = ['#50']): void {
      writeFileSync(
        join(root, '.ralph', 'plan.md'),
        ['# Plan', '', '## Parent closure exceptions', '', ...parents.map((p) => `- ${p}`), ''].join('\n'),
      );
    }
    const edits = (f: { editLog: string }): string[] =>
      (existsSync(f.editLog) ? readFileSync(f.editLog, 'utf8') : '').split('\n').filter((l) => l !== '');
    const leases = (f: { common: string }): Record<string, unknown> => {
      const path = join(f.common, 'ralph-claim-leases.json');
      return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LeaseStore).leases : {};
    };
    const speedLines = (f: { common: string }): string[] => {
      const dir = join(f.common, 'ralph', 'speed');
      if (!existsSync(dir)) return [];
      return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l !== ''));
    };

    it('claims the closable parent by label and lease, with no state move and no speed clock', () => {
      const f = fixture({ 50: { labels: ['spec'], assignees: [] } });
      closurePlan(f.root);

      const out = f.run(['--take-one'], 'rafa');

      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(out.stdout)).toMatchObject({ ticket: 50, closure: true, claimed: true, error: null });
      expect(f.tracker()[50]).toEqual({ labels: ['spec', 'rafa-wip'], assignees: [] });
      // Label only: `move: false` adds the label and nothing else.
      expect(edits(f).some((l) => l.includes('--add-assignee'))).toBe(false);
      expect(edits(f).every((l) => l.includes('--add-label'))).toBe(true);
      expect(leases(f)).toHaveProperty('50');
      expect(speedLines(f).filter((l) => l.includes('"50"'))).toEqual([]);
    });

    it('--dry-run names the parent as a closure and writes nothing', () => {
      const f = fixture({ 50: { labels: ['spec'], assignees: [] } });
      closurePlan(f.root);

      const out = JSON.parse(f.run(['--take-one', '--dry-run'], 'rafa').stdout);

      expect(out).toMatchObject({ ticket: 50, closure: true, claimed: false, dryRun: true });
      expect(edits(f)).toEqual([]);
      expect(leases(f)).toEqual({});
      expect(f.tracker()[50]).toEqual({ labels: ['spec'], assignees: [] });
    });

    it('a parent another loop holds in the census is not offered', () => {
      const f = fixture({ 50: { labels: ['spec', 'remo-blocked'], assignees: [] } });
      closurePlan(f.root);

      const out = JSON.parse(f.run(['--take-one'], 'rafa').stdout);

      expect(out).toMatchObject({ ticket: null, claimed: false, obstructed: [] });
      expect(out).not.toHaveProperty('closure');
      expect(edits(f)).toEqual([]);
    });

    it.each(['remo-wip', 'remo-blocked'])('a parent that gained %s after the census meets the live re-read and is obstructed', (held) => {
      // The census sees #50 free; the live `issue view` sees remo's label.
      const f = fixture({ 50: { labels: ['spec'], assignees: [], liveLabels: ['spec', held] } });
      closurePlan(f.root);

      const out = JSON.parse(f.run(['--take-one'], 'rafa').stdout);

      expect(out).toMatchObject({ ticket: null, claimed: false });
      expect(out).not.toHaveProperty('closure');
      expect(out.obstructed.map((o: { number: number }) => o.number)).toEqual([50]);
      expect(edits(f)).toEqual([]);
    });

    it('a triager never takes a closure', () => {
      const f = fixture({ 50: { labels: ['spec'], assignees: [] } });
      closurePlan(f.root);
      const env = { RALPH_PROJECT_ID: 'fixture', RALPH_PROJECT_OWNER: 'felipearosr' };

      const out = JSON.parse(f.run(['--take-one', '--role', 'triager', '--dry-run'], 'rafa', env).stdout);

      expect(out).not.toHaveProperty('closure');
      expect(out.ticket).not.toBe(50);
    });

    it('a parent with an open child is not offered', () => {
      const f = fixture({
        50: { labels: ['spec'], assignees: [] },
        51: { labels: [], assignees: [], body: '## Parent\n\n#50\n' },
      });
      closurePlan(f.root);

      const out = JSON.parse(f.run(['--take-one', '--dry-run'], 'rafa').stdout);

      expect(out).toMatchObject({ ticket: null });
      expect(out).not.toHaveProperty('closure');
    });

    it('a non-empty frontier hands over its ticket, with no closure key', () => {
      const f = fixture({
        7: { labels: ['ready-for-agent'], assignees: [] },
        50: { labels: ['spec'], assignees: [] },
      });
      closurePlan(f.root);

      const out = JSON.parse(f.run(['--take-one', '--dry-run'], 'rafa').stdout);

      expect(out).toMatchObject({ ticket: 7 });
      expect(out).not.toHaveProperty('closure');
    });

    it('two coders racing for one closable parent: exactly one holds it', async () => {
      const f = fixture({ 50: { labels: ['spec'], assignees: [] } });
      closurePlan(f.root);
      const runAsync = (loop: string): Promise<string> =>
        new Promise((resolvePromise, reject) => {
          const child = spawn(bun, [join(__dirname, 'next-tasks.ts'), '--take-one'], {
            cwd: f.root,
            env: {
              ...process.env,
              PATH: `${f.bin}:${process.env.PATH ?? ''}`,
              RALPH_LOOP_NAME: loop,
              RALPH_RUN_ID: `${loop}-run-1`,
              RALPH_JAV: join(f.root, 'jav.json'),
              RALPH_PROJECT: f.root,
            },
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.on('error', reject);
          child.on('close', () => resolvePromise(stdout));
        });

      const outs = (await Promise.all([runAsync('rafa'), runAsync('remo')])).map((o) => JSON.parse(o));

      const winners = outs.filter((o) => o.ticket === 50 && o.claimed === true);
      expect(winners).toHaveLength(1);
      const loser = outs.find((o) => o !== winners[0])!;
      // The loser either saw the winner's label in its census (no unit) or met
      // it on the live re-read or the lease (obstructed).
      expect(loser.ticket).toBeNull();
      expect(loser.claimed).toBe(false);
      expect(f.tracker()[50]!.labels.filter((l) => l.endsWith('-wip'))).toHaveLength(1);
    });
  });

  it('a bare run inside a loop session assigns nobody, and says so on stderr (#786)', () => {
    const f = fixture({ 7: { labels: ['ready-for-agent'], assignees: [] } });

    const out = f.run([], 'rulo');

    expect(out.status, out.stderr).toBe(0);
    expect(out.stderr).toContain('RALPH_RUN_ID=rulo-run-1');
    expect(out.stdout).toContain('--dry-run: nothing assigned to');
    expect(f.tracker()[7]).toEqual({ labels: ['ready-for-agent'], assignees: [] });
  });
});

describe('roleUnits', () => {
  // One of everything a bucket has to separate: a ready ticket with a route
  // label, a ready one without, a claimed one, and a blocked one.
  const raw = [
    issue(1, 'Ready, unrouted', '', ['ready-for-agent']),
    issue(2, 'Ready, routed', '', ['ready-for-agent', 'difficulty:hard']),
    issue(3, 'Claimed by a loop', '', ['ready-for-agent', 'remo-wip']),
    issue(4, 'Blocked', blockedBy(1), ['ready-for-agent']),
  ];
  const ticketsOf = () =>
    buildTickets(
      raw,
      raw.map((r) => (r.number === 4 ? [{ number: 1, state: 'open' as const }] : [])),
      new Set(),
      [],
    );
  const classified = () => classify(ticketsOf(), []);
  const numbers = (units: FrontierUnit[]): number[] => units.flatMap((u) => u.tickets.map((t) => t.number));
  const JAV = ['difficulty:easy', 'difficulty:hard'];

  it('offers a coder exactly what it offered before roles existed', () => {
    const frontier = classified();
    expect(numbers(roleUnits('coder', ticketsOf(), frontier))).toEqual(
      takeOneCandidates(frontier).map((t) => t.number),
    );
  });

  it('offers a triager the tickets routing strands, and never a coder-ready one', () => {
    const frontier = classified();
    const picks = numbers(roleUnits('triager', ticketsOf(), frontier, { javLabels: () => JAV, owner: 'felipearosr' }));
    expect(picks).toEqual([1]);
    // #2 is a coder's work, #3 is held, #4 is blocked — none is a triager's.
    expect(picks).not.toContain(2);
    expect(picks).not.toContain(3);
    expect(picks).not.toContain(4);
  });

  it("honours the caller's scope fence in either bucket", () => {
    const frontier = classified();
    expect(
      roleUnits('triager', ticketsOf(), frontier, { javLabels: () => JAV, excluded: new Set([1]), owner: 'felipearosr' }),
    ).toEqual([]);
    expect(numbers(roleUnits('coder', ticketsOf(), frontier, { excluded: new Set([1]) }))).not.toContain(1);
  });

  it('reads the Jav labels only for the bucket defined by them', () => {
    const frontier = classified();
    let reads = 0;
    const labels = (): string[] => {
      reads++;
      return JAV;
    };
    roleUnits('coder', ticketsOf(), frontier, { javLabels: labels });
    expect(reads).toBe(0);
    roleUnits('triager', ticketsOf(), frontier, { javLabels: labels, owner: 'felipearosr' });
    expect(reads).toBe(1);
    // A ROUTED coder does need them — they are the half of #233's exemption that
    // keeps it narrow — and reads them exactly once.
    roleUnits('coder', ticketsOf(), frontier, { route: ['difficulty:hard'], javLabels: labels });
    expect(reads).toBe(2);
  });

  it('refuses a routed pick that does not say what the project configures', () => {
    // An empty configured list makes every exempt ticket read as stranded, so a
    // caller that merely forgot would get the blanket exemption #233 ruled out —
    // on a routed project only, and silently. Unrouted stays legal: nothing is
    // filtered, so there is nothing to decide.
    const frontier = classified();
    expect(() => roleUnits('coder', ticketsOf(), frontier, { route: ['difficulty:hard'] })).toThrow(
      /needs the project's Jav labels/,
    );
    expect(() => roleUnits('coder', ticketsOf(), frontier, {})).not.toThrow();
  });

  it('refuses the frontier to a role whose intake is its own scanner, naming where to claim', () => {
    // Returning nothing would read as "wait": an empty frontier and a caller in
    // the wrong place are opposite answers.
    expect(() => roleUnits('ci-doctor', ticketsOf(), classified())).toThrow(/claims by number/);
  });
});

/**
 * The triager's intake (#143). The buckets are ordered by what is STALLED, not
 * by how much work each represents, so the tests that matter most are the ones
 * pinning that order and the exclusions — a bucket that offers a ticket
 * somebody already holds is how two agents land on one issue.
 */
describe('triagerUnits', () => {
  const JAV = ['difficulty:easy', 'difficulty:hard'];
  const child = (n: number, parent: number, group: string | null = null) =>
    issue(n, `child ${n}`, `## Parent\n\n#${parent}\n${group === null ? '' : `\n## Staffing group\n\n${group}\n`}`);

  const tree = [
    issue(10, 'the spec', '', ['spec']),
    issue(11, 'held child', `## Parent\n\n#10\n`, ['ready-for-agent', 'ralph-wip']),
    child(12, 10),
    child(13, 10),
  ];

  it('offers the spec parent for staffing ahead of an unrouted ready ticket', () => {
    const { tickets, frontier } = frontierOf([...tree, issue(1, 'ready, unlabelled', '')]);
    // One in flight, two held behind it for want of a staffing group.
    expect(frontier.occluded.map((t) => t.number)).toEqual([12, 13]);
    expect(untriagedTickets(frontier, JAV).map((t) => t.number)).toEqual([1, 12, 13]);

    const units = triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' });
    expect(units).toHaveLength(1);
    expect(units[0]!.bucket).toBe('staffing');
    expect(units[0]!.tickets.map((t) => t.number)).toEqual([10]);
  });

  it('falls through to routing once every child carries a staffing group', () => {
    const { tickets, frontier } = frontierOf([
      issue(10, 'the spec', '', ['spec']),
      issue(11, 'held child', `## Parent\n\n#10\n\n## Staffing group\n\napi\n`, ['ready-for-agent', 'ralph-wip']),
      child(12, 10, 'api'),
      issue(1, 'ready, unlabelled', ''),
    ]);
    const units = triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' });
    expect(units.map((u) => u.bucket)).toEqual(['routing']);
    expect(units[0]!.tickets.map((t) => t.number)).toEqual([1, 12]);
  });

  it('batches routing to RALPH_TRIAGE_ROUTE_BATCH, oldest first', () => {
    const raw = Array.from({ length: 12 }, (_, n) => issue(n + 1, `ticket ${n + 1}`, ''));
    const { tickets, frontier } = frontierOf(raw);
    const units = triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr', batch: 5 });
    expect(units.map((u) => u.tickets.map((t) => t.number))).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
      [11, 12],
    ]);
  });

  it('routes nothing while the project configures no Jav labels', () => {
    const { tickets, frontier } = frontierOf([issue(1, 'ready, unlabelled', '')]);
    expect(triagerUnits(tickets, frontier, { javLabels: [], owner: 'felipearosr' })).toEqual([]);
  });

  it('takes an issue with no state label, or one asking for triage, into intake', () => {
    const { tickets, frontier } = frontierOf([
      issue(1, 'ready and routed', '', ['ready-for-agent', 'difficulty:easy']),
      issue(2, 'asked for triage', '', ['ready-for-agent', 'difficulty:easy', 'needs-triage']),
      issue(3, 'nobody looked at it', '', []),
      issue(4, 'parked for a person', '', ['ready-for-human']),
    ]);
    const units = triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' });
    expect(units.map((u) => [u.bucket, u.tickets.map((t) => t.number)])).toEqual([
      ['intake', [2]],
      ['intake', [3]],
    ]);
  });

  it('offers an oversize queued ticket last, by acceptance criteria or by surfaces named', () => {
    const criteria = `## Acceptance criteria\n\n${'- [ ] a thing\n'.repeat(9)}`;
    const eight = `## Acceptance criteria\n\n${'- [ ] a thing\n'.repeat(8)}`;
    const surfaces = '## What to build\n\nA web page, a mobile screen and the API behind it.\n';
    const { tickets, frontier } = frontierOf([
      issue(1, 'nine criteria', criteria, ['ready-for-agent', 'difficulty:easy']),
      issue(2, 'eight criteria', eight, ['ready-for-agent', 'difficulty:easy']),
      issue(3, 'three surfaces', surfaces, ['ready-for-agent', 'difficulty:easy']),
    ]);
    const units = triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' });
    expect(units.map((u) => [u.bucket, u.tickets[0]!.number])).toEqual([
      ['oversize', 1],
      ['oversize', 3],
    ]);
  });

  describe("never offers a ticket that is somebody else's call", () => {
    const marker = (body: string, attempt = 1, outcome: TriageOutcome = 'routed') => [
      { body: `Triaged.\n\n${formatTriageMarker({ attempt, outcome, body: triageBodyHash(body) })}` },
    ];
    const only = (raw: RawIssue[], options: Parameters<typeof triagerUnits>[2] = {}) => {
      const { tickets, frontier } = frontierOf(raw);
      return triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr', ...options }).flatMap((u) =>
        u.tickets.map((t) => t.number),
      );
    };

    it('skips a ticket another loop holds, or a person is assigned to', () => {
      expect(only([issue(1, 'held', ''), issue(2, 'claimed', '', ['ready-for-agent', 'rafa-wip'])])).toEqual([1]);
      expect(only([issue(1, 'held', ''), issue(2, 'assigned', '', ['ready-for-agent'], ['felipearosr'])])).toEqual([1]);
    });

    it('skips a ticket with an open closing PR', () => {
      const raw = [issue(1, 'free', ''), issue(2, 'has a PR', '')];
      const tickets = buildTickets(raw, [[], []], new Set(), [
        { number: 500, closingIssuesReferences: [{ number: 2 }] },
      ]);
      const frontier = classify(tickets, []);
      expect(
        triagerUnits(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' }).flatMap((u) =>
          u.tickets.map((t) => t.number),
        ),
      ).toEqual([1]);
    });

    it("skips a plan fence, a foreign author, and any loop's block", () => {
      expect(only([issue(1, 'free', ''), issue(2, 'fenced', '')], { excluded: new Set([2]) })).toEqual([1]);
      expect(
        only([issue(1, 'free', ''), issue(2, 'a stranger opened it', '', ['ready-for-agent'], [], { author: 'someone-else' })]),
      ).toEqual([1]);
      expect(only([issue(1, 'free', ''), issue(2, 'coder gave up', '', ['ready-for-agent', 'rafa-blocked'])])).toEqual([1]);
    });

    it('skips an issue whose author the census could not read', () => {
      // GitHub answers null for a deleted account, which is certainly not the
      // owner: the one issue whose provenance cannot be read is the last one to
      // hand a triager.
      expect(
        only([issue(1, 'free', ''), issue(2, 'a ghost opened it', '', ['ready-for-agent'], [], { author: null })]),
      ).toEqual([1]);
    });

    it('skips a decision that still stands, and takes it back once the body changes', () => {
      const body = '## What to build\n\nA thing.\n';
      expect(only([issue(1, 'free', ''), issue(2, 'triaged', body, ['ready-for-agent'], [], { comments: marker(body) })])).toEqual([1]);
      // The same marker against a body somebody has since edited is stale.
      expect(
        only([issue(2, 'edited since', `${body}\nand more\n`, ['ready-for-agent'], [], { comments: marker(body) })]),
      ).toEqual([2]);
      // So is one anybody has answered.
      expect(
        only([issue(2, 'answered since', body, ['ready-for-agent'], [], { comments: [...marker(body), { body: 'here you go' }] })]),
      ).toEqual([2]);
    });

    it('skips a ticket two attempts have given up on', () => {
      const body = '## What to build\n\nA thing.\n';
      expect(
        only([issue(1, 'free', ''), issue(2, 'gave up twice', `${body}\nedited\n`, ['ready-for-agent'], [], { comments: marker(body, 2, 'gave-up') })]),
      ).toEqual([1]);
    });
  });
});

/**
 * The counts the dashboard's triage panel reads (#147). The intake hands over
 * one bucket at a time, so a panel that wanted to SEE the backlog could only
 * ever learn about the leading one — hence a function that answers for all
 * four, and a report field built from it.
 */
describe('triageBuckets', () => {
  const JAV = ['difficulty:easy', 'difficulty:hard'];
  // The clock and the coders are the caller's, so the rescue bucket's window is
  // not a function of when the suite runs or of what this project's roster says.
  const NOW = new Date('2026-06-01T00:00:00Z');
  const CODERS = ['ralph', 'rafa'];
  const sizes = (raw: RawIssue[], options: Parameters<typeof triageBuckets>[2] = {}) => {
    const { tickets, frontier } = frontierOf(raw);
    const buckets = triageBuckets(tickets, frontier, {
      javLabels: JAV,
      owner: 'felipearosr',
      coders: CODERS,
      now: NOW,
      ...options,
    });
    return Object.fromEntries(TRIAGE_BUCKETS.map((b) => [b, buckets[b].map((t) => t.number)]));
  };

  const blockRecord = (body = 'blocked: PR #900 red twice in CI; not reproducible locally'): IssueComment => ({
    body,
    createdAt: '2026-05-01T00:00:00Z',
  });

  // One population per bucket, all five non-empty at once: a spec whose tree is
  // in flight and ungrouped, a ready ticket with no difficulty label, an issue
  // with no state label at all, a queued ticket over the split threshold, and a
  // ready ticket a coder gave up on for an ordinary reason.
  const everything = (): RawIssue[] => [
    issue(10, 'the spec', '', ['spec']),
    issue(11, 'held child', '## Parent\n\n#10\n', ['ready-for-agent', 'ralph-wip']),
    issue(12, 'ungrouped sibling', '## Parent\n\n#10\n', ['ready-for-agent', 'difficulty:easy']),
    issue(1, 'ready, unrouted', '', ['ready-for-agent']),
    issue(2, 'nobody looked at it', '', []),
    issue(3, 'nine criteria', `## Acceptance criteria\n\n${'- [ ] a thing\n'.repeat(9)}`, [
      'ready-for-agent',
      'difficulty:easy',
    ]),
    issue(4, 'rafa gave up on it', '', ['ready-for-agent', 'difficulty:easy', 'rafa-blocked'], [], {
      comments: [blockRecord()],
    }),
  ];

  it('counts every bucket, not just the one the intake would hand over', () => {
    const buckets = sizes(everything());
    expect(buckets.staffing).toEqual([10]);
    expect(buckets.routing).toEqual([1]);
    expect(buckets.intake).toEqual([2]);
    expect(buckets.oversize).toEqual([3]);
    expect(buckets.rescue).toEqual([4]);
  });

  describe('on a keyed tracker (#396)', () => {
    const KEYED = { keyed: { scopeLabel: 'acme-backoffice' } };
    const report = (n: number, labels: string[], extra: Parameters<typeof issue>[5] = {}, body = 'A report.\n') =>
      issue(n, `report ${n}`, body, labels, [], { author: 'a-linear-user', ...extra });
    const intake = (raw: RawIssue[]) => sizes(raw, KEYED).intake;

    it('takes an untriaged Slack report in scope, whoever opened it', () => {
      expect(intake([report(1, ['slack-intake', 'acme-backoffice'])])).toEqual([1]);
    });

    it('skips a report that already carries an outcome', () => {
      for (const outcome of ['agent-proposed', 'ready-for-agent', 'moved-to-jira']) {
        expect(intake([report(1, ['slack-intake', 'acme-backoffice', outcome])])).toEqual([]);
      }
    });

    it('skips an issue missing the intake label or the scope label', () => {
      expect(intake([report(1, ['acme-backoffice'])])).toEqual([]);
      expect(intake([report(1, ['slack-intake'])])).toEqual([]);
      // No scope configured: the whole team is in scope.
      expect(sizes([report(1, ['slack-intake'])], { keyed: { scopeLabel: null } }).intake).toEqual([1]);
    });

    it('skips a report whose decision still stands, and takes it back once the body changes', () => {
      const body = 'A report.\n';
      const comments = [
        { body: `Triaged.\n\n${formatTriageMarker({ attempt: 1, outcome: 'routed', body: triageBodyHash(body) })}` },
      ];
      const labels = ['slack-intake', 'acme-backoffice'];
      expect(intake([report(1, labels, { comments }, body)])).toEqual([]);
      expect(intake([report(1, labels, { comments }, `${body}\nand more\n`)])).toEqual([1]);
    });

    it('offers no other bucket, even where GitHub would fill all four', () => {
      expect(sizes(everything(), KEYED)).toEqual({ staffing: [], routing: [], intake: [], oversize: [], rescue: [] });
    });
  });

  it('agrees with the intake on the bucket the intake picks', () => {
    // Same fixture, same predicates: staffing leads, and `triagerUnits` offers
    // exactly what this bucket holds and nothing from the other three.
    const { tickets, frontier } = frontierOf(everything());
    const options = { javLabels: JAV, owner: 'felipearosr' };
    const units = triagerUnits(tickets, frontier, options);
    expect(units.map((u) => u.bucket)).toEqual(['staffing']);
    expect(units.flatMap((u) => u.tickets.map((t) => t.number))).toEqual(
      triageBuckets(tickets, frontier, options).staffing.map((t) => t.number),
    );
  });

  it('applies the triager\'s own eligibility fence to every bucket', () => {
    // A ticket a plan excludes is in no bucket at all, which is the fence
    // `triagerUnits` already enforces — a count that ignored it would show the
    // operator work no triager can take.
    const buckets = sizes(everything(), { excluded: new Set([1, 2, 3, 4, 10]) });
    expect(buckets).toEqual({ staffing: [], routing: [], intake: [], oversize: [], rescue: [] });
  });

  it('routes nothing while the project configures no Jav labels', () => {
    // `untriagedTickets` is empty without labels, so routing is legitimately 0
    // even with unrouted tickets sitting in the queue.
    const buckets = sizes(everything(), { javLabels: [] });
    expect(buckets.routing).toEqual([]);
    expect(buckets.staffing).toEqual([10]);
  });

  it('is read-only over the frontier it is given', () => {
    const { tickets, frontier } = frontierOf(everything());
    const before = {
      ready: frontier.readyTasks.map((t) => t.number),
      occluded: frontier.occluded.map((t) => t.number),
    };
    triageBuckets(tickets, frontier, { javLabels: JAV, owner: 'felipearosr' });
    expect(frontier.readyTasks.map((t) => t.number)).toEqual(before.ready);
    expect(frontier.occluded.map((t) => t.number)).toEqual(before.occluded);
  });

  it('reports a count for every bucket the intake has', () => {
    const { tickets, frontier } = frontierOf(everything());
    const report = frontierReport(tickets, frontier, [], new Map(), JAV);
    expect(Object.keys(report.triage).sort()).toEqual([...TRIAGE_BUCKETS].sort());
    expect(report.triage).toEqual({ staffing: 1, routing: 1, intake: 1, oversize: 1, rescue: 1 });
  });

  it('never reports a routing count larger than UNTRIAGED', () => {
    // Routing is UNTRIAGED after the triager's eligibility fence, so the panel
    // can show them side by side without the smaller number looking like a bug.
    const raw = [
      issue(1, 'ready, unrouted', '', ['ready-for-agent']),
      issue(2, 'unrouted, but a stranger opened it', '', ['ready-for-agent'], [], { author: 'someone-else' }),
    ];
    const { tickets, frontier } = frontierOf(raw);
    const report = frontierReport(tickets, frontier, [], new Map(), JAV);
    expect(report.untriaged.map((t) => t.number)).toEqual([1, 2]);
    expect(report.triage.routing).toBe(1);
  });
});

/**
 * felipearos/ralph#150's rescue bucket. Every case is about what it must NOT
 * offer: the bucket is the only one allowed past the `*-blocked` fence, so a
 * ticket it offers wrongly is one a triager plans an iteration around and the
 * `unblock` op then refuses.
 */
describe('triageBuckets — rescue', () => {
  const JAV = ['difficulty:easy', 'difficulty:hard'];
  const NOW = new Date('2026-06-01T00:00:00Z');
  const CODERS = ['ralph', 'rafa'];
  const BODY = '## What to build\n\nA thing.\n';

  const record = (body: string, createdAt = '2026-05-01T00:00:00Z'): IssueComment => ({ body, createdAt });
  const ordinary = record('blocked: PR #900 red twice in CI; not reproducible locally');
  const unblockMark = (createdAt: string, attempt = 1): IssueComment => ({
    body: `unblocked: rescue count for rafa reset\n\n${formatTriageMarker(
      { attempt, outcome: 'specced', body: triageBodyHash(BODY) },
      { loop: 'tria', unit: 4, op: UNBLOCK_MARKER_OP, labels: [] },
    )}`,
    createdAt,
  });

  const rescueOf = (raw: RawIssue[], now = NOW): number[] => {
    const { tickets, frontier } = frontierOf(raw);
    return triageBuckets(tickets, frontier, {
      javLabels: JAV,
      owner: 'felipearosr',
      coders: CODERS,
      now,
    }).rescue.map((t) => t.number);
  };

  const blocked = (comments: IssueComment[], labels = ['ready-for-agent', 'rafa-blocked']): RawIssue[] => [
    issue(4, 'rafa gave up on it', BODY, labels, [], { comments }),
  ];

  it('offers a ready ticket a coder gave up on for an ordinary reason', () => {
    expect(rescueOf(blocked([ordinary]))).toEqual([4]);
  });

  it('never offers one blocked on a migration', () => {
    expect(
      rescueOf(blocked([record('needs-migration: draft PR #900 ready; apply drizzle/0062_x.sql first')])),
    ).toEqual([]);
  });

  it('never offers one blocked on a flaky test — that is the ci-doctor\'s', () => {
    expect(
      rescueOf(blocked([record('blocked: PR #900 red on a flaky test (src/a.test.ts), not the diff')])),
    ).toEqual([]);
  });

  it('never offers one whose block record cannot be read at all', () => {
    expect(rescueOf(blocked([]))).toEqual([]);
    expect(rescueOf(blocked([record('Any thoughts on this?')]))).toEqual([]);
  });

  it('withholds one unblocked inside the window and offers it once outside', () => {
    expect(rescueOf(blocked([unblockMark('2026-05-28T00:00:00Z'), ordinary]))).toEqual([]);
    expect(rescueOf(blocked([unblockMark('2026-04-01T00:00:00Z'), ordinary]))).toEqual([4]);
  });

  it('never offers one already rescued twice, however old those rescues are', () => {
    expect(
      rescueOf(blocked([unblockMark('2026-01-01T00:00:00Z', 1), unblockMark('2026-02-01T00:00:00Z', 2), ordinary])),
    ).toEqual([]);
  });

  it('never offers one that is not ready, or that is a spec', () => {
    expect(rescueOf(blocked([ordinary], ['rafa-blocked']))).toEqual([]);
    expect(rescueOf(blocked([ordinary], ['ready-for-agent', 'spec', 'rafa-blocked']))).toEqual([]);
  });

  it('never offers one carrying two coders\' blocks', () => {
    expect(rescueOf(blocked([ordinary], ['ready-for-agent', 'ralph-blocked', 'rafa-blocked']))).toEqual([]);
  });

  it("never offers one carrying a non-coder block as WELL as the coder's", () => {
    // A `tria-blocked` beside the `rafa-blocked` is a unit somebody put in
    // front of a person. Lifting the coder's half would not free the ticket —
    // the frontier honours the one left behind — and the op refuses it, so
    // offering it only spends an iteration finding that out.
    expect(rescueOf(blocked([ordinary], ['ready-for-agent', 'rafa-blocked', 'tria-blocked']))).toEqual([]);
  });

  it('never offers a block that is not a coder\'s', () => {
    // The triager's own `-blocked`, or another triager's, is a hand-off to a
    // person — nothing a re-spec reaches.
    expect(rescueOf(blocked([ordinary], ['ready-for-agent', 'tria-blocked']))).toEqual([]);
  });

  it('never offers one with an open pull request on it', () => {
    const raw = blocked([ordinary]);
    const tickets = buildTickets(raw, raw.map(() => []), new Set<number>(), [
      { number: 900, closingIssuesReferences: [{ number: 4 }] },
    ]);
    const frontier = classify(tickets, []);
    expect(
      triageBuckets(tickets, frontier, { javLabels: JAV, owner: 'felipearosr', coders: CODERS, now: NOW }).rescue,
    ).toEqual([]);
  });

  it('hands a rescue ticket over, past its own block label', async () => {
    // The whole point: `takeOne`'s live re-read sees the `rafa-blocked` the
    // bucket selected FOR, and must not obstruct on it.
    const raw = blocked([ordinary]);
    const { tickets, frontier } = frontierOf(raw);
    const units = triagerUnits(tickets, frontier, {
      javLabels: JAV,
      owner: 'felipearosr',
      coders: CODERS,
      now: NOW,
    });
    expect(units.map((unit) => unit.bucket)).toEqual(['rescue']);

    const claimed: number[] = [];
    const outcome = await takeOne(units, {
      readLive: async (number) => ({
        assignees: [],
        labels: [...(tickets.get(number)?.labels ?? [])].map((name) => ({ name })),
        closingPr: null,
      }),
      claim: async (number) => {
        claimed.push(number);
      },
    });
    expect(outcome.obstructed).toEqual([]);
    expect(outcome.tickets.map((t) => t.number)).toEqual([4]);
    expect(outcome.bucket).toBe('rescue');
    expect(claimed).toEqual([4]);
  });

  it('is the LAST bucket the intake hands over', () => {
    const { tickets, frontier } = frontierOf([
      ...blocked([ordinary]),
      issue(2, 'nobody looked at it', '', []),
    ]);
    const options = { javLabels: JAV, owner: 'felipearosr', coders: CODERS, now: NOW };
    // An untriaged issue outranks a rescue: the blocked one is already in front
    // of a person, so an iteration's wait costs it nothing.
    expect(triagerUnits(tickets, frontier, options).map((unit) => unit.bucket)).toEqual(['intake']);

    const alone = frontierOf(blocked([ordinary]));
    expect(triagerUnits(alone.tickets, alone.frontier, options)).toEqual([
      { bucket: 'rescue', tickets: [expect.objectContaining({ number: 4 })] },
    ]);
  });

  // #776: a live park is a wait the park probe already watches.
  const parked = (overrides: Partial<ListedPark> = {}): ListedPark => ({
    ticket: 4,
    loop: 'rafa',
    label: 'rafa-blocked',
    pr: 900,
    condition: { kind: 'check', name: 'ci', on: 'pr' },
    summary: 'waits on CI going green on PR #900',
    since: '2026-05-31T00:00:00Z',
    lastChecked: null,
    budgetUntil: '2026-06-02T00:00:00Z',
    escalatedAt: null,
    expired: false,
    ...overrides,
  });
  const rescueParked = (park: ListedPark | null): number[] => {
    const { tickets, frontier } = frontierOf(blocked([ordinary]));
    return triageBuckets(tickets, frontier, {
      javLabels: JAV,
      owner: 'felipearosr',
      coders: CODERS,
      now: NOW,
      parks: new Map(park === null ? [] : [[4, park]]),
    }).rescue.map((t) => t.number);
  };

  it('withholds a ticket with a live park', () => {
    expect(rescueParked(parked())).toEqual([]);
  });

  it('offers it as before once the park is expired, escalated, stale or absent', () => {
    expect(rescueParked(parked({ expired: true }))).toEqual([4]);
    expect(rescueParked(parked({ escalatedAt: '2026-05-31T12:00:00Z' }))).toEqual([4]);
    expect(rescueParked(parked({ label: 'ralph-blocked' }))).toEqual([4]);
    expect(rescueParked(null)).toEqual([4]);
  });

  it('reports the park on the stuck ticket and drops it from the rescue count', () => {
    const { tickets, frontier } = frontierOf([
      ...blocked([ordinary]),
      issue(5, 'stuck, never parked', BODY, ['ready-for-agent', 'ralph-blocked'], [], { comments: [ordinary] }),
    ]);
    const report = (parks: Map<number, ListedPark>) =>
      frontierReport(tickets, frontier, [], new Map(), JAV, 'felipearosr', undefined, null, parks, NOW);

    const live = report(new Map([[4, parked()]]));
    expect(live.stuckReasons.map((r) => [r.number, r.park])).toEqual([
      [
        4,
        {
          loop: 'rafa',
          label: 'rafa-blocked',
          pr: 900,
          summary: 'waits on CI going green on PR #900',
          condition: { kind: 'check', name: 'ci', on: 'pr' },
          since: '2026-05-31T00:00:00Z',
          budgetUntil: '2026-06-02T00:00:00Z',
          remainingSeconds: 86_400,
          expired: false,
          escalatedAt: null,
        },
      ],
      [5, null],
    ]);

    // Past its budget: shown, floored at zero, and rescuable again.
    const spent = report(new Map([[4, parked({ budgetUntil: '2026-05-31T12:00:00Z', expired: true })]]));
    expect(spent.stuckReasons[0]!.park).toMatchObject({ remainingSeconds: 0, expired: true, escalatedAt: null });

    // Only the triage count's rescue changes; the live park is not offered.
    const without = report(new Map());
    expect(without.triage.rescue - live.triage.rescue).toBe(1);
    expect(spent.triage.rescue).toBe(without.triage.rescue);
  });
});

describe('readParks', () => {
  const NOW = new Date('2026-06-01T00:00:00Z');
  const scratch = (): string => mkdtempSync(join(tmpdir(), 'next-tasks-parks-'));
  const read = (path: string): Map<number, ListedPark> => readParks(NOW, { RALPH_PARK_STORE: path }, tmpdir());

  it('reads a missing store, a garbled one or a directory as no parks, without throwing', () => {
    const dir = scratch();
    try {
      expect(read(join(dir, 'missing.json'))).toEqual(new Map());
      writeFileSync(join(dir, 'garbage.json'), '{ not json');
      expect(read(join(dir, 'garbage.json'))).toEqual(new Map());
      mkdirSync(join(dir, 'a-directory'));
      expect(read(join(dir, 'a-directory'))).toEqual(new Map());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keys each stored park by its ticket', async () => {
    const dir = scratch();
    const path = join(dir, 'parks.json');
    try {
      await withStore(path, (store) =>
        parkIn(
          store,
          { ticket: 7, loop: 'rafa', label: 'rafa-blocked', condition: { kind: 'reference', ref: '#9' }, summary: 'waits on #9' },
          '2026-05-31T00:00:00.000Z',
        ),
      );
      const parks = read(path);
      expect([...parks.keys()]).toEqual([7]);
      expect(parks.get(7)).toMatchObject({ ticket: 7, label: 'rafa-blocked', summary: 'waits on #9', expired: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/**
 * Handing over a UNIT rather than a ticket (#143). A routing batch is ten
 * label writes that belong to one iteration, so the walk has to claim as much
 * of a unit as it can get — and two triagers polling at once must still never
 * come away with the same ticket.
 */
describe('takeOne over units', () => {
  const raw = [1, 2, 3, 4].map((n) => issue(n, `ticket ${n}`, ''));
  const ticketsOf = (): Map<number, Ticket> => buildTickets(raw, raw.map(() => []));
  const batch = (...numbers: number[]): FrontierUnit[] => {
    const tickets = ticketsOf();
    return [{ bucket: 'routing', tickets: numbers.map((n) => tickets.get(n)!) }];
  };

  it('claims every ticket of a routing batch, and names the bucket it came from', async () => {
    const hub = fakeHub();
    const outcome = await takeOne(batch(1, 2, 3), hub.io);
    expect(hub.writes).toEqual([1, 2, 3]);
    expect(outcome.bucket).toBe('routing');
    expect(outcome.tickets.map((t) => t.number)).toEqual([1, 2, 3]);
    // A caller written for one ticket still reads the field it always read.
    expect(outcome.ticket?.number).toBe(1);
    expect(outcome.claimed).toBe(true);
  });

  it('takes what is left of a batch another triager got to first', async () => {
    const hub = fakeHub({ 2: { labels: ['rafa-wip'] } });
    const outcome = await takeOne(batch(1, 2, 3), hub.io);
    expect(hub.writes).toEqual([1, 3]);
    expect(outcome.tickets.map((t) => t.number)).toEqual([1, 3]);
    expect(outcome.obstructed).toEqual([{ number: 2, reason: 'labeled rafa-wip' }]);
  });

  it('moves to the next unit only when a whole unit is held', async () => {
    const hub = fakeHub({ 1: { labels: ['rafa-wip'] }, 2: { assignees: ['someone'] } });
    const units: FrontierUnit[] = [...batch(1, 2), ...batch(3, 4)];
    const outcome = await takeOne(units, hub.io);
    expect(outcome.tickets.map((t) => t.number)).toEqual([3, 4]);
    expect(outcome.obstructed.map((o) => o.number)).toEqual([1, 2]);
  });

  it('verifies one ticket on a dry run, and still reports the size of the batch', async () => {
    // The frontier gate polls this mode continuously. Re-reading a whole batch
    // every poll would make a triager's poll cost ten times a coder's.
    const hub = fakeHub();
    const outcome = await takeOne(batch(1, 2, 3), hub.io, { dryRun: true });
    expect(hub.reads).toEqual([1]);
    expect(hub.writes).toEqual([]);
    expect(outcome.claimed).toBe(false);
    expect(outcome.tickets.map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it('never hands two triagers polling at once the same unit', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ralph-triage-lock-')), 'claim.lock');
    const hub = fakeHub();
    // Both read the SAME snapshot, which is what two supervisors polling on one
    // interval produce: the lock and the live re-read have to make that safe.
    const units: FrontierUnit[] = [...batch(1, 2), ...batch(3, 4)];
    try {
      const [a, b] = await Promise.all([
        withClaimLock(path, () => takeOne(units, hub.io)),
        withClaimLock(path, () => takeOne(units, hub.io)),
      ]);
      const got = [a, b].map((o) => o.tickets.map((t) => t.number));
      expect(got.flat().sort()).toEqual([1, 2, 3, 4]);
      expect(got[0]).not.toEqual(got[1]);
      expect(hub.writes.slice().sort()).toEqual([1, 2, 3, 4]);
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  });

  it("leaves a coder's JSON exactly as it was", () => {
    const line = renderTakeOne(
      { ticket: { number: 1, title: 'ticket 1', tree: 1 }, tickets: [{ number: 1, title: 'ticket 1', tree: 1 }], bucket: 'ready', claimed: true, obstructed: [] },
      { dryRun: false, loop: 'ralph', route: null },
    );
    expect(Object.keys(JSON.parse(line) as Record<string, unknown>)).toEqual([
      'ticket', 'title', 'tree', 'loop', 'route', 'claimed', 'dryRun', 'obstructed', 'error', 'rateLimited', 'retryAfterSeconds',
    ]);
    // A triager's unit is the one shape that says more, and it says it in
    // ADDED keys rather than by changing any of the eleven above.
    const triage = JSON.parse(
      renderTakeOne(
        { ticket: { number: 1, title: 'ticket 1', tree: 1 }, tickets: [1, 2].map((n) => ({ number: n, title: `ticket ${n}`, tree: n })), bucket: 'routing', claimed: true, obstructed: [] },
        { dryRun: false, loop: 'ralph', route: null },
      ),
    ) as Record<string, unknown>;
    expect(triage).toMatchObject({ ticket: 1, bucket: 'routing', tickets: [1, 2] });
  });
});

describe('routeBatch', () => {
  it('is ten unless RALPH_TRIAGE_ROUTE_BATCH says otherwise, and ignores nonsense', () => {
    const before = process.env.RALPH_TRIAGE_ROUTE_BATCH;
    try {
      delete process.env.RALPH_TRIAGE_ROUTE_BATCH;
      expect(routeBatch()).toBe(10);
      process.env.RALPH_TRIAGE_ROUTE_BATCH = '3';
      expect(routeBatch()).toBe(3);
      // A batch of zero would hand over an empty unit on every poll.
      for (const bad of ['0', '-4', 'lots', '2.5', '']) {
        process.env.RALPH_TRIAGE_ROUTE_BATCH = bad;
        expect(routeBatch()).toBe(10);
      }
    } finally {
      if (before === undefined) delete process.env.RALPH_TRIAGE_ROUTE_BATCH;
      else process.env.RALPH_TRIAGE_ROUTE_BATCH = before;
    }
  });
});
