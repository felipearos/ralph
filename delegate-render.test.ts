// @vitest-environment node
/**
 * The renderer, driven as the subprocess it is.
 *
 * `ralph/delegate-render.py` is the ONLY point every byte a harness emits
 * passes through on its way to a log an operator reads, which makes it the
 * only place two guarantees can be made at all:
 *
 *   - *Nothing secret reaches the log.* The harness upstream runs under
 *     `env -i`; this process does not, and it prints whatever the harness
 *     said. A token echoed back in a failed API call lands in
 *     `.ralph/logs/*.log` in cleartext unless it is struck here.
 *   - *A denial is visible while the run is still going.* The stage's exit
 *     code arrives minutes later; the `!!` line arrives as the event passes.
 *
 * Both are asserted against the real script with a real pipe, because the
 * seam is a subprocess: a mock of `python3` would test the mock. The event
 * fixtures are the two harness shapes the loop actually runs — opencode's
 * `--format json` and codex's `--json`.
 *
 * The property this file guards hardest is the NEGATIVE one. A review whose
 * report discusses a permission denial is a review that worked, and a renderer
 * that raised a signal on assistant prose would put a false denial in the
 * durable record every time the loop did its most careful work.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildRedactor, classify, loadSignalConfig } from './runner-failure';
import { STAGES } from './models';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs delegate-render.py under python3');

const RENDERER = join(__dirname, 'delegate-render.py');
const TIMELINE = join(__dirname, 'timeline.py');

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Rendered {
  status: number | null;
  stdout: string;
  stderr: string;
  usage: Record<string, string>;
  signals: { at: string; kind: string; evidence: string; source?: string }[];
  timeline: Record<string, unknown>[];
}

/** One run of the real renderer over `events`, with `env` as its environment. */
function render(
  events: string[],
  options: {
    format?: 'opencode' | 'codex' | 'claude';
    env?: Record<string, string>;
    stage?: string;
  } = {},
): Rendered {
  const dir = mkdtempSync(join(tmpdir(), 'loggd-render-'));
  scratch.push(dir);
  const usagePath = join(dir, 'usage');
  const signalPath = join(dir, 'signals.jsonl');
  const timelinePath = join(dir, 'timeline.jsonl');
  const rendererArgs = [RENDERER, usagePath, 'test/model', options.format ?? 'opencode', signalPath];
  if (options.stage) rendererArgs.push('--timeline', timelinePath, '--stage', options.stage);
  const result = spawnSync(
    'python3',
    rendererArgs,
    {
      input: `${events.join('\n')}\n`,
      encoding: 'utf8',
      // A cleared environment plus what the test names, so a secret in the
      // developer's own shell cannot make an assertion pass or fail.
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...options.env },
    },
  );
  const usage: Record<string, string> = {};
  if (existsSync(usagePath)) {
    for (const line of readFileSync(usagePath, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) usage[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  const signals = existsSync(signalPath)
    ? readFileSync(signalPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { at: string; kind: string; evidence: string; source?: string })
    : [];
  const timeline = existsSync(timelinePath)
    ? readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    usage,
    signals,
    timeline,
  };
}

const toolUse = (call: string, tool: string, state: Record<string, unknown>): string =>
  JSON.stringify({ type: 'tool_use', part: { callID: call, tool, state } });

describe('the shared iteration timeline', () => {
  it('rejects a stage outside the canonical roster', () => {
    const out = render([JSON.stringify({ type: 'text', part: { text: 'nope' } })], {
      stage: 'review.security',
    });

    expect(out.status).toBe(2);
    expect(out.stderr).toContain(
      // The sessions are not delegated: the orchestrator, and the clerk's
      // code-context session, which is a session of its own (#499).
      STAGES.filter((stage) => stage !== 'orchestrator' && stage !== 'code-context')
        .sort()
        .join(', '),
    );
    expect(out.timeline).toEqual([]);
  });

  it('appends every delegated event with its stage and receipt time', () => {
    const out = render(
      [
        toolUse('c1', 'read', { input: { filePath: 'src/app/page.tsx' } }),
        JSON.stringify({ type: 'text', part: { text: 'mapped the route' } }),
      ],
      { stage: 'mapper', env: { RALPH_ITERATION: '7' } },
    );

    expect(out.timeline).toHaveLength(2);
    expect(out.timeline.map((event) => event.ralph_stage)).toEqual(['mapper', 'mapper']);
    expect(out.timeline.map((event) => event.ralph_iteration)).toEqual([7, 7]);
    expect(out.timeline.every((event) => typeof event.ralph_received_at === 'string')).toBe(true);
  });

  it('does not change the rendered log or usage file', () => {
    const events = [
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 8, output: 3 } } }),
      JSON.stringify({ type: 'text', part: { text: 'review complete' } }),
    ];
    const ordinary = render(events);
    const merged = render(events, { stage: 'review.standards' });

    expect(merged.stdout).toBe(ordinary.stdout);
    expect(merged.usage).toEqual(ordinary.usage);
  });
});

describe('surfacing a denial while the run is still going', () => {
  it('raises a signal on a tool the rails refused', () => {
    // opencode reports a refused tool as the CALL'S OWN error state and keeps
    // going, so this is a stage that will exit 0 having done nothing. The `!!`
    // line and the signal file are the only two places it exists.
    const out = render([
      toolUse('c1', 'bash', { input: { command: 'bun run typecheck' } }),
      toolUse('c1', 'bash', { status: 'error', error: 'permission denied: bash is not on the allowlist' }),
    ]);
    expect(out.stdout).toContain('→ bash: bun run typecheck');
    expect(out.stdout).toContain('!! permission-denied:');
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0]?.kind).toBe('permission-denied');
    expect(out.signals[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('announces the call once and its refusal once', () => {
    // The dedup used to be per callID, which dropped every repeat — and a
    // tool's error state is ALWAYS a repeat, so a denied tool left no trace.
    const out = render([
      toolUse('c1', 'bash', { input: { command: 'bun test' } }),
      toolUse('c1', 'bash', { status: 'running' }),
      toolUse('c1', 'bash', { status: 'error', error: 'permission denied' }),
      toolUse('c1', 'bash', { status: 'error', error: 'permission denied' }),
    ]);
    expect(out.stdout.match(/→ bash/g)).toHaveLength(1);
    expect(out.stdout.match(/!! permission-denied/g)).toHaveLength(1);
  });

  it('classifies the harness\'s own diagnostics, which arrive as plain text', () => {
    // `2>&1` in both shell fences means the harness's stderr comes down this
    // pipe. "not logged in" and a rate limit are printed there, not as events.
    const out = render(['opencode: 429 rate limit exceeded, retrying', 'codex: not logged in']);
    expect(out.signals.map((signal) => signal.kind)).toEqual(['api-error', 'authentication']);
  });

  it('raises a signal on a codex command the sandbox refused', () => {
    const out = render(
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'gh pr list',
            exit_code: 1,
            aggregated_output: 'blocked by the sandbox',
          },
        }),
        JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'unauthorized' } }),
      ],
      { format: 'codex' },
    );
    expect(out.signals.map((signal) => signal.kind)).toEqual(['permission-denied', 'authentication']);
    // Which channel each came from is part of the signal: the refusal arrived
    // inside a command's output, the credential failure from codex itself.
    expect(out.signals.map((signal) => signal.source)).toEqual(['tool', 'runner']);
    expect(out.stdout).toContain('→ bash: gh pr list');
  });

  it("classifies codex's own failure events, which carry no tool output", () => {
    // `codex exec --json` reports a provider or credential failure as a
    // top-level `error` event or a `turn.failed`, never as a command result.
    // These — not a shell command's output — are where a 401 or a 429 is.
    const out = render(
      [
        JSON.stringify({ type: 'error', message: 'unexpected status 401 Unauthorized: token expired' }),
        JSON.stringify({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }),
      ],
      { format: 'codex' },
    );
    expect(out.signals.map((signal) => [signal.kind, signal.source])).toEqual([
      ['authentication', 'runner'],
      ['api-error', 'runner'],
    ]);
  });

  it("classifies opencode's top-level error event, which carries no tool call", () => {
    // opencode reports a server error or a refused key as a top-level `error`
    // event before any tool runs; unrendered, it left an empty log.
    const out = render([
      JSON.stringify({
        type: 'error',
        error: { name: 'UnknownError', data: { message: 'Unexpected server error. Check server logs for details.' } },
      }),
    ]);
    expect(out.stdout).toContain('!! api-error:');
    expect(out.signals.map((signal) => [signal.kind, signal.source])).toEqual([['api-error', 'runner']]);
  });

  it("classifies opencode's expired-key error event as authentication", () => {
    const out = render([
      JSON.stringify({
        type: 'error',
        error: { name: 'APIError', data: { message: 'This API key has expired. Please renew it.' } },
      }),
    ]);
    expect(out.stdout).toContain('!! authentication:');
    expect(out.signals.map((signal) => [signal.kind, signal.source])).toEqual([['authentication', 'runner']]);
  });

  it("reads the status code opencode keeps beside a message with no keyword", () => {
    const out = render([
      JSON.stringify({
        type: 'error',
        error: { name: 'APIError', data: { message: 'invalid x-api-key', statusCode: 401, responseBody: '{"secret":"body"}' } },
      }),
    ]);
    expect(out.stdout).toContain('opencode: invalid x-api-key (status 401)');
    expect(out.stdout).not.toContain('secret');
    expect(out.signals.map((signal) => signal.kind)).toEqual(['authentication']);
  });

  it('prints an opencode error event even when it carries no readable message', () => {
    const named = render([JSON.stringify({ type: 'error', error: { name: 'UnknownError' } })]);
    expect(named.stdout.split('\n').some((line) => line.includes('opencode: UnknownError'))).toBe(true);
    const bare = render([JSON.stringify({ type: 'error' })]);
    expect(bare.stdout.split('\n').some((line) => line.includes('opencode: error'))).toBe(true);
  });

  it("raises nothing for codex's background model-list refresh timing out", () => {
    // Codex logs this on stderr and carries on; on 2026-09-29 it was booked as
    // a stage timeout on a stage that exited 0.
    const out = render(
      ['2026-09-29T17:55:55Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out'],
      { format: 'codex' },
    );
    expect(out.signals).toEqual([]);
    expect(out.stdout).toContain('failed to refresh available models');
  });

  it('renders without a signal file when none is asked for', () => {
    // A hand-run `delegate.sh` still renders and still redacts; only the
    // durable half needs the file.
    const dir = mkdtempSync(join(tmpdir(), 'loggd-render-nosig-'));
    scratch.push(dir);
    const result = spawnSync('python3', [RENDERER, join(dir, 'usage'), 'test/model', 'opencode'], {
      input: `${toolUse('c1', 'bash', { status: 'error', error: 'permission denied' })}\n`,
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('!! permission-denied');
  });
});

describe('what the renderer must NOT call a denial', () => {
  it('leaves assistant prose alone, however it is worded', () => {
    // The whole separation this file exists to prove: a report is not evidence.
    const prose =
      'P1: the handler returns 401 unauthorized, and the tool call is permission denied for anonymous callers.';
    const out = render([JSON.stringify({ type: 'text', part: { text: prose } })]);
    expect(out.stdout).toContain(prose);
    expect(out.stdout).not.toContain('!!');
    expect(out.signals).toEqual([]);
  });

  it('leaves a codex agent message alone for the same reason', () => {
    const out = render(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'This path is permission denied by design.' },
        }),
      ],
      { format: 'codex' },
    );
    expect(out.signals).toEqual([]);
  });

  it('never reads a credential or provider failure out of a command the model ran', () => {
    // The overnight of 2026-09-23: a failing vitest run printed
    // `"error": "Internal server error"`, a `sed` of a source file printed a
    // comment about "an unauthorized request", and three phone notifications
    // said the runner's credential had expired. It had not. A command's output
    // is whatever the code under test says, and only a rail refusal — which
    // can surface nowhere else — is read out of it.
    const command = (output: string): string =>
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', command: 'bun run test', exit_code: 1, aggregated_output: output },
      });
    const out = render(
      [
        command('import { QueryClient } from "@tanstack/react-query"; // never retry an unauthorized request'),
        command('+ "error": "Internal server error", ✓ returns 401 UNAUTHORIZED when unauthenticated'),
        command('{"level":"warn","error":{"message":"TMDB API error"}} rate limit exceeded; token has expired'),
        command('✓ the executor timed out after 900s in this fixture'),
      ],
      { format: 'codex' },
    );
    expect(out.signals).toEqual([]);
    expect(out.stdout).not.toContain('!!');
    // Still shown, since an operator reading the log wants the failing command.
    expect(out.stdout).toContain('! bash exited 1: import { QueryClient }');
  });

  it('holds the claude and opencode tool channels to the same rule', () => {
    const claude = render(
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'bun test' } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1\n✓ rejects an invalid api key with 401 unauthorized' }] } }),
      ],
      { format: 'claude' },
    );
    expect(claude.signals).toEqual([]);

    const opencode = render([
      toolUse('c1', 'bash', { status: 'error', output: 'FAIL src/x.test.ts › returns 429 too many requests' }),
    ]);
    expect(opencode.signals).toEqual([]);
  });

  it("treats opencode's own error for a refused tool as the harness speaking", () => {
    // opencode's `state.error` is the message the harness threw — a rail
    // refusal among them — not the tool's output, so it is the runner channel.
    const out = render([toolUse('c1', 'bash', { status: 'error', error: 'permission denied: bash is not on the allowlist' })]);
    expect(out.signals.map((signal) => signal.source)).toEqual(['runner']);
  });

  it('prints a tool error that is not one of the kinds, without a signal', () => {
    const out = render([toolUse('c1', 'read', { status: 'error', error: 'ENOENT: no such file' })]);
    expect(out.stdout).toContain('! read: ENOENT: no such file');
    expect(out.stdout).not.toContain('!!');
    expect(out.signals).toEqual([]);
  });
});

describe('redaction on the way to the log', () => {
  it('strikes a value out of its own secret-bearing environment', () => {
    const out = render(
      [JSON.stringify({ type: 'text', part: { text: 'connected to postgres://u:hunter2@db/x ok' } })],
      { env: { DATABASE_URL: 'postgres://u:hunter2@db/x' } },
    );
    expect(out.stdout).toContain('[redacted:env:DATABASE_URL]');
    expect(out.stdout).not.toContain('hunter2');
  });

  it('strikes a secret that the harness JSON-escaped on its way past', () => {
    // The raw `${log}.jsonl` tee is upstream of any JSON parsing, and the
    // fences' own diagnostics tell operators to go and read that file. A
    // credential containing a quote or a backslash appears there as
    // `Ab\\cd\"ef`, which the literal pattern never matched.
    const secret = 'Ab\\cd"ef1234567890XYZ';
    const out = render([JSON.stringify({ type: 'text', part: { text: `the token is ${secret}` } })], {
      env: { MY_SECRET_TOKEN: secret },
    });
    expect(out.stdout).toContain('[redacted:env:MY_SECRET_TOKEN]');
    expect(out.stdout).not.toContain('1234567890XYZ');
  });

  it('strikes a credential shape that never passed through an environment', () => {
    const out = render([
      JSON.stringify({ type: 'text', part: { text: 'using ghp_0123456789abcdefghijABCDEF' } }),
    ]);
    expect(out.stdout).toContain('[redacted:github-token]');
    expect(out.stdout).not.toContain('ghp_0123456789');
  });

  it('redacts the evidence before it reaches the signal file', () => {
    // The line that matched a failure pattern is very often the line carrying
    // the credential that caused it, so redacting only what is PRINTED would
    // leave the secret in the durable record.
    const out = render(
      [toolUse('c1', 'bash', { status: 'error', error: '401 unauthorized for Bearer abcdefghijklmnop' })],
      { env: {} },
    );
    expect(out.signals[0]?.evidence).not.toContain('abcdefghijklmnop');
    expect(out.signals[0]?.evidence).toContain('[redacted:bearer]');
  });

  it('leaves the identifiers an operator needs to read the failure', () => {
    const out = render(
      [JSON.stringify({ type: 'text', part: { text: 'run rafa-run-20260826T120000-1234 at https://project.supabase.co' } })],
      { env: { RALPH_RUN_ID: 'rafa-run-20260826T120000-1234', NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co' } },
    );
    expect(out.stdout).toContain('rafa-run-20260826T120000-1234');
    expect(out.stdout).toContain('https://project.supabase.co');
  });

  it('redacts before it truncates, so a cut cannot smuggle a prefix out', () => {
    // `hint()` cut to 97 characters and `say()` redacted afterwards, so an
    // exact environment value split by the cut matched nothing and reached the
    // log as a prefix — and a 30-character prefix of a real key is quite
    // enough to be worth having.
    const secret = 'p4ssw0rd-QQQQQQQQQQQQQQQQQQQQQQQQ';
    const command = `psql --host=localhost --username=postgres --dbname=postgres --no-password --pw ${secret}`;
    const out = render([toolUse('c1', 'bash', { input: { command } })], {
      env: { DB_PASSWORD: secret },
    });
    expect(out.stdout).not.toContain(secret);
    expect(out.stdout).not.toContain(secret.slice(0, 12));
    expect(out.stdout).toContain('[redacted:env:DB_P');
  });

  it('cannot be made to write shell code into the file the fences source', () => {
    // `delegate.sh` and `inspect.sh` both run `. "$usage"` under the
    // orchestrator's full Doppler environment, and `sessionID` comes straight
    // off the harness's event stream — so a session id of `x\nEVIL=$(…)` ran
    // arbitrary commands with every credential in scope. That predates this
    // work and would have made the rest of its redaction beside the point: a
    // runner that can execute does not need to leak.
    const out = render([
      JSON.stringify({ type: 'text', part: { text: 'hi' }, sessionID: 'ses_x\nEVIL=$(id -un)' }),
    ]);
    expect(out.usage.DELEGATE_SESSION).not.toContain('$');
    expect(out.usage.DELEGATE_SESSION).not.toContain('\n');
    expect(out.usage).not.toHaveProperty('EVIL');
  });

  it('says so on stderr when it is running without patterns', () => {
    // Silence here would let a log fill with cleartext credentials and look
    // completely normal, which is the one failure mode worse than not
    // redacting at all.
    // A copy of the real script somewhere its pattern file is not, which is
    // the only way to reach the branch: the file itself is checked in.
    const dir = mkdtempSync(join(tmpdir(), 'loggd-render-bare-'));
    scratch.push(dir);
    const copy = join(dir, 'delegate-render.py');
    writeFileSync(copy, readFileSync(RENDERER, 'utf8'));
    writeFileSync(join(dir, 'timeline.py'), readFileSync(TIMELINE, 'utf8'));
    const result = spawnSync('python3', [copy, join(dir, 'usage'), 'm', 'opencode'], {
      input: '{"type":"text","part":{"text":"hello"}}\n',
      encoding: 'utf8',
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '' },
    });
    expect(result.stderr).toContain('NOT redacting');
    expect(result.stdout).toContain('hello');
  });
});

describe('what the renderer already promised', () => {
  it('still totals token usage and still reports whether a report was written', () => {
    // `DELEGATE_TEXT` is `ralph/inspect.sh`'s only way to check its published
    // contract, and the accumulation is what the usage ledger books.
    const out = render([
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } }, cost: 0.5 } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1, cache: {} }, cost: 0.25 } }),
      JSON.stringify({ type: 'text', part: { text: 'the report' } }),
    ]);
    expect(out.usage).toMatchObject({
      DELEGATE_INPUT: '11',
      DELEGATE_OUTPUT: '6',
      DELEGATE_CACHE_READ: '3',
      DELEGATE_CACHE_WRITE: '2',
      DELEGATE_STEPS: '2',
      DELEGATE_TEXT: '1',
    });
    expect(out.usage).not.toHaveProperty('DELEGATE_COST');
  });

  it('clears the report flag when tool activity was the last thing that happened', () => {
    const out = render([
      JSON.stringify({ type: 'text', part: { text: 'I will start by reading the diff' } }),
      toolUse('c1', 'read', { input: { filePath: 'src/x.ts' } }),
    ]);
    expect(out.usage.DELEGATE_TEXT).toBe('0');
  });

  it('clears it for a denial too, since a denial is not a report', () => {
    const out = render([
      JSON.stringify({ type: 'text', part: { text: 'here is the report' } }),
      toolUse('c1', 'bash', { status: 'error', error: 'permission denied' }),
    ]);
    expect(out.usage.DELEGATE_TEXT).toBe('0');
  });
});

/**
 * The two engines, held to the same answer.
 *
 * The whole shared-pattern-file design rests on one assumption: that
 * `ralph/runner-signals.json` means the same thing to Python's `re` and to
 * JavaScript's `RegExp`. If it ever stops being true, the failure is silent
 * and exactly the wrong shape — a credential struck out of the durable record
 * and printed into the transcript, or a denial the renderer sees and the
 * record does not.
 *
 * Nothing about the two engines guarantees it. `$` matches before a trailing
 * newline in Python and only at the end in JavaScript; case-insensitivity is
 * full Unicode folding in one and simple folding in the other. Those are the
 * differences we know about, and this is what catches the ones we do not: the
 * samples go through the REAL renderer as a subprocess and through the real TS
 * classifier and redactor in-process, and the two are compared.
 */
describe('the pattern file means the same thing to both readers', () => {
  const SAMPLES = [
    // One per credential shape in the file.
    'ghp_0123456789abcdefghijABCDEF',
    'github_pat_11ABCDEFG0abcdefghijklmnop',
    'sk-ant-api03-abcdefghijklmnop',
    'sk-proj-abcdefghijklmnopqrstuvw',
    'dp.pt.abcdefghijklmnop',
    'sb_secret_abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM',
    'Authorization: Bearer abcdefghijklmnop',
    'postgres://user:hunter2@localhost:5432/db',
    '-----BEGIN RSA PRIVATE KEY-----',
    'bkua_abcdefghijklmnopqrstuvwxyz',
    // One per failure kind, plus the shapes that must NOT match.
    'bash: This command requires approval',
    'Error: permission denied for tool bash',
    'codex: not logged in (run: codex login)',
    'anthropic: 429 rate limit exceeded',
    'the stage timed out after 900s',
    'ERROR codex_models_manager::manager: failed to refresh available models: request timed out',
    'inspect: opencode not on PATH',
    'review.spec never produced a report',
    'This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.',
    'An active OpenCode Go subscription is required to use Go models.',
    'UnknownError / Unexpected server error. Check server logs for details.',
    '@@ -401,7 +401,24 @@ export function handler()',
    '  const RETRY_AFTER = 429;',
    'nothing interesting on this line at all',
  ];

  it('redacts and classifies every sample identically', () => {
    const config = loadSignalConfig();
    const redactor = buildRedactor({}, config);

    // Fed as plain non-JSON lines, which is the renderer's diagnostic branch —
    // it redacts, then classifies, then prints either `!! kind: evidence` or
    // the redacted line. Both halves of the contract in one pass.
    const rendered = render(SAMPLES).stdout.split('\n').filter((line) => line.trim());
    expect(rendered).toHaveLength(SAMPLES.length);

    for (const [index, sample] of SAMPLES.entries()) {
      const fromPython = rendered[index]!;
      const expectedText = redactor(sample);
      const expectedKind = classify({ exitCode: 4, text: sample }, config, redactor).kind;

      if (expectedKind === 'runner-error') {
        // No kind matched on the TS side, so the renderer must not have raised
        // one either — it prints the redacted line and nothing more. Trimmed,
        // because the renderer strips each line it reads; that is formatting,
        // and this test is about meaning.
        expect(fromPython.trim(), sample).toBe(expectedText.trim());
      } else {
        expect(fromPython, sample).toContain(`!! ${expectedKind}:`);
      }
      // And whatever each did with it, neither may leave the secret behind.
      if (expectedText !== sample) {
        expect(fromPython, sample).not.toContain(sample);
        expect(fromPython, sample).toContain('[redacted:');
      }
    }
  });
});

describe('the claude stream', () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  const use = (id: string, name: string, input: Record<string, unknown>): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: unknown, isError: boolean): string =>
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  const done = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      result: 'Done.',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      permission_denials: [],
      ...extra,
    });

  it('raises one signal for a refusal that arrives both as a tool result and in permission_denials', () => {
    const out = render(
      [
        init,
        use('toolu_1', 'Bash', { command: 'gh --version' }),
        result('toolu_1', 'Permission to use Bash with command gh --version has been denied.', true),
        done({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'gh --version' } }] }),
      ],
      { format: 'claude' },
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('→ Bash: gh --version');
    expect(out.stdout.match(/!! permission-denied/g)).toHaveLength(1);
    // One line for the operator, but the harness's own list is recorded too:
    // it is the runner channel, and a clean exit is classified from that
    // channel alone. The record keeps one piece of evidence per kind anyway.
    expect(out.signals.map((s) => [s.kind, s.source])).toEqual([
      ['permission-denied', 'tool'],
      ['permission-denied', 'runner'],
    ]);
  });

  it('classifies the other refusal text the harness uses, under a mode that asks first', () => {
    // `--permission-mode acceptEdits` refuses an unlisted Bash call with this
    // exact text instead of "has been denied"; both are in runner-signals.json.
    const out = render(
      [init, use('toolu_3', 'Bash', { command: 'bun --version' }), result('toolu_3', 'This command requires approval', true), done()],
      { format: 'claude' },
    );
    expect(out.signals.map((s) => s.kind)).toEqual(['permission-denied']);
  });

  it('raises the refusal the harness only listed in permission_denials', () => {
    // A denial the model never saw a result for — the harness can end a turn
    // on it — exists nowhere but that list.
    const out = render(
      [init, use('toolu_9', 'Bash', { command: 'doppler secrets' }), done({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_9', tool_input: { command: 'doppler secrets' } }] })],
      { format: 'claude' },
    );
    expect(out.signals).toHaveLength(1);
    expect(out.signals[0]?.evidence).toContain('Bash: permission denied: doppler secrets');
  });

  it('books the four usage figures the result event carries, and the session', () => {
    const out = render(
      [init, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the file.' }] } }), done()],
      { format: 'claude' },
    );
    expect(out.stdout).toContain('Reading the file.');
    expect(out.usage).toMatchObject({
      DELEGATE_INPUT: '10',
      DELEGATE_OUTPUT: '20',
      DELEGATE_CACHE_READ: '300',
      DELEGATE_CACHE_WRITE: '40',
      DELEGATE_STEPS: '3',
      DELEGATE_TEXT: '1',
      DELEGATE_SESSION: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    expect(out.signals).toEqual([]);
  });

  it('prints a tool error that is not one of the kinds, without a signal', () => {
    const out = render(
      [init, use('toolu_2', 'Bash', { command: 'bun run typecheck' }), result('toolu_2', [{ type: 'text', text: 'src/x.ts(3,1): error TS2322' }], true), done()],
      { format: 'claude' },
    );
    expect(out.stdout).toContain('! Bash: src/x.ts(3,1): error TS2322');
    expect(out.signals).toEqual([]);
  });

  it('keeps two unkeyed error results as two lines', () => {
    const unkeyed = (content: string): string =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content, is_error: true }] } });
    const out = render([init, unkeyed('first failed'), unkeyed('second failed'), done()], { format: 'claude' });
    expect(out.stdout).toContain('first failed');
    expect(out.stdout).toContain('second failed');
  });

  it('reports a run the harness itself marked as an error', () => {
    const out = render([init, done({ is_error: true, result: 'API Error: 529 overloaded' })], { format: 'claude' });
    expect(out.stdout).toContain('claude -p: API Error: 529 overloaded');
  });
});
