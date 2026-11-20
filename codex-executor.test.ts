// @vitest-environment node
/**
 * What git sees from inside the Codex executor's sandbox.
 *
 * `ralph/codex-executor.sh` hides `.env*` files (bound over with `/dev/null`)
 * and the project's `.codex/` (a tmpfs). When those paths are TRACKED — Loggd
 * tracks `.env.example`, `.env.test`, `mobile/.env.production`,
 * `.buildkite/agent/.env.example` and `.codex/**` — git inside the sandbox
 * saw a character device where the index has a regular file and a directory
 * with every entry gone. `git status`, `git diff` and `git diff --check`, the
 * commands the executor uses to audit its own work, all exited 128 with
 * `error: <path>: unsupported file type` (2026-09-23, 4 of 5 runs).
 *
 * The fake `codex` below runs those git commands in the real bubblewrap
 * wrapper against a throwaway repository with the same shape, so the mask and
 * git are checked together. The suite skips where bubblewrap cannot create a
 * user namespace (containers, hardened CI runners).
 */
import { describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fixtureGitEnv } from './test-git-env';
import { scratchDir } from './test-scratch';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs codex-executor.sh inside bubblewrap over a fixture git repo');

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPT = join(HERE, 'codex-executor.sh');

const bwrapUsable = (): boolean => {
  const probe = spawnSync(
    'bwrap',
    ['--unshare-user', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
};
const canSandbox = bwrapUsable();

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: fixtureGitEnv() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

interface Harness {
  dir: string;
  root: string;
  binDir: string;
  stageHome: string;
  codexHome: string;
}

/** A repository shaped like Loggd where it matters: tracked `.env*` and `.codex/`. */
const harness = (): Harness => {
  const dir = scratchDir('codex-executor-');
  const root = join(dir, 'worktree');
  const binDir = join(dir, 'bin');
  const stageHome = join(dir, 'stage.home');
  const codexHome = join(dir, 'codex-home');
  mkdirSync(root, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  write(join(codexHome, 'auth.json'), '{}\n');

  git(root, 'init', '-q');
  write(join(root, '.gitignore'), '.env\n.env.local\n');
  write(join(root, '.env.example'), 'DATABASE_URL=\n');
  write(join(root, '.buildkite', 'agent', '.env.example'), 'BUILDKITE_AGENT_TOKEN=\n');
  write(join(root, '.codex', 'config.toml'), 'model = "project"\n');
  write(join(root, '.codex', 'agents', 'reader.toml'), 'name = "reader"\n');
  write(join(root, 'src', 'app.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=ralph@example.com', '-c', 'user.name=ralph', 'commit', '-qm', 'init');

  // Ignored secrets, the reason for the mask in the first place.
  write(join(root, '.env'), 'SECRET=from-dotenv\n');
  write(join(root, '.env.local'), 'SECRET=from-local\n');
  // The executor's own edit, which is all its git commands should report.
  write(join(root, 'src', 'app.ts'), 'export const a = 2;\n');
  return { dir, root, binDir, stageHome, codexHome };
};

/**
 * Put the fixture in the state git calls "racily clean", deterministically.
 *
 * Git compares an index entry's cached mtime at one-second granularity, so an
 * edit made in the same second as the `git add` that cached it leaves mtime and
 * size matching while the content differs. Git copes by re-reading any entry
 * whose mtime is not older than the index file's own mtime — and that is the
 * signal `codex-executor.sh` destroys if it copies the index without `-p`.
 *
 * Forcing it needs three things, and all three are the point of this helper:
 * `core.trustctime=false`, because `utimesSync` cannot set ctime and git
 * compares ctime by default; the committed file BACK-DATED before `git add`, so
 * the entry's cached mtime is in the past (committing in the current tick makes
 * git smudge the entry on write, after which the real index reports `M` through
 * a different path and proves nothing); and the index file's own mtime moved
 * back to the same instant, which is what makes the entry racily clean.
 *
 * The caller must not run any git command that reads THIS repository's index
 * between this helper and the executor run: the first read re-reads the racily
 * clean entry and writes the index back with that entry's stat invalidated,
 * after which every copy of it reports the edit and the case proves nothing.
 */
const makeRacilyClean = (h: Harness): void => {
  const file = join(h.root, 'src', 'app.ts');
  const past = new Date(Date.now() - 120_000);
  git(h.root, 'config', 'core.trustctime', 'false');
  // A third value: the harness has already committed `1` and left `2` in the
  // worktree, and an empty commit would fail here.
  writeFileSync(file, 'export const a = 3;\n');
  utimesSync(file, past, past);
  git(h.root, 'add', 'src/app.ts');
  git(h.root, '-c', 'user.email=ralph@example.com', '-c', 'user.name=ralph', 'commit', '-qm', 'racy');
  // The executor's edit: same size, so only the cached stat separates it from
  // the committed blob.
  writeFileSync(file, 'export const a = 4;\n');
  utimesSync(file, past, past);
  utimesSync(join(h.root, '.git', 'index'), past, past);
};

/** A fake `codex` that runs the executor's usual self-audit inside the sandbox. */
const fakeCodex = (h: Harness, body: string): void => {
  const bin = join(h.binDir, 'codex');
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bin, 0o755);
};

const run = (h: Harness) =>
  spawnSync('bash', [SCRIPT, 'test-model', h.stageHome, '', ''], {
    cwd: h.root,
    encoding: 'utf8',
    input: '',
    env: fixtureGitEnv({
      PATH: `${h.binDir}:${process.env.PATH ?? ''}`,
      CODEX_HOME: h.codexHome,
    }),
  });

describe.skipIf(!canSandbox)('codex-executor.sh', () => {
  it('lets git status, diff and diff --check run cleanly over the masked paths', () => {
    const h = harness();
    fakeCodex(
      h,
      `set -u
echo "status:"; git status --short; echo "status-rc=$?"
echo "stat:"; git diff --stat; echo "stat-rc=$?"
git diff --check; echo "check-rc=$?"
git diff HEAD --name-only; echo "diff-head-rc=$?"`,
    );

    const result = run(h);

    expect(result.stderr).not.toContain('unsupported file type');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status-rc=0');
    expect(result.stdout).toContain('stat-rc=0');
    expect(result.stdout).toContain('check-rc=0');
    expect(result.stdout).toContain('diff-head-rc=0');
    const status = result.stdout.split('status:\n')[1]!.split('status-rc=')[0]!;
    expect(status.trim()).toBe('M src/app.ts');
    expect(result.stdout).not.toMatch(/\.env|\.codex/);
  });

  it('still hides the secrets and the project Codex configuration', () => {
    const h = harness();
    fakeCodex(
      h,
      `echo "dotenv=[$(cat .env)]"
echo "local=[$(cat .env.local)]"
echo "example=[$(cat .env.example)]"
echo "codex=[$(ls -A .codex)]"`,
    );

    const result = run(h);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dotenv=[]');
    expect(result.stdout).toContain('local=[]');
    expect(result.stdout).toContain('example=[]');
    expect(result.stdout).toContain('codex=[]');
    expect(result.stdout).not.toContain('SECRET');
  });

  it('leaves the real index untouched, so the host still sees every tracked file', () => {
    const h = harness();
    const indexBefore = readFileSync(join(h.root, '.git', 'index'));
    fakeCodex(h, 'git status --short >/dev/null');

    const result = run(h);

    expect(result.status).toBe(0);
    expect(readFileSync(join(h.root, '.git', 'index')).equals(indexBefore)).toBe(true);
    // No skip-worktree bit ("S") leaked onto the project's own index.
    expect(git(h.root, 'ls-files', '-v')).not.toMatch(/^S /m);
    expect(git(h.root, 'status', '--short').trim()).toBe('M src/app.ts');
  });

  it('rebuilds the private index each round, so a commit between rounds is seen', () => {
    const h = harness();
    fakeCodex(h, 'git status --short');
    // stderr as the message: this once came back empty on a loaded host and
    // did not reproduce alone (#187), so a recurrence should say why.
    const first = run(h);
    expect(first.stdout.trim(), `status ${first.status}; stderr: ${first.stderr}`).toBe('M src/app.ts');

    git(h.root, 'add', 'src/app.ts');
    git(h.root, '-c', 'user.email=ralph@example.com', '-c', 'user.name=ralph', 'commit', '-qm', 'round');

    const second = run(h);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('');
  });

  it('still sees an edit whose cached stat matches the index, as the real index does', () => {
    const h = harness();
    makeRacilyClean(h);
    fakeCodex(h, 'git status --short');

    // Nothing may read the repository's own index between the state above and
    // this run: the first `git status` on the host re-reads the racily clean
    // entry and writes the index back with that entry's stat invalidated, after
    // which every copy of it reports the edit and the case proves nothing.
    const result = run(h);

    expect(result.status).toBe(0);
    // Fails when the private index is copied without preserving its timestamp
    // (the `cp --preserve=timestamps "$REAL_INDEX"` in codex-executor.sh): the
    // copy's fresh mtime hides the racily clean entry, so git trusts the stale
    // stat and the sandbox sees a clean tree.
    expect(result.stdout.trim(), `status ${result.status}; stderr: ${result.stderr}`).toBe('M src/app.ts');
    // And the host, which the executor is supposed to agree with, sees the edit
    // — so the fixture was never simply clean. This read comes last for the
    // reason above.
    expect(git(h.root, 'status', '--short').trim()).toBe('M src/app.ts');
  });
});
