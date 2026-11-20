// @vitest-environment node
/**
 * What a runner failure has to say before it is worth writing down.
 *
 * The module under test is the loop's answer to a specific overnight failure:
 * a worktree whose Bash grant was missing burned one iteration per cycle for a
 * day, and the only record of it was a journal entry a human wrote afterwards
 * (`ralph/journal/20260825T135430Z-none-rafa-permdeny.md`). Everything asserted
 * here is one of the properties that would have caught it earlier, or one of
 * the ways this file could make things worse:
 *
 *   - *A denial is recognised as a denial.* Not as `runner-error`, which is
 *     what an exit status alone can say, and which sends an operator to read a
 *     transcript for a one-line repair.
 *   - *Precedence is the operator's next move* — except that a kill is a
 *     fact. A stage the watchdog killed at its timeout reports `timeout`
 *     whatever else it said; the denial it hit on the way stays in the
 *     evidence. (2026-09-23: three real 900s kills were reported as a
 *     credential failure and a provider error.)
 *   - *Assistant prose is not evidence.* A review whose report discusses a
 *     permission denial is a review that WORKED. This is the failure mode that
 *     would make the record useless fastest, because the loop's most careful
 *     reviews are the ones most likely to use the words.
 *   - *Nor is a command's output.* A failing test that prints "Internal
 *     server error", or a `sed` of a comment about "an unauthorized request",
 *     is the code under test talking, not the provider. Credential and
 *     provider failures come from the runner's own channel only.
 *   - *Nothing secret survives.* Both halves: values out of this process's own
 *     environment, and credential shapes that never passed through one.
 *   - *Observing grants nothing.* The command allowlist and the write
 *     confinement are asserted rather than described, for the reason
 *     `plugins/orca/lifecycle.ts` gives about its own verb list: a capability added by
 *     accident, arriving as observability, is exactly the regression this
 *     module must not have.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupFixtures, scratchProject } from './dashboard/fixtures';

import {
  ALLOWED_COMMANDS,
  DEFAULT_IN_FLIGHT_WINDOW_MS,
  DEFAULT_EVIDENCE_MAX_CHARS,
  assertAllowedCommand,
  assertWritable,
  attribute,
  buildObservation,
  buildRedactor,
  classify,
  failureKinds,
  inFlightSignals,
  kindFromExit,
  leaseForRun,
  loadSignalConfig,
  readLiveSignals,
  readObservations,
  redact,
  runAllowed,
  secretValuesFrom,
  summarise,
  pushArgsForObservation,
  worthRecording,
} from './runner-failure';
import { subprocessSuite } from './test-timeouts';

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite('renders runner failures in a child process');

// Attribution checks the loop name against the project's roster, read
// in-process. This suite runs from the harness checkout, which is no project.
process.env.RALPH_PROJECT = scratchProject('runner-failure');

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A worktree-shaped directory holding only what this module reads — doubling
 * as the harness home its pattern file is read from (`home: root`).
 */
function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'loggd-runner-failure-'));
  scratch.push(root);
  mkdirSync(join(root, '.ralph', 'logs'), { recursive: true });
  writeFileSync(
    join(root, 'runner-signals.json'),
    readFileSync(join(__dirname, 'runner-signals.json'), 'utf8'),
  );
  return root;
}

const config = loadSignalConfig();
/** No environment, so a test asserts the pattern half without the env half. */
const bare = buildRedactor({}, config);

describe('the pattern file', () => {
  it('parses every pattern as a JavaScript regular expression', () => {
    // Both readers compile these, and the Python half is exercised from
    // `delegate-render.test.ts`. A pattern that only one engine accepts is the
    // failure this file cannot detect on its own, so each asserts its own side.
    for (const entry of config.secretPatterns.patterns) {
      expect(() => new RegExp(entry.pattern, 'gi'), entry.label).not.toThrow();
    }
    for (const spec of config.failureSignals.kinds) {
      for (const pattern of spec.patterns) {
        expect(() => new RegExp(pattern, 'i'), `${spec.kind}: ${pattern}`).not.toThrow();
      }
    }
  });

  it('keeps the kinds an operator acts on differently, denial first', () => {
    // The ORDER is the precedence, asserted here because it is a decision the
    // rest of the module reads out of the file rather than restating.
    expect(config.failureSignals.kinds[0]?.kind).toBe('permission-denied');
    expect(config.failureSignals.kinds[1]?.kind).toBe('authentication');
    expect(failureKinds(config)).toEqual([
      'permission-denied',
      'authentication',
      'usage-limit',
      'api-error',
      'timeout',
      'spawn-failure',
      'unavailable',
      'no-report',
      'runner-error',
      'none',
    ]);
  });
});

describe('classifying a permission denial', () => {
  it('names the denial rather than the exit status', () => {
    const result = classify(
      { exitCode: 4, text: 'bash: This command requires approval\nsee the log' },
      config,
      bare,
    );
    expect(result.kind).toBe('permission-denied');
    expect(result.signals[0]?.evidence).toContain('requires approval');
  });

  it('recognises the shapes each harness actually prints', () => {
    const denials = [
      'Error: permission denied for tool bash',
      'opencode: bash is not on the allowlist',
      'codex: command blocked by the sandbox',
      'EACCES: operation not permitted, open ...',
      'external_directory:deny refused /home/faros',
    ];
    for (const line of denials) {
      expect(classify({ exitCode: 4, text: line }, config, bare).kind, line).toBe(
        'permission-denied',
      );
    }
  });

  it('reports a kill at the timeout as a timeout, keeping the denial as evidence', () => {
    // Exit 124 is the one thing in the record nobody inferred: the watchdog
    // killed the stage. Letting a pattern outrank it is how three real 900s
    // kills on 2026-09-23 were pushed as "credential failed". The denial is
    // still in the signals for the operator who reads them.
    const result = classify(
      { exitCode: 124, text: 'permission denied: bun\nunauthorized' },
      config,
      bare,
    );
    expect(result.kind).toBe('timeout');
    expect(result.signals.map((signal) => signal.kind)).toEqual(['permission-denied', 'authentication']);
  });

  it('reports a watchdog kill as a timeout whatever the exit status', () => {
    const result = classify(
      { exitCode: 4, text: 'token has expired\nopencode-run: watchdog-killed: no output for 300s' },
      config,
      bare,
    );
    expect(result.kind).toBe('timeout');
  });

  it('still lets a denial outrank an ordinary "timed out" line from a stage that was not killed', () => {
    const result = classify(
      { exitCode: 4, text: 'permission denied: bun\nfetch timed out, retrying' },
      config,
      bare,
    );
    expect(result.kind).toBe('permission-denied');
  });

  it('finds a denial in a stage that exited cleanly', () => {
    // The failure this file exists for most: opencode reports a refused tool
    // as the call's error state, keeps going, and exits 0 having done nothing.
    const result = classify(
      { exitCode: 0, liveSignals: [{ kind: 'permission-denied', evidence: 'edit: denied', visibility: 'post-hoc' }] },
      config,
      bare,
    );
    expect(result.kind).toBe('permission-denied');
  });
});

describe('classifying an authentication or API failure', () => {
  it('separates a missing credential from a provider refusing the call', () => {
    expect(
      classify({ exitCode: 2, text: 'codex: not logged in (run: codex login)' }, config, bare).kind,
    ).toBe('authentication');
    expect(
      classify({ exitCode: 4, text: 'anthropic: 429 rate limit exceeded' }, config, bare).kind,
    ).toBe('api-error');
  });

  it('names a spent subscription window as usage-limit, not as a provider error', () => {
    // 2026-10-21: thirteen loops stopped on a five_hour rejection that the
    // dashboard reported as "the model provider refused or could not serve
    // the call". The repair is to wait for the reset, not to look for an outage.
    for (const text of [
      'rate limit rejected: five_hour',
      "You've hit your session limit · resets 10:30pm (America/Santiago)",
      'claude -p: usage limit reached',
    ]) {
      expect(classify({ exitCode: 1, text }, config, bare).kind, text).toBe('usage-limit');
    }
    expect(classify({ exitCode: 4, text: 'anthropic: 429 rate limit exceeded' }, config, bare).kind).toBe('api-error');
  });

  it('names the opencode account refusals instead of calling them runner-error', () => {
    // 2026-10-06 a lapsed OpenCode Go subscription and 2026-10-21 an expired
    // OpenCode key both stopped loops, and the durable record called each a
    // bare runner-error — sending an operator to the logs for a one-line repair.
    for (const text of [
      'This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.',
      'An active OpenCode Go subscription is required to use Go models.',
    ]) {
      expect(classify({ exitCode: 4, text }, config, bare).kind, text).toBe('authentication');
    }
    expect(
      classify(
        { exitCode: 4, text: 'UnknownError / Unexpected server error. Check server logs for details.' },
        config,
        bare,
      ).kind,
    ).toBe('api-error');
  });

  it('reads an expired credential as authentication, not as a bare exit 2', () => {
    // Exit 2 alone says `unavailable` — "the harness is not installed" — which
    // sends an operator to install something that is already there.
    const result = classify(
      { exitCode: 2, text: 'inspect: no opencode credential for review.spec (run: opencode auth login).' },
      config,
      bare,
    );
    expect(result.kind).toBe('authentication');
    expect(kindFromExit(2)).toBe('unavailable');
  });

  it('reads a failure to spawn as one, not as a missing harness', () => {
    // The intake gate's own exit for a throw is 2, and `ralph.sh` records a
    // gate that never reached a verdict with it — so without this kind the
    // durable row for loggd rafa's 2026-10-07 stop (ralph #243) read "the
    // harness is not installed", sending an operator to install a `bun` that
    // was there all along.
    for (const text of [
      "ETXTBSY: text file is busy, posix_spawn 'bun'",
      'the intake gate exited 2 without a verdict (try 1 of 3): ETXTBSY: text file is busy',
    ]) {
      expect(classify({ exitCode: 2, text }, config, bare).kind).toBe('spawn-failure');
    }
    // And it beats `unavailable`, whose patterns a spawn error can also trip.
    expect(
      classify(
        { exitCode: 2, text: 'bun: not installed? no — ETXTBSY: text file is busy' },
        config,
        bare,
      ).kind,
    ).toBe('spawn-failure');
  });

  it('falls back to the exit status when the text says nothing recognisable', () => {
    expect(classify({ exitCode: 4, text: 'something went wrong' }, config, bare).kind).toBe(
      'runner-error',
    );
    expect(classify({ exitCode: 124, text: '' }, config, bare).kind).toBe('timeout');
    expect(classify({ exitCode: 0, text: '' }, config, bare).kind).toBe('none');
  });
});

describe('live versus post-hoc', () => {
  const endedAt = Date.parse('2026-08-26T12:00:30.000Z');

  it('calls a signal live when it reached the operator before the run ended', () => {
    const result = classify(
      {
        exitCode: 4,
        endedAt,
        liveSignals: [
          { kind: 'permission-denied', evidence: 'bash: denied', at: '2026-08-26T12:00:10Z', visibility: 'post-hoc' },
        ],
      },
      config,
      bare,
    );
    expect(result.visibility).toBe('live');
    expect(result.signals[0]?.visibility).toBe('live');
  });

  it('calls a signal post-hoc when it arrived in the final flush', () => {
    // A harness that block-buffers its event stream into a pipe delivers every
    // signal in the same instant as its own exit. Reporting that as `live`
    // would be a claim about visibility nobody ever got.
    const result = classify(
      {
        exitCode: 4,
        endedAt,
        liveSignals: [
          { kind: 'permission-denied', evidence: 'bash: denied', at: '2026-08-26T12:00:30Z', visibility: 'live' },
        ],
      },
      config,
      bare,
    );
    expect(result.visibility).toBe('post-hoc');
  });

  it('is post-hoc when the whole classification came from a finished log', () => {
    expect(classify({ exitCode: 4, text: 'permission denied' }, config, bare).visibility).toBe(
      'post-hoc',
    );
  });
});

describe('what is NOT a failure', () => {
  it('never classifies the rendered transcript, however the report is worded', () => {
    // THIS TEST USED TO ASSERT NOTHING. It built the prose string and then
    // checked `expect(review).toContain('unauthorized')` — a property of the
    // string literal — while calling `classify` with no text at all. The
    // defect it was written to catch therefore shipped: every caller passed
    // `--log`, the rendered transcript, and a clean review that discussed
    // permissions was recorded as a denial.
    //
    // The fix is structural rather than a stricter pattern, so this asserts
    // the structure: `buildObservation` has no way to be given a rendered log
    // as classification input. `logPath` is a pointer and nothing reads it.
    const root = scratchRoot();
    const review =
      'P1: the handler returns 401 unauthorized, and this path is permission denied for anonymous callers.';
    writeFileSync(join(root, '.ralph', 'logs', 'review.log'), review);

    const observation = buildObservation(
      { stage: 'review.spec', exitCode: 0, logPath: '.ralph/logs/review.log' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );

    expect(observation.kind).toBe('none');
    expect(observation.signals).toEqual([]);
    expect(worthRecording(observation)).toBe(false);
    // And the pointer is still recorded, because an operator still wants it.
    expect(observation.log).toBe('.ralph/logs/review.log');
  });

  it('does classify a genuine stderr capture, which carries no model prose', () => {
    // The other half of the separation: `--errors` is the caller asserting it
    // holds the runner's own diagnostics. That one IS read.
    const root = scratchRoot();
    writeFileSync(
      join(root, '.ralph', 'logs', 'iter.err'),
      'Invalid API key. Please run `claude login`.\n',
    );
    const observation = buildObservation(
      { stage: 'orchestrator', exitCode: 1, errorsPath: '.ralph/logs/iter.err' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('authentication');
  });

  it('does not read a denial out of a diff hunk header or a line number', () => {
    // `401` and `429` were bare substrings. `@@ -401,7 +401,24 @@` classified
    // as an authentication failure, and `const RETRY_AFTER = 429;` as an API
    // error — in a stage that was working perfectly.
    const root = scratchRoot();
    writeFileSync(
      join(root, '.ralph', 'logs', 'iter.err'),
      '@@ -401,7 +401,24 @@ export function handler()\n  const RETRY_AFTER = 429;\n',
    );
    const observation = buildObservation(
      { stage: 'orchestrator', exitCode: 1, errorsPath: '.ralph/logs/iter.err' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('runner-error');
    expect(observation.signals).toEqual([]);
  });

  it('does not write a line for a stage that failed at nothing', () => {
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'review.spec', exitCode: 0 },
      { RALPH_LOOP_NAME: 'rafa' },
      { root, leasePath: join(root, 'nope.json') },
    );
    expect(observation.kind).toBe('none');
    expect(worthRecording(observation)).toBe(false);
  });
});

describe('the channel a signal came from', () => {
  const tool = (kind: string, evidence: string) =>
    ({ kind, evidence, source: 'tool', visibility: 'post-hoc' }) as const;

  it('does not call a clean exit a failure on the strength of tool output alone', () => {
    // A rail refusal can only show up inside a command's output, so the
    // renderer still raises it — but a stage that went on to exit 0 did its
    // work. It is kept as a quiet observation, and it pages nobody.
    const result = classify(
      { exitCode: 0, liveSignals: [tool('permission-denied', 'bash exited 1: bwrap: permission denied')] },
      config,
      bare,
    );
    expect(result.kind).toBe('none');
    expect(result.signals).toHaveLength(1);
    expect(result.summary).toMatch(/tool output/);
  });

  it('never takes a credential or provider kind from tool output, even on a failing exit', () => {
    // Defence in depth against a writer that did not narrow at the source.
    const result = classify(
      { exitCode: 4, liveSignals: [tool('authentication', 'bash exited 1: never retry an unauthorized request')] },
      config,
      bare,
    );
    expect(result.kind).toBe('runner-error');
  });

  it('still lets a rail refusal in tool output explain a failing exit', () => {
    const result = classify(
      { exitCode: 4, liveSignals: [tool('permission-denied', 'bash exited 1: blocked by the sandbox')] },
      config,
      bare,
    );
    expect(result.kind).toBe('permission-denied');
  });

  it('reads the channel back out of a signal file, and treats an unlabelled line as the runner', () => {
    const root = scratchRoot();
    const path = join(root, '.ralph', 'logs', 'signals-executor-x.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ at: '2026-09-23T08:17:50Z', kind: 'permission-denied', evidence: 'a', source: 'tool' }),
        JSON.stringify({ at: '2026-09-23T08:17:51Z', kind: 'permission-denied', evidence: 'b' }),
      ].join('\n'),
    );
    expect(readLiveSignals(path).map((signal) => signal.source)).toEqual(['tool', 'runner']);
  });
});

/**
 * The overnight of 2026-09-23, replayed.
 *
 * Eleven executor observations across four loops, and eight were wrong: five
 * clean exits recorded as failures, three 900s kills recorded as `api-error`
 * or `authentication` — and three "credential failed" pushes to the
 * operator's phone. Every one came from text inside a shell command's output.
 * The fixture holds the real codex events, trimmed to the matching window;
 * they go through the real renderer and the real classifier here, end to end.
 *
 * Remo's two timeouts were the control: their runs happened to contain no
 * command output that matched anything, so the exit status was all the
 * classifier had, and it said `timeout`.
 */
describe('the overnight of 2026-09-23', () => {
  interface OvernightCase {
    loop: string;
    log: string;
    recorded: { exitCode: number; kind: string; note: string | null };
    expectedKind: string;
    events: string[];
  }
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'runner-failures-2026-09-23.json'), 'utf8'),
  ) as { cases: OvernightCase[] };

  function replay(entry: OvernightCase) {
    const root = scratchRoot();
    const signals = '.ralph/logs/signals-executor-replay.jsonl';
    const rendered = spawnSync(
      'python3',
      [join(__dirname, 'delegate-render.py'), join(root, 'usage'), 'codex/test', 'codex', join(root, signals)],
      { input: `${entry.events.join('\n')}\n`, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    );
    expect(rendered.status).toBe(0);
    return buildObservation(
      {
        stage: 'executor',
        runner: 'codex',
        exitCode: entry.recorded.exitCode,
        note: entry.recorded.note,
        logPath: entry.log,
        signalsPath: existsSync(join(root, signals)) ? signals : null,
      },
      { RALPH_LOOP_NAME: entry.loop, RALPH_RUN_ID: 'run-overnight', RALPH_SESSION_ID: 'session-1' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
  }

  it('holds all eleven', () => {
    expect(fixture.cases).toHaveLength(11);
    expect(fixture.cases.filter((entry) => entry.recorded.kind !== entry.expectedKind)).toHaveLength(8);
  });

  it.each(fixture.cases.map((entry) => [`${entry.loop} ${entry.log.slice(-19, -4)}`, entry] as const))(
    '%s is classified as what actually happened',
    (_name, entry) => {
      const observation = replay(entry);
      expect(observation.kind).toBe(entry.expectedKind);
      if (entry.expectedKind === 'none') {
        // A clean run whose only "evidence" was its own test output: no line
        // in the record at all, and certainly no page.
        expect(worthRecording(observation)).toBe(false);
        expect(pushArgsForObservation(observation)).toBeNull();
      }
      if (entry.expectedKind === 'timeout') {
        expect(pushArgsForObservation(observation)).toContain('stage-timeout');
      }
    },
  );

  it('sends no credential-expiry push for any of them', () => {
    // The one real credential in the night was fine. Every "credential
    // failed" page was a comment or a test name.
    const pushed = fixture.cases.map((entry) => pushArgsForObservation(replay(entry)));
    expect(pushed.filter((args) => args?.includes('credential-expiry'))).toEqual([]);
    expect(pushed.filter((args) => args?.includes('rate-limit'))).toEqual([]);
  });

  it("keeps the one real signal of the night: codex's own sandbox failure on stderr", () => {
    // rulo, 01:35:54 — `apply_patch` could not read a file because bwrap could
    // not set up its uid map. That line came from codex's own stderr, not from
    // a command the model ran, and it is a rail the operator has to fix.
    const entry = fixture.cases.find((candidate) => candidate.expectedKind === 'permission-denied')!;
    const observation = replay(entry);
    expect(observation.signals.map((signal) => signal.source)).toEqual(['runner']);
    expect(observation.signals[0]?.evidence).toContain('bwrap');
  });
});

describe('notification routing', () => {
  it.each([
    ['permission-denied', 'permission-denial'],
    ['authentication', 'credential-expiry'],
    ['timeout', 'stage-timeout'],
  ])('pushes %s observations as %s', (kind, pushedKind) => {
    const observation = buildObservation(
      { stage: 'executor', exitCode: kind === 'timeout' ? 124 : 4, note: kind === 'authentication' ? 'token has expired' : kind === 'permission-denied' ? 'permission denied' : 'timed out' },
      { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'run-1', RALPH_ITERATION: '3', RALPH_SESSION_ID: 'session-3' },
      { root: scratchRoot(), leasePath: join(scratchRoot(), 'absent.json') },
    );
    expect(observation.kind).toBe(kind);
    expect(pushArgsForObservation(observation)).toContain(pushedKind);
  });

  it('pushes a structured rate-limit event but not an unrelated provider error', () => {
    const base = buildObservation(
      { stage: 'orchestrator', exitCode: 1, note: '429 too many requests' },
      { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'run-1' },
      { root: scratchRoot(), leasePath: join(scratchRoot(), 'absent.json') },
    );
    expect(pushArgsForObservation(base)).toContain('rate-limit');

    for (const note of ['insufficient credit', 'insufficient quota', 'insufficient balance']) {
      const insufficient = buildObservation(
        { stage: 'orchestrator', exitCode: 1, note },
        { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'run-1' },
        { root: scratchRoot(), leasePath: join(scratchRoot(), 'absent.json') },
      );
      expect(pushArgsForObservation(insufficient), note).toContain('rate-limit');
    }

    expect(pushArgsForObservation({ ...base, summary: 'the provider returned an internal server error', note: null, signals: [] })).toBeNull();

    const spent = buildObservation(
      { stage: 'orchestrator', exitCode: 1, note: "You've hit your session limit · resets 10:30pm" },
      { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'run-1' },
      { root: scratchRoot(), leasePath: join(scratchRoot(), 'absent.json') },
    );
    expect(spent.kind).toBe('usage-limit');
    expect(pushArgsForObservation(spent)).toContain('rate-limit');
  });

  it('pushes a bare provider 401 as a credential failure', () => {
    const observation = buildObservation(
      { stage: 'executor', exitCode: 4, note: 'status code 401' },
      { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'run-1' },
      { root: scratchRoot(), leasePath: join(scratchRoot(), 'absent.json') },
    );

    expect(observation.kind).toBe('authentication');
    expect(pushArgsForObservation(observation)).toContain('credential-expiry');
  });
});

describe('redaction', () => {
  it('strikes values out of a secret-bearing environment, longest first', () => {
    const env = {
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-abcdefgh',
      DATABASE_URL: 'postgresql://postgres:service-role-abcdefgh@db.example:5432/postgres',
    };
    const redactor = buildRedactor(env, config);
    const line = `connecting to ${env.DATABASE_URL} failed`;
    expect(redactor(line)).toBe('connecting to [redacted:env:DATABASE_URL] failed');
    // Longest first is what makes that true: struck shortest first, the
    // password inside the URL would be replaced and the host, user and
    // database name around it left in the log.
    expect(redactor(line)).not.toContain('db.example');
  });

  it('leaves the identifiers an operator needs to read the failure', () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_AUTH_URL: 'https://project.supabase.co/auth/v1',
      RALPH_RUN_ID: 'rafa-run-20260826T120000-1234',
      SESSION_ENABLED: 'true',
    };
    const redactor = buildRedactor(env, config);
    const line = 'rafa-run-20260826T120000-1234 hit https://project.supabase.co/auth/v1';
    expect(redactor(line)).toBe(line);
  });

  it('strikes the CI-log token although it wears a RALPH_ name', () => {
    // Not in `bkua_` shape on purpose: the env-value rule must catch it alone.
    const redactor = buildRedactor({ RALPH_BUILDKITE_READ_TOKEN: 'read-only-ci-token-0123' }, config);
    expect(redactor('curl -H "Authorization: x read-only-ci-token-0123"')).toBe(
      'curl -H "Authorization: x [redacted:env:RALPH_BUILDKITE_READ_TOKEN]"',
    );
  });

  it('does not turn a short value into a wildcard', () => {
    // A `SESSION_KEY=1` would otherwise redact every digit 1 in the log,
    // destroying the record to protect nothing.
    const values = secretValuesFrom({ SESSION_KEY: '1', API_TOKEN: 'abcdefgh' }, config);
    expect(values.map((entry) => entry.label)).toEqual(['env:API_TOKEN']);
  });

  it('strikes a multi-line value one line at a time as well as whole', () => {
    // The redactor is a STREAMING filter that emits whole lines as they
    // arrive, so it never holds two lines of a PEM key at once and the
    // full-value pattern can never match. Without the per-line entries the
    // base64 middle of a key in an environment variable went straight to disk.
    const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAxxxxxxxx', 'QklBQklBQklBQklB', '-----END RSA PRIVATE KEY-----'].join('\n');
    const redactor = buildRedactor({ MY_PRIVATE_KEY: key }, config);
    for (const line of key.split('\n')) {
      expect(redactor(`prefix ${line} suffix`), line).not.toContain(line);
    }
  });

  it('does not register a short line of a multi-line value', () => {
    // Same floor as any other value: a value whose second line is `a` would
    // otherwise redact every `a` in the transcript.
    const values = secretValuesFrom({ API_TOKEN: 'abcdefghijkl\na\nmnopqrstuvwx' }, config);
    expect(values.map((entry) => entry.value)).not.toContain('a');
    expect(values.map((entry) => entry.value)).toContain('mnopqrstuvwx');
  });

  it('strikes the JSON-escaped form of a value as well as the literal one', () => {
    // The same redactor guards the RAW event stream, which is JSON and is
    // never parsed before it is written. A credential with a quote or a
    // backslash in it appears there escaped, and only escaped.
    const secret = 'Ab\\cd"ef1234567890XYZ';
    const redactor = buildRedactor({ MY_SECRET_TOKEN: secret }, config);
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(escaped).not.toBe(secret);
    expect(redactor(`{"text":"${escaped}"}`)).toBe('{"text":"[redacted:env:MY_SECRET_TOKEN]"}');
  });

  it('strikes credential shapes that never passed through an environment', () => {
    const cases: [string, string][] = [
      ['ghp_0123456789abcdefghijABCDEF', 'github-token'],
      ['github_pat_11ABCDEFG0abcdefghijklmnop', 'github-token'],
      ['sk-ant-api03-abcdefghijklmnop', 'anthropic-key'],
      ['dp.pt.abcdefghijklmnop', 'doppler-token'],
      ['sb_secret_abcdefghijkl', 'supabase-key'],
      ['AKIAIOSFODNN7EXAMPLE', 'aws-key'],
      ['eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM', 'jwt'],
      ['Authorization: Bearer abcdefghijklmnop', 'bearer'],
      ['postgres://user:hunter2@localhost:5432/db', 'connection-string'],
      ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ];
    for (const [secret, label] of cases) {
      const out = bare(`the runner said ${secret} and stopped`);
      expect(out, secret).toContain(`[redacted:${label}]`);
      expect(out, secret).not.toContain(secret);
    }
  });

  it('never matches a bearer across a line break', () => {
    // The bridge's scrubber sends many lines through one redactor call and
    // reads them back by count (#825): a match that ate a newline would merge
    // two lines, and the whole collection would fail closed. A relayed eval
    // patch makes "…as a bearer" followed by a code line an ordinary input.
    const text = ' // the API takes it as a bearer\n   headers.set("x", y);\nlast';
    expect(bare(text).split('\n')).toHaveLength(3);
    expect(bare('Authorization:\nBearer abcdefghijklmnop').split('\n')).toHaveLength(2);
  });

  it('redacts the evidence before it reaches the record', () => {
    // The whole point of doing this inside `classify` rather than at the call
    // site: the line that matched a failure pattern is very often the line
    // carrying the credential that caused it.
    const env = { GH_TOKEN: 'ghp_0123456789abcdefghijABCDEF' };
    const result = classify(
      { exitCode: 4, text: 'gh: 401 unauthorized using ghp_0123456789abcdefghijABCDEF' },
      config,
      buildRedactor(env, config),
    );
    expect(result.kind).toBe('authentication');
    expect(result.signals[0]?.evidence).not.toContain('ghp_');
    expect(result.signals[0]?.evidence).toContain('[redacted:env:GH_TOKEN]');
  });

  it("does not call codex's model-list refresh timing out a stage timeout", () => {
    const line = 'ERROR codex_models_manager::manager: failed to refresh available models: request timed out';
    expect(classify({ exitCode: 0, text: line }, config, bare)).toMatchObject({ kind: 'none', signals: [] });
    expect(
      classify(
        { exitCode: 0, liveSignals: [{ kind: 'timeout', evidence: line, visibility: 'live', source: 'runner' }] },
        config,
        bare,
      ),
    ).toMatchObject({ kind: 'none', signals: [] });
  });

  it('still finds a real timeout after a benign line that matched first', () => {
    const text = [
      'ERROR codex_models_manager::manager: failed to refresh available models: request timed out',
      'the stage timed out after 900s',
    ].join('\n');
    const result = classify({ exitCode: 1, text }, config, bare);
    expect(result.kind).toBe('timeout');
    expect(result.signals[0]?.evidence).toContain('900s');
  });

  it('classifies a recovered OpenCode watchdog kill as a timeout signal', () => {
    const result = classify(
      { exitCode: 0, text: 'opencode-run: watchdog-killed: no request reached the model in 90s' },
      config,
      bare,
    );

    expect(result.kind).toBe('timeout');
  });

  it('bounds one piece of evidence, so a 400KB body cannot become the record', () => {
    const result = classify(
      { exitCode: 4, text: `permission denied ${'x'.repeat(5_000)}` },
      config,
      bare,
    );
    expect(result.signals[0]?.evidence.length).toBeLessThanOrEqual(DEFAULT_EVIDENCE_MAX_CHARS);
  });

  it('redacts through the public one-shot entry point too', () => {
    expect(redact('token ghp_0123456789abcdefghijABCDEF', {}, config)).toContain(
      '[redacted:github-token]',
    );
  });
});

describe('attribution', () => {
  const lease = (root: string, overrides: Record<string, unknown> = {}): string => {
    const path = join(root, 'leases.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        leases: {
          '704': {
            version: 1,
            issue: 704,
            run: 'rafa-run-20260826T120000-1234',
            owner: 'rafa@desktop',
            loop: 'rafa',
            ...overrides,
          },
        },
      }),
    );
    return path;
  };

  it('names the loop, run, attempt, stage and owner', () => {
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'review.standards', exitCode: 4, runner: 'codex', model: 'gpt-5' },
      {
        RALPH_LOOP_NAME: 'rafa',
        RALPH_RUN_ID: 'rafa-run-20260826T120000-1234',
        RALPH_SESSION_ID: 'aaaa-bbbb',
        RALPH_ITERATION: '7',
      },
      { root, leasePath: lease(root) },
    );
    expect(observation).toMatchObject({
      loop: 'rafa',
      run: 'rafa-run-20260826T120000-1234',
      stage: 'review.standards',
      runner: 'codex',
      owner: 'rafa@desktop',
      issue: 704,
      attempt: { iteration: 7, session: 'aaaa-bbbb' },
    });
  });

  it('takes the lease the run was actually holding, not whichever sorts first', () => {
    // Leases are never deleted, so a run that has worked more than one ticket
    // has several here. `find` returned whichever issue number came first in
    // the object — an arbitrary answer that attributes the failure to the
    // WRONG ticket, which is worse than attributing it to none.
    const root = scratchRoot();
    const path = join(root, 'many.json');
    const lease = (issue: number, claimedAt: string, expiresAt: string) => ({
      version: 1, issue, run: 'r1', owner: `ralph@host-${issue}`, loop: 'ralph', claimedAt, expiresAt,
    });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        leases: {
          // Lower key, claimed first, already expired — the old answer.
          '101': lease(101, '2026-08-26T09:00:00Z', '2026-08-26T09:02:00Z'),
          '704': lease(704, '2026-08-26T11:00:00Z', '2026-08-26T11:02:00Z'),
        },
      }),
    );
    const now = Date.parse('2026-08-26T11:01:00Z');
    expect(leaseForRun('r1', path, now)?.issue).toBe(704);
  });

  it('falls back to the newest expired lease when none is live', () => {
    // Better a stale ticket than no ticket: the run really was working it.
    const root = scratchRoot();
    const path = join(root, 'expired.json');
    const lease = (issue: number, claimedAt: string) => ({
      version: 1, issue, run: 'r1', owner: 'ralph@host', loop: 'ralph', claimedAt,
      expiresAt: '2026-08-26T09:02:00Z',
    });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, leases: { '101': lease(101, '2026-08-26T09:00:00Z'), '704': lease(704, '2026-08-26T10:00:00Z') } }),
    );
    expect(leaseForRun('r1', path, Date.parse('2026-08-27T00:00:00Z'))?.issue).toBe(704);
  });

  it("does not borrow another run's lease", () => {
    // Two loops share one lease store. Reporting the OTHER loop's ticket as the
    // one this failure cost is worse than reporting no ticket at all.
    const root = scratchRoot();
    expect(leaseForRun('ralph-run-elsewhere', lease(root))).toBeNull();
  });

  it('records the failure even when the loop name is unresolvable', () => {
    // An unresolved loop name is a real fault that `ralph.sh` refuses to start
    // on — but refusing to RECORD on it would throw away the observation that
    // explains why.
    const root = scratchRoot();
    writeFileSync(join(root, '.ralph', 'loop-name'), '   \n');
    const attribution = attribute(
      { stage: 'executor' },
      { RALPH_LOOP_NAME: 'not-a-loop' },
      join(root, 'missing.json'),
    );
    expect(attribution.loop).toBe('unknown');
    expect(attribution.owner).toBeNull();
    expect(attribution.issue).toBeNull();
  });

  it('treats a missing or corrupt lease store as no lease', () => {
    const root = scratchRoot();
    const path = join(root, 'broken.json');
    writeFileSync(path, '{not json');
    expect(leaseForRun('any', path)).toBeNull();
    expect(leaseForRun('any', join(root, 'absent.json'))).toBeNull();
  });
});

describe('the record', () => {
  it('round-trips through the JSONL store, skipping torn lines', () => {
    const root = scratchRoot();
    const path = join(root, '.ralph', 'logs', 'runner-failures.jsonl');
    const good = JSON.stringify({ version: 1, kind: 'permission-denied', stage: 'executor' });
    writeFileSync(path, `${good}\n{"version":1,"kind"\n\n${good}\n`);
    expect(readObservations(path)).toHaveLength(2);
  });

  it('reads live signals a renderer left, and shrugs off a torn one', () => {
    const root = scratchRoot();
    const path = join(root, '.ralph', 'logs', 'signals.jsonl');
    writeFileSync(
      path,
      '{"at":"2026-08-26T12:00:00Z","kind":"permission-denied","evidence":"denied"}\n{"at":"2026\n',
    );
    expect(readLiveSignals(path)).toEqual([
      {
        at: '2026-08-26T12:00:00Z',
        kind: 'permission-denied',
        evidence: 'denied',
        visibility: 'post-hoc',
        source: 'runner',
      },
    ]);
    expect(readLiveSignals(join(root, 'absent.jsonl'))).toEqual([]);
  });

  it('summarises a failure as loop, attempt, ticket and owner', () => {
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'executor', exitCode: 4, logPath: '.ralph/logs/x.log' },
      { RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'r1', RALPH_ITERATION: '3' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    const [line] = summarise([observation], 'r1');
    expect(line).toContain('iteration 3');
    expect(line).toContain('no claim');
    expect(line).toContain('post-hoc');
  });

  it('classifies from the finished log when a stage names one', () => {
    const root = scratchRoot();
    writeFileSync(
      join(root, '.ralph', 'logs', 'iter.log'),
      'bun: This command requires approval\n',
    );
    const observation = buildObservation(
      { stage: 'orchestrator', exitCode: 1, errorsPath: '.ralph/logs/iter.log' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('permission-denied');
    expect(observation.visibility).toBe('post-hoc');
    expect(worthRecording(observation)).toBe(true);
  });

  it('classifies the note, which on a degrade is the only error output there is', () => {
    // The four `exit 2` paths in `inspect.sh` write no log at all. Without
    // this, "no opencode credential" and "opencode not on PATH" both land in
    // the record as `unavailable` — one exit code, two opposite repairs, and
    // the record no better than the exit code it was meant to improve on.
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'mapper', exitCode: 2, note: "no opencode credential for 'mapper' (run: opencode auth login)" },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('authentication');
    expect(
      buildObservation(
        { stage: 'mapper', exitCode: 2, note: 'opencode not on PATH' },
        { RALPH_LOOP_NAME: 'ralph' },
        { root, home: root, leasePath: join(root, 'absent.json') },
      ).kind,
    ).toBe('unavailable');
  });

  it('redacts the note as well as the evidence', () => {
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'executor', exitCode: 2, note: 'auth failed for ghp_0123456789abcdefghijABCDEF' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.note).not.toContain('ghp_0123456789');
    expect(observation.note).toContain('[redacted:github-token]');
  });

  it('still records when the log it was pointed at is gone', () => {
    const root = scratchRoot();
    const observation = buildObservation(
      { stage: 'executor', exitCode: 4, errorsPath: '.ralph/logs/never-written.log' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('runner-error');
    expect(worthRecording(observation)).toBe(true);
  });
});

/**
 * The half of the record that exists while a runner is still working.
 *
 * The durable line is written at the stage's exit, which for a review is up to
 * fifteen minutes after the denial that made it worthless. Until then the
 * signal file is the only thing that can answer "what is it doing?" with
 * something other than silence.
 */
describe('a denial raised by a stage that has not ended', () => {
  const writeSignals = (root: string, name: string, kinds: string[]): string => {
    const file = join(root, '.ralph', 'logs', name);
    writeFileSync(
      file,
      `${kinds
        .map((kind) => JSON.stringify({ at: '2026-08-26T12:00:00Z', kind, evidence: `${kind} here` }))
        .join('\n')}\n`,
    );
    return file;
  };

  it('reports a signal whose stage has written no observation yet', () => {
    const root = scratchRoot();
    writeSignals(root, 'signals-executor-20260826T120000-9.jsonl', ['permission-denied']);
    const found = inFlightSignals([], root);
    expect(found).toHaveLength(1);
    expect(found[0]?.signals[0]?.kind).toBe('permission-denied');
  });

  it('stops reporting it once the stage has settled', () => {
    // Otherwise every finished stage's denials are reported twice — once in
    // the record and once, forever, as still happening.
    const root = scratchRoot();
    const name = 'signals-mapper-20260826T120000-9.jsonl';
    writeSignals(root, name, ['authentication']);
    const settled = buildObservation(
      { stage: 'mapper', exitCode: 4, signalsPath: `.ralph/logs/${name}` },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(settled.signalsFile).toBe(`.ralph/logs/${name}`);
    expect(inFlightSignals([settled], root)).toEqual([]);
  });

  it('ignores everything in the logs directory that is not a signal file', () => {
    const root = scratchRoot();
    writeFileSync(join(root, '.ralph', 'logs', 'iter-20260826.log'), 'permission denied\n');
    writeFileSync(join(root, '.ralph', 'logs', 'signals-empty.jsonl'), '');
    expect(inFlightSignals([], root)).toEqual([]);
  });

  it('drops a signal file too old to belong to a running stage', () => {
    // Both stage scripts run under `timeout`, so a stage cannot outlive it.
    // Without this bound, every supervisor killed mid-stage leaves a file that
    // nothing settles, and last Tuesday's denial is reported forever as
    // something happening right now.
    const root = scratchRoot();
    const file = writeSignals(root, 'signals-executor-old.jsonl', ['permission-denied']);
    const old = Date.now() - DEFAULT_IN_FLIGHT_WINDOW_MS - 1_000;
    utimesSync(file, old / 1000, old / 1000);
    expect(inFlightSignals([], root)).toEqual([]);
    // And is still in flight inside the window, so a slow stage is not dropped.
    expect(inFlightSignals([], root, { windowMs: DEFAULT_IN_FLIGHT_WINDOW_MS * 10 })).toHaveLength(1);
  });

  it('treats a missing logs directory as nothing in flight', () => {
    expect(inFlightSignals([], join(tmpdir(), 'loggd-no-such-root'))).toEqual([]);
  });
});

/**
 * What happens when the pattern file itself is unusable.
 *
 * Mid-edit JSON, a bad regex, a file somebody deleted. The first version of
 * this module threw out of `loadSignalConfig`, which meant the observation was
 * never written — so the one input that is supposed to make the redactor
 * STRICTER instead deleted the record of the failure entirely, and protected
 * no secret in doing it.
 */
describe('with no patterns to redact by', () => {
  const unusable = (contents: string): string => {
    const root = scratchRoot();
    writeFileSync(join(root, 'runner-signals.json'), contents);
    return root;
  };

  it('records the failure and its attribution, and withholds every quote', () => {
    const root = unusable('{ not json at all');
    writeFileSync(join(root, '.ralph', 'logs', 'iter.err'), 'auth failed for ghp_0123456789abcdefghij');

    const observation = buildObservation(
      { stage: 'executor', exitCode: 4, errorsPath: '.ralph/logs/iter.err', note: 'ghp_0123456789abcdefghij' },
      { RALPH_LOOP_NAME: 'rafa', RALPH_RUN_ID: 'r9', RALPH_ITERATION: '2' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );

    // The FACT survives — an operator still learns the executor failed, on
    // which run and which attempt.
    expect(observation).toMatchObject({ stage: 'executor', exitCode: 4, loop: 'rafa', run: 'r9' });
    expect(observation.attempt.iteration).toBe(2);
    // The CONTENT does not, because nothing could scrub it.
    expect(observation.signals).toEqual([]);
    expect(JSON.stringify(observation)).not.toContain('ghp_');
    expect(observation.note).toContain('evidence withheld');
  });

  it('treats an unsupported version the same way', () => {
    const root = unusable('{"version": 99}');
    const observation = buildObservation(
      { stage: 'mapper', exitCode: 2, note: 'sk-ant-api03-abcdefghijklmnop' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(JSON.stringify(observation)).not.toContain('sk-ant');
    expect(observation.kind).toBe('unavailable');
  });

  it('drops one bad pattern rather than the whole group it sits in', () => {
    // Joined into a single alternation, one typo takes every sibling with it:
    // a bad twelfth denial pattern would silently stop the first eleven
    // matching, and nothing would say so.
    const root = scratchRoot();
    const config = JSON.parse(
      readFileSync(join(root, 'runner-signals.json'), 'utf8'),
    ) as { failureSignals: { kinds: { kind: string; patterns: string[] }[] } };
    config.failureSignals.kinds[0]!.patterns.unshift('permission denied', '([unclosed');
    writeFileSync(join(root, 'runner-signals.json'), JSON.stringify(config));
    writeFileSync(join(root, '.ralph', 'logs', 'iter.err'), 'bash: permission denied\n');

    const observation = buildObservation(
      { stage: 'executor', exitCode: 4, errorsPath: '.ralph/logs/iter.err' },
      { RALPH_LOOP_NAME: 'ralph' },
      { root, home: root, leasePath: join(root, 'absent.json') },
    );
    expect(observation.kind).toBe('permission-denied');
  });
});

describe('observability grants nothing', () => {
  it('refuses every binary but git, before it is spawned', () => {
    expect(ALLOWED_COMMANDS).toEqual(['git']);
    expect(() => assertAllowedCommand('docker', ['ps'])).toThrow(/refusing to run 'docker'/);
    expect(() => assertAllowedCommand('gh', ['pr', 'view'])).toThrow(/refusing to run 'gh'/);
    expect(() => assertAllowedCommand('curl', ['https://example.com'])).toThrow(/refusing/);
  });

  it('refuses a git subcommand that is not a read', () => {
    expect(() => assertAllowedCommand('git', ['rev-parse', '--git-common-dir'])).not.toThrow();
    expect(() => assertAllowedCommand('git', ['fetch', 'origin'])).toThrow(/refusing 'git fetch'/);
    expect(() => assertAllowedCommand('git', ['push'])).toThrow(/refusing 'git push'/);
  });

  it('routes its one subprocess through the guard', () => {
    // The guard has to be load-bearing rather than decorative: a later caller
    // reaching for `execFileSync` directly is the regression it exists to stop,
    // so the only spawn point in the module is the one that checks.
    expect(() => runAllowed('docker', ['ps'])).toThrow(/refusing to run 'docker'/);
    // An explicit work tree, because the module's default project is now this
    // suite's scratch tmpdir and `--is-inside-work-tree` would answer for it.
    // Read-only, so naming the checkout here leaves nothing behind in it.
    expect(runAllowed('git', ['rev-parse', '--is-inside-work-tree'], import.meta.dirname)).toBe('true');
  });

  it('holds the signal-file DELETION to the same fence as the write', () => {
    // It is the other filesystem path reachable from an operator-supplied
    // argument, and the deletion is the more dangerous of the two.
    const root = scratchRoot();
    expect(() => assertWritable('../../etc/passwd', root)).toThrow(/refusing to write outside/);
  });

  it('refuses to write outside .ralph/logs', () => {
    const root = scratchRoot();
    expect(assertWritable('.ralph/logs/runner-failures.jsonl', root)).toBe(
      join(root, '.ralph/logs/runner-failures.jsonl'),
    );
    expect(() => assertWritable('../escaped.jsonl', root)).toThrow(/refusing to write outside/);
    expect(() => assertWritable('ralph/prompt.md', root)).toThrow(/refusing to write outside/);
    expect(() => assertWritable('/etc/passwd', root)).toThrow(/refusing to write outside/);
  });

  it('opens no network and starts no container, in its own source', () => {
    // A source-level assertion because the capability would arrive as an
    // import, not as a call this test could provoke. Cheap, and it fails on the
    // commit that adds one rather than on the night it matters.
    const source = readFileSync(join(__dirname, 'runner-failure.ts'), 'utf8');
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'fetch(', 'docker', 'spawnSync']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
