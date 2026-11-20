// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureGitEnv } from './test-git-env';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs the Codex stages through bash against fixture git repos');

const roots: string[] = [];
afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ralph-codex-stages-'));
  roots.push(root);
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const codex = join(root, 'codex');
  const claude = join(root, 'claude');
  for (const path of [project, bin, codex, claude]) mkdirSync(path);
  cpSync(join(__dirname, 'fixtures/loggd/.ralph'), join(project, '.ralph'), { recursive: true });
  writeFileSync(join(project, 'source.txt'), 'original\n');
  writeFileSync(join(project, '.env'), 'SECRET=do-not-read\n');
  writeFileSync(join(project, 'brief.md'), 'Implement the requested change, or report the review findings.\n');
  writeFileSync(join(codex, 'auth.json'), '{}');
  writeFileSync(join(claude, '.credentials.json'), '{}');
  const credential = join(root, 'outside-secret');
  writeFileSync(credential, 'private');
  const env = fixtureGitEnv({ ...process.env, PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, RALPH_PROJECT: project,
    RALPH_LOOP_NAME: 'ralph', RALPH_RUN_ID: 'codex-stages-test', RALPH_SESSION_ID: 'owned-session',
    RALPH_RUNNER_ORCHESTRATOR: 'codex', RALPH_MODEL_ORCHESTRATOR: 'gpt-5.6-terra',
    RALPH_RUNNER_EXECUTOR: 'codex', RALPH_MODEL_EXECUTOR: 'gpt-5.6-luna',
    RALPH_MODEL_EXECUTOR_EFFORT: 'xhigh',
    RALPH_RUNNER_MAPPER: 'claude', RALPH_MODEL_MAPPER: 'opus',
    APPLICATION_SECRET: 'must-not-inherit',
  });
  for (const args of [['init', '-q'], ['add', 'source.txt'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'], ['update-ref', 'refs/remotes/origin/main', 'HEAD']]) {
    const result = spawnSync('git', args, { cwd: project, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  const executable = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, '#!/usr/bin/env python3\n' + body); chmodSync(path, 0o755);
  };
  executable('codex', `import json, os, sys
from pathlib import Path
if sys.argv[1:3] == ['login','status']: sys.exit(0)
assert Path('/proc/self/exe').exists(), 'missing /proc/self/exe'
prompt = sys.stdin.read()
assert 'This round' in prompt
assert 'APPLICATION_SECRET' not in os.environ
assert not Path(${JSON.stringify(credential)}).exists()
try: assert Path('.env').read_text() == ''
except PermissionError: pass
for target in ['.git/config', '.ralph/config.json']:
    try: Path(target).write_text('bad')
    except OSError: pass
    else: raise RuntimeError('writable protected metadata: ' + target)
assert 'sandbox_workspace_write.network_access=false' in sys.argv
assert '--ignore-user-config' in sys.argv
assert 'model_reasoning_effort="xhigh"' in sys.argv
if 'resume' in sys.argv: assert ${JSON.stringify(thread)} in sys.argv
Path('source.txt').write_text('continued' if 'resume' in sys.argv else 'implemented')
print(json.dumps({'type':'thread.started','thread_id':${JSON.stringify(thread)}}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'implementation complete'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':100,'cached_input_tokens':60,'output_tokens':10}}))
`);
  executable('claude', `import json, sys
from pathlib import Path
if sys.argv[1:3] == ['auth','status']:
    print('{"loggedIn":true}'); sys.exit(0)
assert Path('/proc/self/exe').exists(), 'missing /proc/self/exe'
prompt = sys.stdin.read()
assert '# Review diff' in prompt
assert 'Read,Glob,Grep' in sys.argv
assert not Path(${JSON.stringify(credential)}).exists()
try: Path('source.txt').write_text('reviewer must not edit')
except OSError: pass
else: raise RuntimeError('inspection could edit the source')
print(json.dumps({'type':'result','result':'Reviewed the change; no findings.','usage':{'input_tokens':10,'output_tokens':2}}))
`);
  const run = (script: string, args: string[]) => spawnSync('bash', [join(__dirname, script), ...args],
    { cwd: project, env, encoding: 'utf8', timeout: 20_000 });
  return { root, project, run };
}

describe('isolated Codex and mixed-runner stages', () => {
  it('executes and continues Codex under real filesystem confinement while booking usage', () => {
    const f = fixture();
    const first = f.run('delegate.sh', ['brief.md']);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(readFileSync(join(f.project, 'source.txt'), 'utf8')).toBe('implemented');
    const resumed = f.run('delegate.sh', ['--continue', 'brief.md']);
    expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(readFileSync(join(f.project, 'source.txt'), 'utf8')).toBe('continued');
    expect(readFileSync(join(f.project, '.ralph/logs/usage-ledger.tsv'), 'utf8')).toContain('codex/gpt-5.6-luna');
  }, 30_000);

  it('refuses repo-wide verification inside the sandbox, whatever the brief said', () => {
    // The 2026-09-23 incidents, replayed through Codex's own shell spelling
    // (`bash -lc`) inside the real Bubblewrap confinement: the whole suite and
    // a whole-repo lint are refused before they start; a targeted run reaches
    // the real bun and the project's own tool.
    const f = fixture();
    writeFileSync(join(f.project, 'package.json'), JSON.stringify({ scripts: { test: 'bun x vitest run', lint: 'eslint src/' } }));
    mkdirSync(join(f.project, 'src'));
    writeFileSync(join(f.project, 'src/a.test.ts'), '');
    mkdirSync(join(f.project, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(f.project, 'node_modules/.bin/vitest'), '#!/usr/bin/env bash\necho "vitest ran: $*"\n');
    chmodSync(join(f.project, 'node_modules/.bin/vitest'), 0o755);
    const results = join(f.project, 'guard-results.json');
    writeFileSync(join(f.root, 'bin', 'codex'), `#!/usr/bin/env python3
import json, subprocess, sys
if sys.argv[1:3] == ['login','status']: sys.exit(0)
sys.stdin.read()
out = {}
for command in ['bun run test', 'bun lint', 'bun run test src/a.test.ts']:
    run = subprocess.run(['/bin/bash', '-lc', command], capture_output=True, text=True)
    out[command] = {'status': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr}
open('guard-results.json', 'w').write(json.dumps(out))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'checked'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'cached_input_tokens':0,'output_tokens':1}}))
`);
    const result = f.run('delegate.sh', ['brief.md']);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const runs = JSON.parse(readFileSync(results, 'utf8')) as Record<string, { status: number; stdout: string; stderr: string }>;
    expect(runs['bun run test']!.status).toBe(126);
    expect(runs['bun run test']!.stderr).toContain('refused `bun run test`');
    expect(runs['bun run test']!.stdout).not.toContain('vitest ran');
    expect(runs['bun lint']!.status).toBe(126);
    expect(runs['bun run test src/a.test.ts']!.stdout, runs['bun run test src/a.test.ts']!.stderr).toContain('vitest ran: run src/a.test.ts');
  }, 60_000);

  it('runs configured Claude inspection externally when orchestration uses Codex', () => {
    const f = fixture();
    const result = f.run('inspect.sh', ['mapper', 'brief.md']);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout, result.stderr).toContain('Reviewed the change');
    expect(readFileSync(join(f.project, 'source.txt'), 'utf8')).toBe('original\n');
  }, 30_000);
});
