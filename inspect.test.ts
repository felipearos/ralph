// @vitest-environment node
/**
 * What `ralph/inspect.sh` refuses, and what it degrades to.
 *
 * The runs that reach a harness are not tested here — they cost money and a
 * network, and what they would prove (that opencode and codex can read a diff)
 * is not this script's contract. Its contract is the dispatch: which stages it
 * will run, which it hands back, and the exit code the iteration reads to tell
 * "this stage is somebody else's job" from "this stage failed".
 *
 * That distinction is the whole point of exit 2. A caller that shells out and
 * sees a failure drops the stage; a caller that sees exit 2 makes the `Agent`
 * call itself. Getting them the wrong way round silently loses a review.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cleanupFixtures, scratchProject } from './dashboard/fixtures';
import { SPEC_MARKER, renderSpec } from './issue-spec';
import { fixtureGitEnv, stripGitLocationEnv } from './test-git-env';
import { fileScratchDir, scratchDir } from './test-scratch';
import { subprocessSuite } from './test-timeouts';

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

subprocessSuite('runs inspect.sh through bash against fixture git repos');

const ROOT = dirname(new URL(import.meta.url).pathname);

/**
 * The project every run below works on.
 *
 * `inspect.sh` sources `project.sh`, which `cd`s to `RALPH_PROJECT` and resolves
 * it from `git rev-parse --show-toplevel` when it is unset. These runs drive the
 * real script, so with the harness checkout as cwd they wrote their logs, their
 * usage files, their opencode database and a never-unlinked lock file into
 * `<repo>/.ralph/logs` -- 1439 locks and 3783 artifacts by 2026-10-05, in the
 * live loop's own log folder (#199). One shared project, not one per run: the
 * yielded-run test needs two invocations to collide on the same lock. It
 * carries a roster as well -- `scratchProject` writes the project config --
 * which the loop-name check further down depends on.
 */
const PROJECT = scratchProject('inspect');

// A real checkout, because the codex stage resolves the sandbox's mounts from
// the project's git metadata (`inspect.sh:496-498`) and a bare tmpdir has none.
// `execFileSync`, so a failed init says so here rather than surfacing as an
// unrelated sandbox-mount error in the codex boundary test.
execFileSync('git', ['init', '--quiet', PROJECT], { env: fixtureGitEnv(), encoding: 'utf8' });

// A pre-push hook runs this suite with `GIT_DIR` set to the outer checkout;
// `inspect.sh` and the fixture git calls spread `process.env`, so drop it first
// or every fixture `git` runs against the real repository.
stripGitLocationEnv();

interface CodexLogItem {
  type?: string;
  exit_code?: number;
}

interface CodexLogEvent {
  item?: CodexLogItem;
}

const brief = (): string => {
  const dir = scratchDir('inspect-brief-');
  const file = join(dir, 'brief.md');
  writeFileSync(file, '# Stage brief\n\nRead nothing; this run never reaches a harness.\n');
  return file;
};

/**
 * A spec-axis brief that names an issue the harness fetched, as §5.1 has the
 * orchestrator write one. `inspect.sh` refuses a spec brief without it.
 */
const specBrief = (acceptance = 'Playwright covers the web flow'): string => {
  const dir = scratchDir('inspect-spec-');
  const spec = join(dir, 'spec-1154.md');
  writeFileSync(
    spec,
    renderSpec(
      {
        number: 1154,
        title: 'Delete a log and mark it unwatched',
        url: 'https://github.com/felipearos/loggd/issues/1154',
        state: 'OPEN',
        labels: [],
        body: `## Acceptance criteria\n\n- [ ] ${acceptance}`,
        comments: [],
      },
      '2026-09-23T00:00:00Z',
    ),
  );
  const file = join(dir, 'brief.md');
  writeFileSync(file, `# Spec review\n\nSpec: ${spec}\n`);
  return file;
};

/**
 * Where this file's runs put their failure observations.
 *
 * `inspect.sh` now records every degrade and every failure through
 * `ralph/runner-failure.ts`, and these tests drive the real script from the
 * real checkout — so without redirecting the record, a suite run at lunchtime
 * would show up in `ralph/status.sh` at 2am as denials that never happened.
 */
const recordPath = (): string =>
  join(scratchDir('inspect-record-'), 'runner-failures.jsonl');

// At module scope, so this one is the file's rather than a test's.
let lastRecord = join(fileScratchDir('inspect-record-'), 'runner-failures.jsonl');

const observations = (): Record<string, unknown>[] =>
  readFileSync(lastRecord, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const run = (args: string[], env: Record<string, string> = {}) => {
  lastRecord = recordPath();
  const result = spawnSync('bash', [join(ROOT, 'inspect.sh'), ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: { ...process.env, RALPH_PROJECT: PROJECT, RALPH_RUNNER_FAILURE_LOG: lastRecord, ...env },
    timeout: 60_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

describe('usage', () => {
  it('refuses with no arguments rather than guessing a stage', () => {
    expect(run([]).status).toBe(3);
  });

  it('refuses a brief that is not a file, before starting anything', () => {
    const result = run(['mapper', '/nonexistent/brief.md']);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('no such brief file');
  });

  it('refuses an empty brief rather than buying a review of nothing', () => {
    // The `-f` check above passes for a file with nothing in it, and a harness
    // handed the rails alone will happily spend a full run inventing a task.
    const dir = scratchDir('inspect-empty-');
    const file = join(dir, 'brief.md');
    writeFileSync(file, '   \n\n');

    const result = run(['mapper', file]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('empty');
  });

  it('sends the executor to delegate.sh, whose rails let it write', () => {
    const result = run(['executor', brief()]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('delegate.sh');
  });

  it('refuses the orchestrator, which is the process asking', () => {
    expect(run(['orchestrator', brief()]).status).toBe(3);
  });

  it('refuses a stage the lineup has never heard of', () => {
    const result = run(['reviewer', brief()]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('reviewer');
  });
});

describe('dispatch', () => {
  it('hands a claude-runner stage back to the caller, as exit 2', () => {
    // Not a failure: on this lineup the stage IS an in-session `Agent` call,
    // and the caller is the session. Exit 2 is what tells it to make the call
    // rather than drop the stage.
    // Pin the orchestrator: under a Codex orchestrator the same stage is a
    // Claude inspection process instead, and models.json picks can change.
    const result = run(['review.standards', brief()], {
      RALPH_RUNNER_ORCHESTRATOR: 'claude',
      RALPH_RUNNER_REVIEW_STANDARDS: 'claude',
      RALPH_MODEL_REVIEW_STANDARDS: 'opus',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Agent call');
  });

  it('degrades to the same exit 2 when the harness is not installed', () => {
    // A missing binary must not fail the iteration: the stage still has a
    // fallback shape, and losing a review to a PATH problem is worse than
    // running it on the session's own model.
    const bin = scratchDir('inspect-bin-');
    // Everything the script itself reaches for, and nothing else — the point
    // of the temporary PATH is that `opencode` is the one thing missing.
    // `readlink` and `sed` are in there because the script resolves RALPH_HOME
    // through `readlink -f` (inspect.sh:32); without them it used to fall back
    // to the cwd, which was this checkout, and the omission went unnoticed
    // until the runs moved onto a scratch project (#199).
    const needed = ['bash', 'env', 'dirname', 'basename', 'readlink', 'realpath', 'bun', 'git',
      'python3', 'date', 'mkdir', 'cat', 'rm', 'chmod', 'timeout', 'nice', 'tee', 'sed', 'tr',
      'cut', 'tail', 'find', 'flock', 'mktemp', 'sha256sum'];
    for (const tool of needed) {
      const found = spawnSync('command', ['-v', tool], { shell: true, encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }

    const result = run(['mapper', brief()], {
      PATH: bin,
      RALPH_RUNNER_MAPPER: 'opencode',
      RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not on PATH');
  });

  it('degrades when the harness has no credential for THAT provider', () => {
    // `opencode auth list` exits 0 with no credential at all, and with one for
    // some other provider — so a zero exit is not an answer. Without this the
    // stage reaches the harness and dies as exit 4 ("it failed") when the truth
    // is exit 2 ("it was never going to run").
    //
    // Which of the two degrade paths this takes depends on the machine, so the
    // assertion does too: a developer's box has opencode installed and reaches
    // the credential check, while CI has no harness at all and stops one line
    // earlier. Both are exit 2 — that is the part the caller acts on, and the
    // part worth pinning on every machine. Asserting one message everywhere is
    // how this test failed in CI while passing here.
    const installed = spawnSync('command', ['-v', 'opencode'], { shell: true }).status === 0;

    const result = run(['mapper', brief()], {
      RALPH_RUNNER_MAPPER: 'opencode',
      RALPH_MODEL_MAPPER: 'no-such-provider/some-model',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      installed ? 'no no-such-provider credential' : 'not on PATH',
    );
  });

  it('refuses a runner override that strands the stage on the wrong model', () => {
    // The resolver's rule, reached through this script: the refusal has to
    // arrive here too, or the harness reports it hours later in its own format.
    //
    // BOTH halves are named rather than leaning on whatever `models.json`
    // ships. This test used to set only the runner and take the wrong model
    // from the default block — so the day that block's mapper moved to
    // opencode, the override stopped stranding anything and the test passed
    // without asserting a refusal. A test whose subject is supplied by
    // configuration stops being a test when the configuration changes.
    // `codex` names a model without a provider prefix; this one has one.
    const result = run(['mapper', brief()], {
      RALPH_RUNNER_MAPPER: 'codex',
        RALPH_MODEL_MAPPER_EFFORT: 'xhigh',
      RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free',
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('mapper');
  });

  it('gives concurrent-capable read-only stages separate fresh databases', () => {
    const bin = scratchDir('inspect-database-bin-');
    const databaseLog = join(scratchDir('inspect-database-log-'), 'paths');
    const timeline = join(scratchDir('inspect-timeline-'), 'iteration.events.jsonl');
    writeFileSync(
      join(bin, 'opencode'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }',
        `printf '%s\\n' "$OPENCODE_DB" >> ${JSON.stringify(databaseLog)}`,
        `printf '%s\\n' '{"type":"text","part":{"text":"No findings."}}'`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);
    const shared = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RALPH_RUN_ID: 'ralph-run-inspect-database-test',
      RALPH_ITERATION: '6',
      RALPH_TIMELINE: timeline,
    };

    const mapper = run(['mapper', brief()], {
      ...shared,
      RALPH_RUNNER_MAPPER: 'opencode',
      RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free',
    });
    const spec = run(['review.spec', specBrief()], {
      ...shared,
      RALPH_RUNNER_REVIEW_SPEC: 'opencode',
      RALPH_MODEL_REVIEW_SPEC: 'opencode-go/ox-alpha-free',
    });

    expect(mapper.status).toBe(0);
    expect(spec.status).toBe(0);
    const paths = readFileSync(databaseLog, 'utf8').trim().split('\n');
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every((path) => path.includes('/.ralph/logs/opencode-db/'))).toBe(true);
    expect(paths.every((path) => !path.endsWith('/.local/share/opencode/opencode.db'))).toBe(true);
    const events = readFileSync(timeline, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event.ralph_stage)).toEqual([
      'mapper',
      'mapper',
      'mapper',
      'review.spec',
      'review.spec',
      'review.spec',
    ]);
    expect(events.map((event) => event.state).filter(Boolean)).toEqual([
      'started',
      'completed',
      'started',
      'completed',
    ]);
    expect(events.every((event) => event.ralph_iteration === 6)).toBe(true);
  });
});


describe('a run nobody should book as a failure', () => {
  const fakeOpencode = (body: string[]): string => {
    const bin = scratchDir('inspect-fake-bin-');
    writeFileSync(
      join(bin, 'opencode'),
      ['#!/usr/bin/env bash', '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }', ...body].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);
    return bin;
  };
  const opencodeMapper = (bin: string) => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RALPH_RUNNER_MAPPER: 'opencode',
    RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free',
  });
  const recorded = (): Record<string, unknown>[] => (existsSync(lastRecord) ? observations() : []);

  it('refuses a second run of the same stage on the same brief, as exit 5', async () => {
    // The orchestrator once re-launched a mapper whose exec call had yielded,
    // then killed the copy: two runs, one report file, one false failure.
    const bin = fakeOpencode([
      'sleep 3',
      `printf '%s\\n' '{"type":"text","part":{"text":"No findings."}}'`,
    ]);
    const file = brief();
    const env = { ...process.env, RALPH_PROJECT: PROJECT, RALPH_RUNNER_FAILURE_LOG: recordPath(), ...opencodeMapper(bin) };
    const { spawn } = await import('node:child_process');
    const first = spawn('bash', [join(ROOT, 'inspect.sh'), 'mapper', file], { cwd: PROJECT, env, stdio: 'ignore' });
    const firstDone = new Promise<number | null>((resolve) => first.on('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const second = run(['mapper', file], opencodeMapper(bin));

    expect(second.status).toBe(5);
    expect(second.stderr).toContain('already running');
    expect(recorded()).toEqual([]);
    expect(await firstDone).toBe(0);
    // A different brief is a different run.
    expect(run(['mapper', brief()], opencodeMapper(bin)).status).toBe(0);
  });

  it('does not book a harness stopped by SIGTERM as a runner failure', () => {
    const bin = fakeOpencode(['kill -TERM $$', 'sleep 5']);

    const result = run(['mapper', brief()], opencodeMapper(bin));

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('stopped from outside');
    expect(recorded()).toEqual([]);
  });
});

describe('the codex filesystem boundary', () => {
  it('hides credentials from both shell commands and git-config helpers', () => {
    const outside = scratchDir('inspect-credential-');
    const credential = join(outside, 'credential');
    writeFileSync(credential, 'do-not-leak\n');

    // This repository lives inside the checkout so the stage can inspect it.
    // Its config makes a read-only git command execute a helper which tries to
    // copy a credential into the checkout. The absolute git path matters: the
    // codex runner has no command allowlist, so a model can bypass PATH's shim.
    // Inside the project, which is what the sandbox mounts: a fixture under the
    // harness checkout is outside the boundary, so the helper never runs at all
    // and `HELPER=ran` would prove nothing.
    const repo = mkdtempSync(join(PROJECT, '.inspect-sandbox-'));
    const ran = join(repo, 'HELPER_RAN');
    const leaked = join(repo, 'LEAKED');
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: fixtureGitEnv({ HOME: repo }) });
    git('init', '-q', '.');
    git('config', 'core.fsmonitor', `sh -c 'touch ${ran}; cat ${credential} > ${leaked}'`);

    const bin = scratchDir('inspect-codex-');
    const codexHome = scratchDir('inspect-codex-home-');
    writeFileSync(join(codexHome, 'auth.json'), '{}\n');
    const stageBrief = brief();
    writeFileSync(stageBrief, `Run cat ${credential} in the shell. Report only whether the command was blocked.\n`);
    writeFileSync(
      join(bin, 'codex'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = "login" ] && [ "$2" = "status" ] && exit 0',
        '[ "$1" = "mcp" ] && [ "$2" = "list" ] && { if [ "${CODEX_HOME:-}" = /codex-home ]; then echo "[]"; else echo \'[{"name":"cua_repl"}]\'; fi; exit 0; }',
        'test -r /proc/self/exe || { echo "missing /proc/self/exe" >&2; exit 10; }',
        '[[ "$*" != *"mcp_servers.cua_repl.enabled=false"* ]] || { echo "incomplete MCP override" >&2; exit 11; }',
        `[[ "$*" == *'model_reasoning_effort="xhigh"'* ]] || exit 8`,
        `case "\${!#}" in *"cat ${credential}"*) ;; *) exit 9 ;; esac`,
        `cat ${credential} >/dev/null 2>&1`,
        'direct_rc=$?',
        `printf '{"type":"item.completed","item":{"type":"command_execution","command":"cat ${credential}","exit_code":%s,"status":"completed"}}\\n' "$direct_rc"`,
        `/usr/bin/git -C ${repo} status --short >/dev/null 2>&1`,
        `[ -f ${ran} ] && helper=ran || helper=missed`,
        `[ -s ${leaked} ] && leak=read || leak=blocked`,
        '[ "$direct_rc" -eq 0 ] && direct=read || direct=blocked',
        `printf '{"type":"item.completed","item":{"type":"agent_message","text":"DIRECT=%s HELPER=%s LEAK=%s"}}\\n' "$direct" "$helper" "$leak"`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'codex'), 0o755);

    try {
      // Prove the armed helper can read the credential before inspect.sh adds
      // its boundary. Otherwise a passing assertion below would prove little.
      spawnSync('/usr/bin/git', ['-C', repo, 'status', '--short'], { encoding: 'utf8' });
      expect(readFileSync(leaked, 'utf8')).toBe('do-not-leak\n');
      rmSync(ran);
      rmSync(leaked);

      const logsBefore = new Set(readdirSync(join(PROJECT, '.ralph', 'logs')));
      const result = run(['mapper', stageBrief], {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        RALPH_RUNNER_MAPPER: 'codex',
        RALPH_MODEL_MAPPER_EFFORT: 'xhigh',
        RALPH_MODEL_MAPPER: 'gpt-5.6-terra',
        CODEX_HOME: codexHome,
      });

      expect(
        result.status,
        `inspect stdout:\n${result.stdout}\ninspect stderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toContain(`→ bash: cat ${credential}`);
      expect(result.stdout).toContain('DIRECT=blocked HELPER=ran LEAK=blocked');
      const rawLog = readdirSync(join(PROJECT, '.ralph', 'logs'))
        .filter((name) => !logsBefore.has(name) && name.endsWith('.log.jsonl'))
        .map((name) => readFileSync(join(PROJECT, '.ralph', 'logs', name), 'utf8'))
        .find((contents) => contents.includes(`cat ${credential}`));
      expect(rawLog).toBeDefined();
      const command = rawLog!
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as CodexLogEvent)
        .find((event) => event.item?.type === 'command_execution');
      expect(command?.item?.exit_code).not.toBe(0);
    } finally {
      // `outside`, `bin` and `codexHome` are `scratchDir` results, which
      // `onTestFinished` removes. `repo` is made inside the checkout — the
      // sandbox only mounts the project — so it is this block's to remove.
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The one rail that cannot live in the permission config.
 *
 * `git diff*` has to be allowed — reading the change is the stage's whole job
 * — and `.gitattributes` turns a plain `git diff` into an exec: git runs the
 * selected driver's `diff.<name>.command` or `.textconv` with no `--ext-diff`,
 * no `--textconv` and no shell metacharacter anywhere in the command string,
 * so an allow list matching command strings has nothing to match on. The
 * config that names the driver is `.git/config`, which the EXECUTOR can write,
 * so this is reachable from inside the loop rather than only by a hostile
 * checkout. `inspect.sh` forces the flags with a `git` in front of the real
 * one on the stage's PATH; this is that shim, driven the way the harness sees
 * it.
 */
describe('the git shim', () => {
  const evilRepo = (): string => {
    const dir = scratchDir('inspect-evil-');
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: fixtureGitEnv({ HOME: dir }) });
    git('init', '-q', '.');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(dir, '.gitattributes'), '*.txt diff=evil\n');
    // Both halves: `.command` replaces the diff, `.textconv` preprocesses the
    // blob. Each is a separate exec on a plain `git diff`.
    git('config', 'diff.evil.command', `/usr/bin/touch ${join(dir, 'RAN_COMMAND')};true`);
    git('config', 'diff.evil.textconv', `/usr/bin/touch ${join(dir, 'RAN_TEXTCONV')}; cat`);
    // A clean filter is a THIRD path, and the one `--no-ext-diff
    // --no-textconv` does not touch — which is why the fix is to take the
    // attributes away rather than to keep adding flags.
    writeFileSync(join(dir, '.gitattributes'), '*.txt diff=evil filter=nasty\n');
    git('config', 'filter.nasty.clean', `/usr/bin/touch ${join(dir, 'RAN_CLEAN')}; cat`);
    // Config, not attributes: a hook command on a plain `git status`.
    git('config', 'core.fsmonitor', `/usr/bin/touch ${join(dir, 'RAN_FSMONITOR')}; exit 1`);
    // An alias beginning with `!` is a shell command, and `git diff-evil`
    // matches a `git diff*` prefix rule. The permission list refuses it now;
    // this arms the SHIM's half of the answer, which is that a verb it does
    // not know never reaches the real git.
    git('config', 'alias.diff-evil', `!/usr/bin/touch ${join(dir, 'RAN_ALIAS')}`);
    return dir;
  };

  // A harness that does one thing: run the git commands the allow list permits,
  // in a checkout that has armed them, and report as its "report" whether they
  // fired. Whatever PATH inspect.sh handed it is the PATH it uses.
  const fakeOpencode = (repo: string): string => {
    const bin = scratchDir('inspect-fakebin-');
    writeFileSync(
      join(bin, 'opencode'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }',
        `cd ${repo} || exit 1`,
        'git diff >/dev/null 2>&1',
        'git blame a.txt >/dev/null 2>&1',
        'git status --short >/dev/null 2>&1',
        `fired=""`,
        `[ -f ${join(repo, 'RAN_COMMAND')} ] && fired="\${fired}command "`,
        `[ -f ${join(repo, 'RAN_TEXTCONV')} ] && fired="\${fired}textconv "`,
        `[ -f ${join(repo, 'RAN_CLEAN')} ] && fired="\${fired}clean "`,
        `[ -f ${join(repo, 'RAN_FSMONITOR')} ] && fired="\${fired}fsmonitor "`,
        'git diff-evil >/dev/null 2>&1',
        `[ -f ${join(repo, 'RAN_ALIAS')} ] && fired="\${fired}alias "`,
        `printf '{"type":"text","part":{"text":"FIRED=[%s]"}}\\n' "$fired"`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);
    return bin;
  };

  it('stops .gitattributes from turning an allowed git diff into an exec', () => {
    const repo = evilRepo();
    const result = run(['mapper', brief()], {
      PATH: `${fakeOpencode(repo)}:${process.env.PATH ?? ''}`,
      RALPH_RUNNER_MAPPER: 'opencode',
      RALPH_MODEL_MAPPER: 'opencode-go/ox-alpha-free',
    });

    // The stage ran, and neither driver was executed.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FIRED=[]');
  });

  it('is the reason that test means anything — without it they all fire', () => {
    // The same checkout, the shim taken out of PATH. If this ever stops
    // firing, the test above has stopped testing anything.
    const repo = evilRepo();
    const check = spawnSync(
      'bash',
      [
        '-c',
        `cd ${repo} && git diff >/dev/null 2>&1; git blame a.txt >/dev/null 2>&1; ` +
          `git status --short >/dev/null 2>&1; git diff-evil >/dev/null 2>&1; ls`,
      ],
      { encoding: 'utf8' },
    );
    expect(check.stdout).toContain('RAN_COMMAND');
    expect(check.stdout).toContain('RAN_TEXTCONV');
    expect(check.stdout).toContain('RAN_CLEAN');
    expect(check.stdout).toContain('RAN_FSMONITOR');
    expect(check.stdout).toContain('RAN_ALIAS');
  });

  it('does not let an alias ride in on a permitted verb\u2019s prefix', () => {
    // `git diff*` is a prefix match on a STRING, so it also matches
    // `git diff-evil` — and an alias beginning with `!` is a shell command,
    // which the executor can write into `.git/config`. The permission list now
    // requires the verb to end at a boundary; this pins the half of it that
    // lives in this repo rather than in opencode's matcher.
    const config = readFileSync(join(ROOT, 'opencode-readonly.jsonc'), 'utf8');
    for (const verb of ['diff', 'log', 'show', 'status', 'blame', 'ls-files']) {
      expect(config).toContain(`"git ${verb}": "allow"`);
      expect(config).toContain(`"git ${verb} *": "allow"`);
      expect(config).not.toContain(`"git ${verb}*": "allow"`);
    }
  });
});

/**
 * `inspect.sh` publishes "the report is on stdout" as its exit-0 contract, and
 * a harness can exit 0 having said nothing at all — no final message, or an
 * event shape the renderer does not know. What makes that hard to catch is
 * that the renderer prints tool hints and pass-through diagnostics onto the
 * same stream as the report, so "the log has bytes in it" is not evidence: a
 * run that opened one file and then went quiet leaves a log that looks fine.
 * `DELEGATE_TEXT` is the renderer answering the only question worth asking.
 */
describe('the report marker', () => {
  const render = (events: string[], fmt: 'opencode' | 'codex' = 'opencode') => {
    const usage = join(scratchDir('inspect-usage-'), 'usage');
    const result = spawnSync(
      'python3',
      [join(ROOT, 'delegate-render.py'), usage, 'test/model', fmt],
      { input: events.map((e) => `${e}\n`).join(''), encoding: 'utf8', timeout: 60_000 },
    );
    expect(result.status).toBe(0);
    return { stdout: result.stdout, usage: readFileSync(usage, 'utf8') };
  };

  it('is 0 when opencode rendered tool activity and no prose', () => {
    const { stdout, usage } = render([
      JSON.stringify({ type: 'tool_use', part: { tool: 'read', callID: '1', state: { input: { filePath: 'a.ts' } } } }),
      JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 2 }, cost: 0.01 } }),
    ]);
    // The log is NOT empty — which is exactly why `[ -s "$log" ]` could not
    // tell this case from a real report.
    expect(stdout.trim()).not.toBe('');
    expect(usage).toContain('DELEGATE_TEXT=0');
  });

  it('is 0 when the only output was a diagnostic the harness wrote in plain text', () => {
    // Not an event, so it is passed through rather than swallowed — and it is
    // not a report either.
    const { stdout, usage } = render(['error: model is overloaded, giving up']);
    expect(stdout).toContain('overloaded');
    expect(usage).toContain('DELEGATE_TEXT=0');
  });

  it('is 1 once opencode says something in prose AFTER its tool calls', () => {
    const { usage } = render([
      JSON.stringify({ type: 'tool_use', part: { tool: 'read', callID: '1', state: {} } }),
      JSON.stringify({ type: 'text', part: { text: 'No findings on this axis.' } }),
    ]);
    expect(usage).toContain('DELEGATE_TEXT=1');
  });

  it('is 0 when the prose was a preamble and the run then died', () => {
    // "I will start by reading the diff", a read, and nothing more. Prose
    // ANYWHERE in the run is not the question — the question is whether the run
    // ended with one, which is why tool activity clears the flag.
    const { stdout, usage } = render([
      JSON.stringify({ type: 'text', part: { text: 'I will start by reading the diff.' } }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'read', callID: '1', state: {} } }),
    ]);
    expect(stdout).toContain('start by reading');
    expect(usage).toContain('DELEGATE_TEXT=0');
  });

  it('applies the same rule to codex, whose events say it differently', () => {
    const preamble = render(
      [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Reading the diff now.' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'git diff' } }),
      ],
      'codex',
    );
    expect(preamble.usage).toContain('DELEGATE_TEXT=0');
  });

  it('reads codex\u2019s own event shape for the same question', () => {
    // Two harnesses, one marker: the usage file is `inspect.sh`'s only channel
    // back from the renderer, and it must mean the same thing on both.
    const quiet = render(
      [JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'git diff' } })],
      'codex',
    );
    expect(quiet.usage).toContain('DELEGATE_TEXT=0');

    const spoke = render(
      [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'One finding: …' } })],
      'codex',
    );
    expect(spoke.usage).toContain('DELEGATE_TEXT=1');
  });

  it('does not count an empty final message as one', () => {
    const { usage } = render([JSON.stringify({ type: 'text', part: { text: '   \n' } })]);
    expect(usage).toContain('DELEGATE_TEXT=0');
  });
});

/**
 * Every degrade this script has is silent by design — exit 2 means "make the
 * Agent call yourself", the iteration does, and the review still happens. That
 * is the right behaviour and it is also why a lineup whose review axes have
 * been falling back every night for a week looks identical, from the outside,
 * to one running as configured. The observation is the only thing that tells
 * them apart, so what matters is that it is written at all — and that it
 * carries the attribution which makes it actionable.
 */
describe('the spec axis reads the issue, not a paraphrase of it', () => {
  // Loop #1154, 2026-09-23: "I couldn't read the spec directly because `gh` is
  // outside my rails, so I reviewed against the Agent Brief as your brief
  // paraphrases it." The reviewer is right to have no `gh`; the fix is that it
  // never needs one, because the harness fetched the issue before the stage.
  const fakeOpencode = (): { bin: string; messages: string } => {
    const bin = scratchDir('inspect-spec-bin-');
    const messages = join(bin, 'messages');
    writeFileSync(
      join(bin, 'opencode'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = "auth" ] && { echo "OpenCode Go"; exit 0; }',
        `printf '%s\\n' "\${@: -1}" >> ${JSON.stringify(messages)}`,
        `printf '%s\\n' '{"type":"text","part":{"text":"No findings."}}'`,
      ].join('\n'),
    );
    chmodSync(join(bin, 'opencode'), 0o755);
    return { bin, messages };
  };
  const opencodeSpec = (bin: string) => ({
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RALPH_RUNNER_REVIEW_SPEC: 'opencode',
    RALPH_MODEL_REVIEW_SPEC: 'opencode-go/ox-alpha-free',
  });

  it('puts the fetched issue text in front of an external reviewer', () => {
    const { bin, messages } = fakeOpencode();

    const result = run(['review.spec', specBrief('Playwright covers the web flow')], opencodeSpec(bin));

    expect(result.status).toBe(0);
    const message = readFileSync(messages, 'utf8');
    expect(message).toContain('\n# The spec\n');
    expect(message).toContain(SPEC_MARKER);
    expect(message).toContain('Playwright covers the web flow');
    // After the brief, so the rails still come first.
    expect(message.indexOf('\n# This round\n')).toBeLessThan(message.indexOf('\n# The spec\n'));
  });

  it('refuses a spec brief that names no fetched issue, as a caller mistake', () => {
    const { bin, messages } = fakeOpencode();

    const result = run(['review.spec', brief()], opencodeSpec(bin));

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('issue-spec.ts" fetch');
    expect(existsSync(messages)).toBe(false);
    expect(existsSync(lastRecord)).toBe(false);
  });

  it('refuses a hand-written spec file, which is the paraphrase again', () => {
    const { bin, messages } = fakeOpencode();
    const dir = scratchDir('inspect-spec-forged-');
    writeFileSync(join(dir, 'spec-1154.md'), '# #1154\n\nAdd a delete button.\n');
    writeFileSync(join(dir, 'brief.md'), `Spec: ${join(dir, 'spec-1154.md')}\n`);

    const result = run(['review.spec', join(dir, 'brief.md')], opencodeSpec(bin));

    expect(result.status).toBe(3);
    expect(existsSync(messages)).toBe(false);
  });

  it('asks nothing of the other two stages, which need no spec', () => {
    const { bin } = fakeOpencode();

    const result = run(['review.standards', brief()], {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RALPH_RUNNER_REVIEW_STANDARDS: 'opencode',
      RALPH_MODEL_REVIEW_STANDARDS: 'opencode-go/ox-alpha-free',
    });

    expect(result.status).toBe(0);
  });
});

describe('recording why a stage degraded', () => {
  it('writes an attributed observation when the stage runs in-session', () => {
    const timeline = join(scratchDir('inspect-degraded-timeline-'), 'iteration.events.jsonl');
    const result = run(['review.standards', brief()], {
      RALPH_RUNNER_REVIEW_STANDARDS: 'claude',
      RALPH_MODEL_REVIEW_STANDARDS: 'opus',
      RALPH_LOOP_NAME: 'rafa',
      RALPH_RUN_ID: 'rafa-run-test-1',
      RALPH_SESSION_ID: 'session-abc',
      RALPH_ITERATION: '4',
      RALPH_TIMELINE: timeline,
    });

    expect(result.status).toBe(2);
    const [observation] = observations();
    expect(observation).toMatchObject({
      stage: 'review.standards',
      exitCode: 2,
      loop: 'rafa',
      run: 'rafa-run-test-1',
      attempt: { iteration: 4, session: 'session-abc' },
      kind: 'unavailable',
      visibility: 'post-hoc',
    });
    expect(JSON.parse(readFileSync(timeline, 'utf8'))).toMatchObject({
      type: 'ralph_stage',
      ralph_stage: 'review.standards',
      state: 'degraded',
      runner: 'claude',
      model: 'opus',
    });
  });

  it('reads a missing credential as authentication, not as a missing binary', () => {
    // The two share exit 2 and need opposite repairs. This is the distinction
    // the exit code cannot carry and the record is for.
    const installed = spawnSync('command', ['-v', 'opencode'], { shell: true }).status === 0;

    const result = run(['mapper', brief()], {
      RALPH_RUNNER_MAPPER: 'opencode',
      RALPH_MODEL_MAPPER: 'no-such-provider/some-model',
      RALPH_LOOP_NAME: 'ralph',
      RALPH_RUN_ID: 'ralph-run-test-2',
    });

    expect(result.status).toBe(2);
    const [observation] = observations();
    expect(observation).toMatchObject({
      stage: 'mapper',
      kind: installed ? 'authentication' : 'unavailable',
      runner: 'opencode',
    });
  });

  it('records nothing for a caller mistake it refuses before starting', () => {
    // Exit 3 is bad usage — a brief that is not there. It is the caller's bug,
    // not a runner failure, and putting it in the panel that exists to show
    // denials would be noise in the one place noise is expensive.
    expect(run(['mapper', '/nonexistent/brief.md']).status).toBe(3);
    expect(existsSync(lastRecord)).toBe(false);
  });
});

/**
 * A Codex-hosted run reaches a Claude stage through `claude-inspect.sh`, so
 * the model and effort the lineup names must reach the `claude` it starts —
 * the same pair a Claude-hosted run puts in the named agent's definition.
 */
describe('the Claude inspection process', () => {
  const argvOf = (args: string[]): string => {
    const dir = scratchDir('claude-inspect-');
    const bin = join(dir, 'bin');
    const home = join(dir, 'claude-home');
    mkdirSync(bin);
    mkdirSync(home);
    writeFileSync(join(home, '.credentials.json'), '{}');
    // bwrap prints the command it would have run; claude only has to resolve.
    writeFileSync(join(bin, 'bwrap'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const result = spawnSync('bash', [join(ROOT, 'claude-inspect.sh'), ...args], {
      cwd: dir,
      encoding: 'utf8',
      input: 'brief',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: home },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split('\n').join(' ');
  };

  it('runs the configured model at the configured effort', () => {
    const argv = argvOf(['claude-opus-5-5', 'medium']);

    expect(argv).toContain('--model claude-opus-5-5');
    expect(argv).toContain('--effort medium');
  });

  it('passes no effort when the lineup names none', () => {
    expect(argvOf(['opus'])).not.toContain('--effort');
    expect(argvOf(['opus', ''])).not.toContain('--effort');
  });
});
