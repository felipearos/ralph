// @vitest-environment node
/**
 * What `issue-spec.ts` promises the spec axis: the reviewer reads the issue as
 * GitHub has it, fetched by the harness, never the orchestrator's paraphrase.
 *
 * Loop #1154 (2026-09-23) shipped a spec review that said "`gh` is outside my
 * rails, so I reviewed against the Agent Brief as your brief paraphrases it" —
 * a review against the orchestrator's summary of the ticket is a review of the
 * orchestrator, not of the change. The subprocess is the seam, as in
 * `merge-wait.test.ts`: the script runs as the iteration runs it, against a
 * fake `gh` on PATH, so the argv, the file and the exit code are under test.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { EXIT, SPEC_MARKER, renderSpec, specPathsIn } from './issue-spec';
import { fileScratchDir, scratchDir } from './test-scratch';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs the issue-spec CLI through bash and bun');

const SCRIPT = join(import.meta.dirname, 'issue-spec.ts');
const BUN = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim();

const fakeBinDir = fileScratchDir('ralph-issue-spec-');
writeFileSync(
  join(fakeBinDir, 'gh'),
  [
    '#!/bin/sh',
    '# Fake gh for issue-spec.test.ts: records its argv, answers from $FAKE_DIR/answer,',
    '# and fails when that file says FAIL.',
    'printf \'%s\\n\' "gh $*" >> "$FAKE_DIR/argv"',
    'if [ "$(cat "$FAKE_DIR/answer")" = "FAIL" ]; then echo "gh: HTTP 404" >&2; exit 1; fi',
    'cat "$FAKE_DIR/answer"',
    '',
  ].join('\n'),
);
chmodSync(join(fakeBinDir, 'gh'), 0o755);

afterAll(() => rmSync(fakeBinDir, { recursive: true, force: true }));

const ISSUE = {
  number: 1154,
  title: 'Delete a log and mark it unwatched',
  url: 'https://github.com/felipearos/loggd/issues/1154',
  state: 'OPEN',
  labels: [{ name: 'ready-for-agent' }],
  body: '## Acceptance criteria\n\n- [ ] Deleting offers "and mark unwatched"\n- [ ] Playwright covers the web flow',
  comments: [
    {
      author: { login: 'felipearos' },
      createdAt: '2026-09-22T10:00:00Z',
      body: 'Mobile must refresh the season screen too.',
    },
  ],
};

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  argv: string[];
  cwd: string;
}

function run(args: string[], answer: string = JSON.stringify(ISSUE), cwd?: string): Run {
  const dir = mkdtempSync(join(fakeBinDir, 'case-'));
  writeFileSync(join(dir, 'answer'), answer);
  const workdir = cwd ?? scratchDir('ralph-issue-spec-cwd-');
  const result = spawnSync(BUN, [SCRIPT, ...args], {
    cwd: workdir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`, FAKE_DIR: dir },
  });
  const argvFile = join(dir, 'argv');
  const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim().split('\n') : [];
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr, argv, cwd: workdir };
}

describe('fetch', () => {
  it('writes the issue to .ralph/logs/spec-<n>.md and prints that path', () => {
    const result = run(['fetch', '1154']);

    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toBe('.ralph/logs/spec-1154.md');
    const spec = readFileSync(join(result.cwd, result.stdout), 'utf8');
    expect(spec.startsWith(SPEC_MARKER)).toBe(true);
    expect(spec).toContain('Delete a log and mark it unwatched');
    expect(spec).toContain('Playwright covers the web flow');
    expect(spec).toContain('Mobile must refresh the season screen too.');
    expect(spec).toContain('@felipearos');
  });

  it('asks gh for the body, the labels and the comments of exactly that issue', () => {
    const result = run(['fetch', '1154', '--repo', 'felipearos/loggd']);

    expect(result.argv).toEqual([
      'gh issue view 1154 --json number,title,url,state,labels,body,comments --repo felipearos/loggd',
    ]);
  });

  it('accepts #<n>, the way the prompt writes an issue number', () => {
    const result = run(['fetch', '#1154']);

    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toBe('.ralph/logs/spec-1154.md');
  });

  it('fails loudly, and writes nothing, when gh cannot read the issue', () => {
    const result = run(['fetch', '1154'], 'FAIL');

    expect(result.status).toBe(EXIT.unreadable);
    expect(result.stderr).toContain('HTTP 404');
    expect(existsSync(join(result.cwd, '.ralph/logs/spec-1154.md'))).toBe(false);
  });

  it('refuses gh output that is not the issue it asked for', () => {
    const result = run(['fetch', '1154'], JSON.stringify({ ...ISSUE, number: 7 }));

    expect(result.status).toBe(EXIT.unreadable);
    expect(existsSync(join(result.cwd, '.ralph/logs/spec-1154.md'))).toBe(false);
  });

  it('replaces a stale copy, so a re-review reads the comments added since', () => {
    const first = run(['fetch', '1154']);
    const second = run(
      ['fetch', '1154'],
      JSON.stringify({ ...ISSUE, comments: [{ author: { login: 'x' }, createdAt: '', body: 'Later scope change.' }] }),
      first.cwd,
    );

    expect(second.status).toBe(EXIT.ok);
    const spec = readFileSync(join(second.cwd, '.ralph/logs/spec-1154.md'), 'utf8');
    expect(spec).toContain('Later scope change.');
    expect(spec).not.toContain('Mobile must refresh');
  });

  it('refuses a missing or non-numeric issue as usage', () => {
    expect(run(['fetch']).status).toBe(EXIT.usage);
    expect(run(['fetch', 'abc']).status).toBe(EXIT.usage);
    expect(run([]).status).toBe(EXIT.usage);
  });
});

describe('attach', () => {
  const workdir = (): string => {
    const dir = scratchDir('ralph-issue-spec-attach-');
    mkdirSync(join(dir, '.ralph/logs'), { recursive: true });
    return dir;
  };
  const writeBrief = (dir: string, text: string): string => {
    const file = join(dir, '.ralph/logs/brief-spec.md');
    writeFileSync(file, text);
    return file;
  };

  it('prints the fetched spec a brief names, for inspect.sh to put in front of the reviewer', () => {
    const dir = run(['fetch', '1154']).cwd;
    const brief = writeBrief(dir, '# Spec review\n\nSpec: .ralph/logs/spec-1154.md\n');

    const result = run(['attach', brief], undefined, dir);

    expect(result.status).toBe(EXIT.ok);
    expect(result.stdout).toContain('.ralph/logs/spec-1154.md');
    expect(result.stdout).toContain('Playwright covers the web flow');
  });

  it('refuses a brief that names no spec file', () => {
    const dir = workdir();
    const brief = writeBrief(dir, '# Spec review\n\nThe issue asks for a delete button.\n');

    const result = run(['attach', brief], undefined, dir);

    expect(result.status).toBe(EXIT.nospec);
    expect(result.stderr).toContain('issue-spec.ts" fetch');
  });

  it('refuses a named spec file that does not exist', () => {
    const dir = workdir();
    const brief = writeBrief(dir, 'Spec: .ralph/logs/spec-1154.md\n');

    const result = run(['attach', brief], undefined, dir);

    expect(result.status).toBe(EXIT.nospec);
    expect(result.stderr).toContain('spec-1154.md');
  });

  it('refuses a spec file the harness did not write — a hand-written paraphrase is the incident', () => {
    const dir = workdir();
    writeFileSync(join(dir, '.ralph/logs/spec-1154.md'), '# #1154\n\nAdd a delete button.\n');
    const brief = writeBrief(dir, 'Spec: .ralph/logs/spec-1154.md\n');

    const result = run(['attach', brief], undefined, dir);

    expect(result.status).toBe(EXIT.nospec);
    expect(result.stderr).toContain('not written by');
  });
});

describe('the rendered spec', () => {
  it('keeps the body verbatim and every comment in order, with who wrote it', () => {
    const spec = renderSpec(
      {
        ...ISSUE,
        comments: [
          { author: { login: 'a' }, createdAt: '2026-09-01T00:00:00Z', body: 'first' },
          { author: { login: 'b' }, createdAt: '2026-09-02T00:00:00Z', body: 'second' },
        ],
      },
      '2026-09-23T00:00:00Z',
    );

    expect(spec).toContain(ISSUE.body);
    expect(spec.indexOf('@a')).toBeLessThan(spec.indexOf('@b'));
    expect(spec.indexOf('first')).toBeLessThan(spec.indexOf('second'));
    expect(spec).toContain('ready-for-agent');
  });

  it('says so when the issue has no body, rather than rendering an empty spec', () => {
    const spec = renderSpec({ ...ISSUE, body: '', comments: [] }, '2026-09-23T00:00:00Z');

    expect(spec).toContain('(The issue has no body.)');
    expect(spec).toContain('(No comments.)');
  });
});

describe('finding the spec a brief names', () => {
  it('finds the path however the brief formats it', () => {
    expect(specPathsIn('Spec: .ralph/logs/spec-12.md')).toEqual(['.ralph/logs/spec-12.md']);
    expect(specPathsIn('Read `.ralph/logs/spec-12.md` first.')).toEqual(['.ralph/logs/spec-12.md']);
    expect(specPathsIn('**Spec:** /abs/wt/.ralph/logs/spec-12.md.')).toEqual(['/abs/wt/.ralph/logs/spec-12.md']);
  });

  it('names each file once', () => {
    expect(specPathsIn('.ralph/logs/spec-3.md and again .ralph/logs/spec-3.md, plus .ralph/logs/spec-4.md')).toEqual([
      '.ralph/logs/spec-3.md',
      '.ralph/logs/spec-4.md',
    ]);
  });

  it('finds nothing in a brief that only paraphrases', () => {
    expect(specPathsIn('The spec says a delete button. See spec-ish notes.')).toEqual([]);
  });
});
