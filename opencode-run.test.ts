// @vitest-environment node
/**
 * What the opencode watchdog kills, and — the half that matters more — what it
 * refuses to kill.
 *
 * `ralph/opencode-run.sh` exists to end one failure: opencode bootstraps, logs
 * `init`, and then never reaches the model. Every assertion here is written
 * against a FAKE opencode and a FAKE log, because the real pair cannot be made
 * to hang on demand and the contract under test is not opencode's — it is the
 * watchdog's reading of the evidence.
 *
 * The cases that stand the watchdog down are not politeness. A guard that
 * cannot see its evidence and kills anyway would end healthy work that runs
 * for minutes by design, which is worse than the hang it replaces — so
 * "no log", "cannot attribute", and "two candidates" each get their own test.
 */
import { describe, expect, it } from 'vitest';

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from './test-scratch';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs opencode-run.sh through bash');

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPT = join(HERE, 'opencode-run.sh');
const PTY_RUN = join(HERE, 'pty-run.py');

/** A line shaped like the one opencode writes when it starts in a directory. */
const creating = (runId: string, root: string): string =>
  `timestamp=2026-08-27T16:33:45.162Z level=INFO run=${runId} message="creating instance" directory=${root}`;

/** The line that says a request reached the provider. The liveness signal. */
const streaming = (runId: string): string =>
  `timestamp=2026-08-27T16:33:47.000Z level=INFO run=${runId} message=stream providerID=opencode-go modelID=x`;

interface Harness {
  dir: string;
  root: string;
  logFile: string;
  binDir: string;
}

/**
 * A throwaway world: a worktree root, an XDG data home with opencode's log
 * inside it, and a `bin` this run's PATH puts first.
 */
const harness = (): Harness => {
  const dir = scratchDir('opencode-run-');
  const root = join(dir, 'worktree');
  const binDir = join(dir, 'bin');
  const logDir = join(dir, 'data', 'opencode', 'log');
  mkdirSync(root, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'opencode.log');
  writeFileSync(logFile, 'timestamp=2026-08-27T10:00:00.000Z level=INFO run=old message=init\n');
  return { dir, root, logFile, binDir };
};

/**
 * Install a fake `opencode`.
 *
 * `behaviour` is a shell fragment run after the fake has written whatever log
 * lines the case needs. Writing the log from inside the fake is deliberate:
 * the watchdog only counts lines that appear AFTER it took its mark, so a fake
 * that wrote them up front would prove nothing about attribution.
 */
const fakeOpencode = (h: Harness, logLines: string[], behaviour: string): void => {
  const bin = join(h.binDir, 'opencode');
  const lines = logLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)} >> "${h.logFile}"`).join('\n');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' "\${OPENCODE_DISABLE_MODELS_FETCH:-unset}" > "${join(h.dir, 'models-fetch')}"
printf '%s\\n' "\${OPENCODE_DISABLE_PRUNE:-unset}" > "${join(h.dir, 'prune')}"
printf '%s\\n' "\${OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:-unset}" > "${join(h.dir, 'filewatcher')}"
attempt="$(cat "${join(h.dir, 'attempts')}" 2>/dev/null || printf '0')"
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "${join(h.dir, 'attempts')}"
${lines}
${behaviour}
`,
  );
  chmodSync(bin, 0o755);
};

const run = (h: Harness, env: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT, h.root, 'run', '--dir', h.root], {
    encoding: 'utf8',
    env: {
      // Inherited rather than replaced, so the harness under test runs the way
      // the suite runs. The fake is first on PATH, which is the only part of
      // the environment these cases actually control.
      ...process.env,
      PATH: `${h.binDir}:${process.env.PATH ?? ''}`,
      HOME: h.dir,
      XDG_DATA_HOME: join(h.dir, 'data'),
      RALPH_OPENCODE_FIRST_STREAM_SECONDS: '2',
      RALPH_OPENCODE_DIAGNOSTICS: '0',
      ...env,
    },
  });

const attempts = (h: Harness): number =>
  Number(readFileSync(join(h.dir, 'attempts'), 'utf8').trim());

// Every case here spawns a real bash process that deliberately stalls, so the
// default 5s per-test budget is too small by construction.
describe('opencode-run.sh', () => {
  it('waits for the harness exit after a normal PTY EOF', () => {
    const result = spawnSync(
      'python3',
      [PTY_RUN, 'bash', '-c', 'exec >/dev/null 2>&1; sleep 1; exit 7'],
      { encoding: 'utf8', timeout: 3_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
  });

  it('reaps the harness when the relay cannot write its output', () => {
    const h = harness();
    const pidFile = join(h.dir, 'relay-child.pid');
    const childHarness = join(h.binDir, 'relay-child');
    writeFileSync(
      childHarness,
      `#!/usr/bin/env bash
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf 'EVENT\n'
sleep 60
`,
    );
    chmodSync(childHarness, 0o755);

    const result = spawnSync(
      'bash',
      ['-c', 'exec 1>&-; exec python3 "$1" "$2"', 'relay-test', PTY_RUN, childHarness],
      { encoding: 'utf8', timeout: 3_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('flushes a harness event while the run is still open', async () => {
    const h = harness();
    fakeOpencode(
      h,
      [creating('live111', h.root), streaming('live111')],
      `exec python3 -c 'import time; print("LIVE_EVENT"); time.sleep(2)'`,
    );
    const child = spawn('bash', [SCRIPT, h.root, 'run', '--dir', h.root], {
      env: {
        ...process.env,
        PATH: `${h.binDir}:${process.env.PATH ?? ''}`,
        HOME: h.dir,
        XDG_DATA_HOME: join(h.dir, 'data'),
        RALPH_OPENCODE_FIRST_STREAM_SECONDS: '2',
        RALPH_OPENCODE_DIAGNOSTICS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('event stayed buffered while the harness was still running')),
          1_000,
        );
        child.stdout.on('data', () => {
          if (!stdout.includes('LIVE_EVENT')) return;
          clearTimeout(timeout);
          resolve();
        });
      });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('close', () => resolve()));
    }
  });

  it('passes a healthy run through untouched, with its stdout and exit code', () => {
    const h = harness();
    fakeOpencode(h, [creating('aaa111', h.root), streaming('aaa111')], `printf 'EVENT\\n'; exit 0`);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EVENT');
    expect(attempts(h)).toBe(1);
  });

  it('leaves a run that fails on its own to its caller, and does not retry it', () => {
    const h = harness();
    fakeOpencode(h, [creating('bbb222', h.root), streaming('bbb222')], `exit 7`);

    const result = run(h);

    // 7, not 124 and not 0: a harness that answered is not this file's
    // business, and re-running it could repeat work it had already done.
    expect(result.status).toBe(7);
    expect(attempts(h)).toBe(1);
  });

  it('kills a run that never reaches the model, and retries it exactly once', () => {
    const h = harness();
    fakeOpencode(h, [creating('ccc333', h.root)], `sleep 60`);

    const result = run(h);

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('no request reached the model');
    expect(result.stderr).toContain('hung twice');
    expect(attempts(h)).toBe(2);
  });

  it('recovers when the retry reaches the model', () => {
    const h = harness();
    const bin = join(h.binDir, 'opencode');
    fakeOpencode(h, [], '');
    // Attempt 1 hangs with no stream line; attempt 2 behaves. This is the
    // whole point of the retry: the killed attempt reached no model, so it did
    // nothing a second run would repeat.
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
attempt="$(cat "${join(h.dir, 'attempts')}" 2>/dev/null || printf '0')"
attempt=$((attempt + 1))
printf '%s\\n' "$attempt" > "${join(h.dir, 'attempts')}"
if [ "$attempt" = "1" ]; then
  printf '%s\\n' ${JSON.stringify(creating('ddd444', h.root))} >> "${h.logFile}"
  sleep 60
fi
printf '%s\\n' ${JSON.stringify(creating('eee555', h.root))} >> "${h.logFile}"
printf '%s\\n' ${JSON.stringify(streaming('eee555'))} >> "${h.logFile}"
printf 'RECOVERED\\n'
exit 0
`,
    );
    chmodSync(bin, 0o755);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RECOVERED');
    expect(result.stderr).toContain('opencode-run: watchdog-killed:');
    expect(attempts(h)).toBe(2);
  });

  it('spares a busy run whose stream line it never recognised', () => {
    const h = harness();
    // Everything opencode writes while working EXCEPT the one line the direct
    // signal looks for — which is what a release that renamed that line would
    // look like. Without the second opinion this run dies at the window, and
    // so would every healthy stage on the machine.
    const chatter = Array.from({ length: 25 }, (_, i) =>
      `timestamp=2026-08-27T16:33:4${i % 10}.000Z level=INFO run=0a3333 message=loop step=${i}`,
    );
    fakeOpencode(h, [creating('0a3333', h.root), ...chatter], `sleep 3; printf 'BUSY\\n'; exit 0`);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('BUSY');
    expect(attempts(h)).toBe(1);
  });

  it('still kills a run whose chatter stays under the silence floor', () => {
    const h = harness();
    // Twelve lines and no stream line: the observed hang, exactly.
    const bootstrap = Array.from({ length: 11 }, (_, i) =>
      `timestamp=2026-08-27T16:33:45.16${i}Z level=INFO run=0b4444 message=init`,
    );
    fakeOpencode(h, [creating('0b4444', h.root), ...bootstrap], `sleep 60`);

    const result = run(h);

    expect(result.status).toBe(124);
    expect(attempts(h)).toBe(2);
  });

  it('spares a run it cannot attribute, when that run finishes on its own', () => {
    const h = harness();
    // A slow run that never announces itself in the log at all. There is no
    // evidence it hung, so there is no licence to kill it. Asserted on the
    // outcome rather than on a stand-down message, because the run being
    // unattributable is no longer by itself a reason to let go — see the two
    // cases below, which decide it on whether the run is still writing.
    fakeOpencode(h, [], `sleep 3; printf 'SLOW\\n'; exit 0`);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SLOW');
    expect(attempts(h)).toBe(1);
  });

  it('kills an unattributable run that has stopped writing entirely', () => {
    const h = harness();
    // THE PRODUCTION HANG, reproduced. opencode opened its log and its
    // database, wrote during startup, and then blocked forever holding both —
    // without ever writing the `creating instance` line the other two measures
    // identify a run by. So there was no candidate, no attribution, and the
    // watchdog stood down on the one failure it exists to catch.
    //
    // The fake writes at startup and then goes silent, which is the shape that
    // matters: a measure that asked "has it written anything at all" would be
    // satisfied by the startup writes and spare it.
    fakeOpencode(h, [], `printf 'BOOT\\n' > "$HOME/boot"; sleep 60`);

    const result = run(h, { RALPH_OPENCODE_STALL_SECONDS: '4' });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('wrote nothing for 4s');
    // Killed, retried once, killed again — the same contract as an
    // attributable hang.
    expect(attempts(h)).toBe(2);
  });

  it('captures a bounded native stack before killing a stalled run', () => {
    const h = harness();
    const diagnostics = join(h.dir, 'diagnostics');
    fakeOpencode(h, [], `printf 'BOOT\\n' > "$HOME/boot"; sleep 60`);
    writeFileSync(
      join(h.binDir, 'eu-stack'),
      '#!/usr/bin/env bash\nprintf "STACK pid=%s\\n" "$2"\n',
    );
    chmodSync(join(h.binDir, 'eu-stack'), 0o755);

    const result = run(h, {
      RALPH_OPENCODE_DIAGNOSTICS: '1',
      RALPH_OPENCODE_DIAGNOSTICS_DIR: diagnostics,
      RALPH_OPENCODE_STALL_SECONDS: '3',
    });

    expect(result.status).toBe(124);
    const captures = readdirSync(diagnostics);
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const diagnostic = readFileSync(join(diagnostics, captures[0]!), 'utf8');
    expect(diagnostic).toContain('STACK pid=');
    expect(diagnostic).toContain(`command: bash ${join(h.binDir, 'opencode')}`);
    expect(diagnostic).not.toContain('command: python3');
    expect(result.stderr).toContain('captured hang diagnostics');
  });

  it('spares an unattributable run that is still writing', () => {
    const h = harness();
    // A run waiting on a slow provider is still doing IO, and one whose log
    // line we simply cannot match is not thereby a hang. This must outlive the
    // stall window without being touched, or the watchdog kills healthy work
    // whenever the log format moves under it.
    fakeOpencode(h, [], `for i in 1 2 3 4 5 6 7 8; do printf 'TICK\\n'; sleep 1; done; exit 0`);

    const result = run(h, { RALPH_OPENCODE_STALL_SECONDS: '3' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TICK');
    expect(attempts(h)).toBe(1);
  });

  it('stands down when two runs in the same worktree are candidates', () => {
    const h = harness();
    // Two `creating instance` lines for one root: a stage running beside this
    // one. Either could be the hung one, so neither is killed.
    fakeOpencode(h, [creating('fff666', h.root), creating('0b7777', h.root)], `sleep 3; printf 'AMBIGUOUS\\n'; exit 0`);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AMBIGUOUS');
    expect(attempts(h)).toBe(1);
  });

  it('ignores a run belonging to another worktree', () => {
    const h = harness();
    // The only candidate names a different root, so it is not ours, and an
    // unattributable run is never killed.
    fakeOpencode(h, [creating('0c8888', '/somewhere/else')], `sleep 3; printf 'OTHER\\n'; exit 0`);

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OTHER');
    expect(attempts(h)).toBe(1);
  });

  it('stands down when there is no log to read', () => {
    const h = harness();
    fakeOpencode(h, [], `sleep 3; printf 'NOLOG\\n'; exit 0`);

    const result = run(h, { XDG_DATA_HOME: join(h.dir, 'absent') });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('NOLOG');
    expect(attempts(h)).toBe(1);
  });

  it('can be switched off entirely', () => {
    const h = harness();
    fakeOpencode(h, [creating('0d9999', h.root)], `sleep 3; printf 'UNWATCHED\\n'; exit 0`);

    const result = run(h, { RALPH_OPENCODE_WATCHDOG: '0' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('UNWATCHED');
    expect(attempts(h)).toBe(1);
  });

  it('turns off the boot-time work that can hang', () => {
    const h = harness();
    fakeOpencode(h, [creating('0e0000', h.root), streaming('0e0000')], `exit 0`);

    run(h);

    expect(readFileSync(join(h.dir, 'models-fetch'), 'utf8').trim()).toBe('1');
    expect(readFileSync(join(h.dir, 'prune'), 'utf8').trim()).toBe('1');
    expect(readFileSync(join(h.dir, 'filewatcher'), 'utf8').trim()).toBe('1');
  });

  it('keeps an operator\'s own value for those switches', () => {
    const h = harness();
    fakeOpencode(h, [creating('0f1111', h.root), streaming('0f1111')], `exit 0`);

    run(h, {
      OPENCODE_DISABLE_MODELS_FETCH: '0',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '0',
    });

    expect(readFileSync(join(h.dir, 'models-fetch'), 'utf8').trim()).toBe('0');
    expect(readFileSync(join(h.dir, 'filewatcher'), 'utf8').trim()).toBe('0');
  });

  it('refuses a malformed first-stream window rather than treating it as zero', () => {
    const h = harness();
    // A zero window would make every run "hung" the instant it started. The
    // fake below streams immediately, so the only way this passes is if the
    // bad value was replaced by the default rather than by 0.
    fakeOpencode(h, [creating('0a2222', h.root), streaming('0a2222')], `printf 'FINE\\n'; exit 0`);

    const result = run(h, { RALPH_OPENCODE_FIRST_STREAM_SECONDS: 'soon' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FINE');
  });

  it('refuses to run without a root', () => {
    const result = spawnSync('bash', [SCRIPT, 'run'], { encoding: 'utf8' });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('usage');
  });
}, 30_000);
