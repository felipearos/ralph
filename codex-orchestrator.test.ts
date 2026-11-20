// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TokenTally } from './iteration-budget';
import { subprocessSuite } from './test-timeouts';

subprocessSuite('runs codex-orchestrator.py under python3');

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const session = '11111111-2222-3333-4444-555555555555';
const thread = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ralph-codex-orchestrator-'));
  scratch.push(root);
  const bin = join(root, 'bin');
  const home = join(root, 'codex');
  mkdirSync(bin); mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
root = Path(${JSON.stringify(root)})
with (root / 'calls.jsonl').open('a') as out:
    out.write(json.dumps({'args': sys.argv[1:], 'prompt': sys.stdin.read()}) + '\\n')
print(json.dumps({'type':'thread.started','thread_id':${JSON.stringify(thread)}}), flush=True)
u = {'input_tokens':100,'cached_input_tokens':60,'output_tokens':10}
resume = 'resume' in sys.argv
# A native usage record arrives before exec emits its final summary.
p = Path(os.environ['CODEX_HOME']) / 'sessions' / 'rollout-${thread}.jsonl'
with p.open('a') as out:
    out.write(json.dumps({'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':{k:v*(2 if resume else 1) for k,v in u.items()}}}}) + '\\n')
time.sleep(0.35)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'<ralph>DONE</ralph>'}}), flush=True)
if os.environ.get('FAKE_CODEX_FAIL'):
    print(json.dumps({'type':'turn.failed','error':{'message':'provider unavailable'}}), flush=True)
else:
    print(json.dumps({'type':'turn.completed','usage':u}), flush=True)
`);
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home,
    RALPH_LOG_DIR: root, RALPH_SESSION_ID: session, RALPH_RUNNER_ORCHESTRATOR: 'codex' };
  const run = (resume = false, extra: Record<string, string> = {}) => spawnSync('python3', [
    join(__dirname, 'codex-orchestrator.py'), '--session-id', session,
    '--model', 'gpt-5.6-terra', '--effort', 'high', ...(resume ? ['--resume'] : []),
  ], { cwd: root, env: { ...env, ...extra }, input: 'the complete prompt', encoding: 'utf8' });
  return { root, env, run };
}

describe('Codex orchestration', () => {
  it('keeps exact thread recovery and reconciles live and final usage without duplicate cache counts', () => {
    const f = fixture();
    const first = f.run();
    expect(first.status, first.stderr).toBe(0);
    const firstEvents = first.stdout.trim().split('\n').map((line) => JSON.parse(line));
    const liveUsage = firstEvents.findIndex((event) => event.message?.usage);
    const finalMessage = firstEvents.findIndex((event) => event.message?.content?.[0]?.type === 'text');
    expect(liveUsage).toBeGreaterThanOrEqual(0);
    expect(liveUsage).toBeLessThan(finalMessage);
    const resumed = f.run(true);
    expect(resumed.status, resumed.stderr).toBe(0);
    const tally = new TokenTally(session);
    tally.feed(first.stdout + resumed.stdout);
    expect(tally.total).toBe(220);
    const calls = readFileSync(join(f.root, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls[0].args).toContain('model_reasoning_effort="high"');
    expect(calls[0].prompt).toBe('the complete prompt');
    expect(calls[1].args).toContain('resume');
    expect(calls[1].args).toContain(thread);
    expect(calls[1].args).not.toContain('--last');
    expect(resumed.stdout).toContain('<ralph>DONE</ralph>');
  });

  it('persists a redacted per-session transcript consumable by usage.py', () => {
    const f = fixture();
    const result = f.run();
    const rendered = spawnSync('python3', [join(__dirname, 'stream-render.py'),
      '--events', join(f.root, 'events.jsonl'), '--final', join(f.root, 'final'),
      '--signals', join(f.root, 'signals')], { cwd: f.root, env: f.env, input: result.stdout, encoding: 'utf8' });
    expect(rendered.status, rendered.stderr).toBe(0);
    const usage = spawnSync('python3', [join(__dirname, 'usage.py'), '--json', '--no-record'],
      { cwd: f.root, env: f.env, encoding: 'utf8' });
    expect(usage.status, usage.stderr).toBe(0);
    const parsed = JSON.parse(usage.stdout);
    expect(parsed.iteration.usage.input).toBe(40);
    expect(parsed.iteration.usage.cache_read).toBe(60);
    expect(parsed.iteration.usage.output).toBe(10);
    expect(readFileSync(join(f.root, 'final'), 'utf8')).toContain('<ralph>DONE</ralph>');
  });

  it('refuses recovery with no owned thread and treats turn.failed as failure even on a zero CLI exit', () => {
    const f = fixture();
    expect(f.run(true).status).toBe(2);
    const failed = f.run(false, { FAKE_CODEX_FAIL: '1' });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('provider unavailable');
    const events = failed.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1).result).toBe('');
  });
});
