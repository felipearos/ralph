// @vitest-environment node
/**
 * What `ralph/delegate.sh` writes down when a delegation goes wrong.
 *
 * The executor's rails are the tightest in the loop — a cleared environment, a
 * permission file, no `gh`, no `doppler` — and the cost of rails that tight is
 * that hitting one looks like nothing. opencode reports a refused tool as that
 * call's own error state, carries on, and exits 0; the orchestrator reads an
 * empty diff and a clean exit and concludes the executor had nothing to do.
 * A whole night can go that way, which is what the journal entry for
 * 2026-08-25 records happening in the `rafa` worktree.
 *
 * So the assertions here are about the seam rather than about opencode: a fake
 * harness on PATH emits the event shapes the real one emits, and what is
 * checked is that a denial reaches the durable record, attributed to the run
 * and the attempt that paid for it, with any credential in the line struck out
 * first. The harness is faked; `delegate.sh`, `delegate-render.py` and
 * `runner-failure.ts` are all real.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs delegate.sh through bash against fixture git repos');

const ROOT = dirname(new URL(import.meta.url).pathname);

const scratch: string[] = [];

afterAll(() => {
  scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const dir = (prefix: string): string => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(made);
  return made;
};

/**
 * A fake `opencode` that emits `events` and nothing else.
 *
 * `auth list` has to answer "OpenCode Go", because `delegate.sh` checks the
 * credential under the same cleared environment as the run itself — which is a
 * rail worth keeping, and means a fake that only handles `run` degrades at the
 * preflight instead of reaching the renderer.
 */
function fakeOpencode(events: string[], databaseLog?: string): string {
  const bin = dir('delegate-bin-');
  // A LOUD `claude` beside the fake opencode: a test that resolves the executor
  // to the claude runner by mistake must fail here, not spend real tokens on
  // the CLI further down PATH — which is what happened when the loop blocks
  // first put rafa's executor on claude.
  writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\necho "fake opencode test reached claude" >&2; exit 99\n');
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(
    join(bin, 'opencode'),
    [
      '#!/usr/bin/env bash',
      '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }',
      ...(databaseLog ? [`printf '%s\\n' "$OPENCODE_DB" >> ${JSON.stringify(databaseLog)}`] : []),
      ...events.map((event) => `printf '%s\\n' ${JSON.stringify(event)}`),
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'opencode'), 0o755);
  return bin;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  observations: Record<string, unknown>[];
}

/**
 * A project worktree carrying loggd's committed `.ralph/` (config and coder
 * fragment): `delegate.sh` renders its rails from the harness `coder.md` with
 * the project's fragment spliced in, so it needs a project to render against.
 */
function project(): string {
  const root = dir('delegate-project-');
  cpSync(join(ROOT, 'fixtures', 'loggd', '.ralph'), join(root, '.ralph'), { recursive: true });
  return root;
}

function delegate(bin: string, env: Record<string, string> = {}, continuation = false): Run {
  const projectRoot = project();
  const record = join(dir('delegate-record-'), 'runner-failures.jsonl');
  const logDir = env.RALPH_LOG_DIR ?? dir('delegate-logs-');
  const briefDir = dir('delegate-brief-');
  const briefFile = join(briefDir, 'brief.md');
  writeFileSync(briefFile, '# Round\n\nNothing; the harness is a fake.\n');
  const args = continuation ? ['--continue', briefFile] : [briefFile];
  const result = spawnSync('bash', [join(ROOT, 'delegate.sh'), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RALPH_RUNNER_FAILURE_LOG: record,
      RALPH_LOOP_NAME: 'rafa',
      // The loop blocks in models.json put rafa's executor on `claude`; these
      // tests fake one harness at a time, so the runner is pinned here and a
      // test that wants the other one says so. Without this the opencode
      // fakes are never invoked and the REAL `claude` on PATH runs the brief.
      RALPH_RUNNER_EXECUTOR: 'opencode',
      RALPH_MODEL_EXECUTOR: 'opencode-go/deepseek-v4-flash',
      RALPH_RUN_ID: 'rafa-run-delegate-test',
      RALPH_SESSION_ID: 'session-xyz',
      RALPH_ITERATION: '2',
      RALPH_LOG_DIR: logDir,
      RALPH_PROJECT: projectRoot,
      ...env,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    observations: existsSync(record)
      ? readFileSync(record, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [],
  };
}

const toolUse = (call: string, tool: string, state: Record<string, unknown>): string =>
  JSON.stringify({ type: 'tool_use', part: { callID: call, tool, state } });

describe('an executor that was denied', () => {
  it('adds executor events to the iteration timeline', () => {
    const timeline = join(dir('delegate-timeline-'), 'iteration.events.jsonl');
    const run = delegate(
      fakeOpencode([JSON.stringify({ type: 'text', part: { text: 'implemented it' } })]),
      { RALPH_TIMELINE: timeline },
    );

    expect(run.status).toBe(0);
    const events = readFileSync(timeline, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual(['ralph_stage', 'text', 'ralph_stage']);
    expect(events.map((event) => event.state).filter(Boolean)).toEqual(['started', 'completed']);
    expect(events.every((event) => event.ralph_stage === 'executor')).toBe(true);
    expect(events.every((event) => event.ralph_iteration === 2)).toBe(true);
  });

  it('records the denial even though the delegation exited 0', () => {
    // The failure this whole file is about: a clean exit is not evidence that
    // anything happened.
    const run = delegate(
      fakeOpencode([
        toolUse('c1', 'bash', { input: { command: 'bun run typecheck' } }),
        toolUse('c1', 'bash', { status: 'error', error: 'permission denied: bash is not on the allowlist' }),
      ]),
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('!! permission-denied:');
    expect(run.observations).toHaveLength(1);
    expect(run.observations[0]).toMatchObject({
      stage: 'executor',
      runner: 'opencode',
      exitCode: 0,
      kind: 'permission-denied',
      loop: 'rafa',
      run: 'rafa-run-delegate-test',
      attempt: { iteration: 2, session: 'session-xyz' },
    });
  });

  it('strikes a credential out of the evidence before it is written', () => {
    const run = delegate(
      fakeOpencode([
        toolUse('c1', 'gh', { status: 'error', error: '401 unauthorized with ghp_0123456789abcdefghijABCDEF' }),
      ]),
    );

    const [observation] = run.observations;
    const evidence = JSON.stringify(observation);
    expect(observation).toMatchObject({ kind: 'authentication' });
    expect(evidence).not.toContain('ghp_0123456789');
    expect(evidence).toContain('[redacted:github-token]');
    // And not only in the record: the transcript on disk is what an operator
    // greps, and it is written from this same stream.
    expect(run.stdout).not.toContain('ghp_0123456789');
  });

  it('writes nothing at all for a delegation that hit no rail', () => {
    // The record's whole value is that a line in it means something. A stage
    // that succeeded quietly must not put a row in the panel that exists to
    // show failures.
    const run = delegate(
      fakeOpencode([
        toolUse('c1', 'read', { input: { filePath: 'src/x.ts' } }),
        JSON.stringify({ type: 'text', part: { text: 'Done; the diff is in the working tree.' } }),
      ]),
    );

    expect(run.status).toBe(0);
    expect(run.observations).toEqual([]);
  });
});

describe('the executor command guard', () => {
  it('puts the guard ahead of every package runner the executor can reach', () => {
    // The Codex runner mounts the guard inside its sandbox; the other runners
    // start on the host, so delegate.sh is what puts it first on their PATH.
    const bin = fakeOpencode([JSON.stringify({ type: 'text', part: { text: 'Done.' } })]);
    const seen = join(dir('delegate-guard-'), 'bun');
    const opencode = readFileSync(join(bin, 'opencode'), 'utf8');
    writeFileSync(
      join(bin, 'opencode'),
      opencode.replace(/\nexit 0$/, `\ncommand -v bun > ${JSON.stringify(seen)}\nexit 0`),
    );

    expect(delegate(bin).status).toBe(0);
    expect(readFileSync(seen, 'utf8').trim()).toBe(join(ROOT, 'executor-guard', 'bin', 'bun'));
  });
});

describe('the executor database', () => {
  it(
    'reuses one run-scoped store for a continuation without touching the global store',
    () => {
      const databaseLog = join(dir('delegate-database-'), 'paths');
      const logDir = dir('delegate-logs-');
      const bin = fakeOpencode(
        [JSON.stringify({ type: 'text', part: { text: 'Done.' } })],
        databaseLog,
      );

      expect(delegate(bin, { RALPH_LOG_DIR: logDir }).status).toBe(0);
      expect(delegate(bin, { RALPH_LOG_DIR: logDir }, true).status).toBe(0);

      const paths = readFileSync(databaseLog, 'utf8').trim().split('\n');
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(paths[1]);
      expect(paths[0]).toContain('rafa-run-delegate-test-executor.db');
      expect(paths[0]).not.toBe(join(process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db'));
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${paths[0]}${suffix}`, { force: true });
    },
    15_000,
  );
});

describe('an executor that was never going to run', () => {
  it('records why it degraded, which exit 2 alone cannot say', () => {
    const bin = dir('delegate-noauth-');
    const timeline = join(dir('delegate-degraded-timeline-'), 'iteration.events.jsonl');
    writeFileSync(
      join(bin, 'opencode'),
      ['#!/usr/bin/env bash', '[ "$1" = "auth" ] && { echo "Anthropic"; exit 0; }', 'exit 0'].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);

    const run = delegate(bin, { RALPH_TIMELINE: timeline });

    expect(run.status).toBe(2);
    expect(run.observations[0]).toMatchObject({
      stage: 'executor',
      exitCode: 2,
      kind: 'authentication',
      visibility: 'post-hoc',
    });
    expect(JSON.parse(readFileSync(timeline, 'utf8'))).toMatchObject({
      type: 'ralph_stage',
      ralph_stage: 'executor',
      state: 'degraded',
      runner: 'opencode',
    });
  });
});

/**
 * A fake `claude` that answers `auth status --json` and, for `-p`, records its
 * argv and a few facts about its environment before emitting `events` as the
 * stream-json lines the real harness emits.
 *
 * The argv record is the seam the session assertions read: `delegate.sh` must
 * name a session on the first round and resume THAT session on a `--continue`,
 * and must start the process with the rails flag and with no MCP server.
 */
function fakeClaude(events: string[], options: { loggedIn?: boolean; argvLog?: string } = {}): string {
  const bin = dir('delegate-claude-bin-');
  const loggedIn = options.loggedIn ?? true;
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env bash',
      `[ "$1" = "auth" ] && { echo '{"loggedIn": ${loggedIn}, "authMethod": "claude.ai"}'; exit 0; }`,
      ...(options.argvLog
        ? [
            `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(options.argvLog)}`,
            `printf 'ENV OPENCODE_CONFIG=%s OPENCODE_DB=%s RALPH_MODEL_EXECUTOR=%s CANARY_SECRET_TOKEN=%s HOME=%s\\n' "\${OPENCODE_CONFIG:-unset}" "\${OPENCODE_DB:-unset}" "\${RALPH_MODEL_EXECUTOR:-unset}" "\${CANARY_SECRET_TOKEN:-unset}" "\${HOME:-unset}" >> ${JSON.stringify(options.argvLog)}`,
          ]
        : []),
      ...events.map((event) => `printf '%s\\n' ${JSON.stringify(event)}`),
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

const claudeEnv = { RALPH_RUNNER_EXECUTOR: 'claude', RALPH_MODEL_EXECUTOR: 'claude-sonnet-5' };

const claudeToolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const claudeToolResult = (id: string, content: string, isError = false): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const claudeResult = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    session_id: '11111111-2222-4333-8444-555555555555',
    result: 'Done.',
    usage: { input_tokens: 4, output_tokens: 83, cache_read_input_tokens: 61919, cache_creation_input_tokens: 24983 },
    permission_denials: [],
    ...extra,
  });

describe('the claude runner', () => {
  it('records a refusal the harness kept for it, even though the delegation exited 0', () => {
    // `claude -p` under `--dangerously-skip-permissions` still refuses what the
    // settings file denies, reports it as the tool result's own error, and
    // exits 0 — the same clean-exit-that-did-nothing the opencode branch is
    // instrumented for. The `result` event ALSO lists it under
    // `permission_denials`; one refusal must become one signal, not two.
    const timeline = join(dir('delegate-claude-timeline-'), 'iteration.events.jsonl');
    const run = delegate(
      fakeClaude([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-2222-4333-8444-555555555555' }),
        claudeToolUse('toolu_1', 'Bash', { command: 'gh --version' }),
        claudeToolResult('toolu_1', 'Permission to use Bash with command gh --version has been denied.', true),
        claudeResult({
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'gh --version' } }],
        }),
      ]),
      { ...claudeEnv, RALPH_TIMELINE: timeline },
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('→ Bash: gh --version');
    expect(run.stdout.match(/!! permission-denied/g)).toHaveLength(1);
    expect(run.observations).toHaveLength(1);
    expect(run.observations[0]).toMatchObject({
      stage: 'executor',
      runner: 'claude',
      model: 'claude-sonnet-5',
      exitCode: 0,
      kind: 'permission-denied',
      loop: 'rafa',
      run: 'rafa-run-delegate-test',
    });
    const events = readFileSync(timeline, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.type === 'ralph_stage').map((event) => event.runner)).toEqual(['claude', 'claude']);
  });

  it('names one session for the run and resumes it on a continuation', () => {
    const argvLog = join(dir('delegate-claude-argv-'), 'argv');
    const logDir = dir('delegate-claude-logs-');
    const bin = fakeClaude([claudeResult()], { argvLog });

    // A secret in the ORCHESTRATOR's environment is the thing `env -i` exists
    // to withhold; the fake reports whether it arrived.
    const secret = { CANARY_SECRET_TOKEN: 'canary-0123456789abcdef' };
    expect(delegate(bin, { ...claudeEnv, ...secret, RALPH_LOG_DIR: logDir }).status).toBe(0);
    expect(delegate(bin, { ...claudeEnv, ...secret, RALPH_LOG_DIR: logDir }, true).status).toBe(0);

    const lines = readFileSync(argvLog, 'utf8').trim().split('\n');
    const argv = lines.filter((line) => line.startsWith('ARGV '));
    expect(argv).toHaveLength(2);
    const first = /--session-id ([0-9a-f-]{36})/.exec(argv[0]!);
    expect(first).not.toBeNull();
    expect(argv[0]).not.toContain('--resume');
    expect(argv[1]).toContain(`--resume ${first![1]}`);
    expect(argv[1]).not.toContain('--session-id');
    for (const line of argv) {
      // The rails travel as flags, and the executor loads no MCP server: the
      // project's `.mcp.json` and the user's global config carry database
      // servers with write tools, which no line of the denylist names.
      expect(line).toContain('--settings ');
      expect(line).toContain('claude-executor-settings.json');
      expect(line).toContain('--dangerously-skip-permissions');
      expect(line).toContain('--strict-mcp-config');
      expect(line).toContain('--setting-sources project');
      expect(line).toContain('--model claude-sonnet-5');
      expect(line).toContain('--output-format stream-json');
    }
    // Nothing of the opencode branch leaks into this process's environment.
    const env = lines.filter((line) => line.startsWith('ENV '));
    expect(
      env.every(
        (line) =>
          line.includes('OPENCODE_CONFIG=unset') &&
          line.includes('OPENCODE_DB=unset') &&
          line.includes('RALPH_MODEL_EXECUTOR=unset') &&
          line.includes('CANARY_SECRET_TOKEN=unset'),
      ),
    ).toBe(true);
    expect(env.every((line) => line.includes(`HOME=${process.env.HOME ?? ''}`))).toBe(true);
  });

  it('starts a fresh session when the recorded one is not a UUID', () => {
    const argvLog = join(dir('delegate-claude-argv-'), 'argv');
    const logDir = dir('delegate-claude-logs-');
    mkdirSync(join(logDir, 'claude-executor'), { recursive: true });
    writeFileSync(join(logDir, 'claude-executor', 'rafa-run-delegate-test.session'), 'garbage\n');
    const bin = fakeClaude([claudeResult()], { argvLog });

    const run = delegate(bin, { ...claudeEnv, RALPH_LOG_DIR: logDir }, true);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain('not a UUID');
    const argv = readFileSync(argvLog, 'utf8').split('\n').find((line) => line.startsWith('ARGV '));
    expect(argv).toMatch(/--session-id [0-9a-f-]{36}/);
    expect(argv).not.toContain('--resume');
  });

  it('degrades when claude is not logged in, and says so in the record', () => {
    const run = delegate(fakeClaude([], { loggedIn: false }), claudeEnv);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('claude auth login');
    expect(run.observations[0]).toMatchObject({
      stage: 'executor',
      runner: 'claude',
      exitCode: 2,
      kind: 'authentication',
      visibility: 'post-hoc',
    });
  });
});

/**
 * The executor's time budget.
 *
 * On 2026-09-23 five Codex executor runs were killed at a flat 900s while they
 * were still making progress, and rafa #1107's orchestrator stopped waiting on
 * a run before the run's own timeout. The budget a brief declares must reach
 * both sides — the executor as a deadline it can see, the orchestrator as a
 * wait it has to cover — and a run that is killed anyway must leave its
 * partial work somewhere the orchestrator can pick it up.
 */
describe("the executor's time budget", () => {
  /** A fake opencode that records the message it was given, edits a file, then optionally hangs. */
  function recordingOpencode(messageLog: string, hangSeconds = 0): string {
    const bin = dir('delegate-budget-bin-');
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\necho "fake opencode test reached claude" >&2; exit 99\n');
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(
      join(bin, 'opencode'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }',
        `for last; do :; done; printf '%s' "$last" > ${JSON.stringify(messageLog)}`,
        'printf "half done\\n" >> tracked.txt',
        `printf '%s\\n' ${JSON.stringify(JSON.stringify({ type: 'text', part: { text: 'editing tracked.txt' } }))}`,
        ...(hangSeconds > 0 ? [`exec sleep ${hangSeconds}`] : []),
        'exit 0',
      ].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);
    return bin;
  }

  /** `delegate()` with a brief of our own, in a project that is a git repository. */
  function delegateBrief(bin: string, brief: string, env: Record<string, string> = {}) {
    const projectRoot = project();
    const git = (...args: string[]) => spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(projectRoot, 'tracked.txt'), 'start\n');
    git('add', 'tracked.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const logDir = dir('delegate-budget-logs-');
    const briefFile = join(dir('delegate-budget-brief-'), 'brief.md');
    writeFileSync(briefFile, brief);
    const started = Date.now();
    const result = spawnSync('bash', [join(ROOT, 'delegate.sh'), briefFile], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RALPH_RUNNER_FAILURE_LOG: join(dir('delegate-budget-record-'), 'runner-failures.jsonl'),
        RALPH_LOOP_NAME: 'rafa',
        RALPH_RUNNER_EXECUTOR: 'opencode',
        RALPH_MODEL_EXECUTOR: 'opencode-go/deepseek-v4-flash',
        RALPH_RUN_ID: 'rafa-run-budget-test',
        RALPH_LOG_DIR: logDir,
        RALPH_PROJECT: projectRoot,
        RALPH_DELEGATE_TIMEOUT: '',
        RALPH_DELEGATE_MAX_TIMEOUT: '',
        ...env,
      },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      elapsedMs: Date.now() - started,
      logDir,
    };
  }

  it('tells the executor the budget its brief declared, and the orchestrator how long to wait', () => {
    const messageLog = join(dir('delegate-budget-msg-'), 'message.txt');
    const run = delegateBrief(recordingOpencode(messageLog), '# Round\n\nBudget: 1200s\n\nEdit tracked.txt.\n');

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/timeout 1200s/);
    expect(run.stdout).toMatch(/budget: 1200s \(brief\), wrap-up at 960s/);
    expect(run.stdout).toMatch(/done-file: .*delegate-\d{8}T\d{6}\.log\.exit/);
    const message = readFileSync(messageLog, 'utf8');
    expect(message).toMatch(/Time budget/);
    expect(message).toMatch(/1200s/);
    expect(message).toMatch(/Edit tracked\.txt\./);
  });

  it('writes the exit code to the done-file when it finishes', () => {
    const messageLog = join(dir('delegate-budget-msg-'), 'message.txt');
    const run = delegateBrief(recordingOpencode(messageLog), '# Round\n');
    const doneFile = /done-file: (\S+)/.exec(run.stdout)?.[1] ?? '';
    expect(doneFile.startsWith(run.logDir)).toBe(true);
    expect(readFileSync(doneFile, 'utf8').trim()).toBe('0');
  });

  it('preserves and summarizes the partial diff of an executor it had to kill', () => {
    const messageLog = join(dir('delegate-budget-msg-'), 'message.txt');
    const run = delegateBrief(recordingOpencode(messageLog, 30), '# Round\n', { RALPH_DELEGATE_TIMEOUT: '3' });

    expect(run.status).toBe(4);
    expect(run.elapsedMs).toBeLessThan(25_000);
    expect(run.stderr).toMatch(/TIMED OUT after 3s/);
    const partial = /partial diff: (\S+)/.exec(run.stderr)?.[1] ?? '';
    expect(partial).not.toBe('');
    expect(readFileSync(partial, 'utf8')).toMatch(/\+half done/);
    expect(run.stderr).toMatch(/last executor activity/);
    expect(run.stderr).toMatch(/editing tracked\.txt/);
    const doneFile = /done-file: (\S+)/.exec(run.stdout)?.[1] ?? '';
    expect(readFileSync(doneFile, 'utf8').trim()).toBe('4');
  }, 60_000);
});
