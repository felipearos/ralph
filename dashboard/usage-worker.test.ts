// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { bunPath } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs the usage worker under bun");

it("keeps Bun responsive during cold reads and retains accounting across worker polls", () => {
  // Exercise the deployed runtime and worker entrypoint, not a mocked worker.
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createUsageSource } from ${JSON.stringify(new URL('./usage.ts', import.meta.url).pathname)};
    const root = mkdtempSync(join(tmpdir(), 'usage-worker-'));
    const dir = join(root, '.ralph/logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'iter-1.events.jsonl');
    let now = Date.parse('2026-09-15T12:00:00Z');
    const event = (uuid, cost) => JSON.stringify({
      type: 'result', uuid, session_id: 'session', total_cost_usd: cost,
      ralph_received_at: '2026-09-15T11:00:00Z', ralph_stage: 'orchestrator',
      ralph_run: 'run', ralph_iteration: 1,
    });
    // 32 MiB of irrelevant transcript plus cumulative results for one session.
    writeFileSync(file, ('x'.repeat(1023) + '\\n').repeat(32768) + event('one', 2) + '\\n' + event('two', 5) + '\\n');
    let discoveries = 0;
    const source = createUsageSource({ targets: async () => { discoveries++; return [{ loop: 'rafa', worktree: root }]; }, now: () => now });
    try {
      let done = false;
      const pending = source();
      assert.equal(source(), pending);
      pending.then(() => { done = true; });
      const responsive = await new Promise(resolve => setTimeout(() => resolve(!done), 0));
      assert.equal(responsive, true, 'main event loop blocked by cold usage scan');
      const cold = await pending;
      assert.equal(cold.spend.total, 5);
      assert.equal(discoveries, 1);
      const late = event('three', 7);
      appendFileSync(file, late.slice(0, 30));
      assert.equal((await source()).spend.total, 5);
      appendFileSync(file, late.slice(30) + '\\n');
      assert.equal((await source()).spend.total, 7);
      assert.equal((await source()).spend.total, 7);
      now += 8 * 24 * 3600000;
      const expired = await source();
      assert.deepEqual(expired.spend, { total: 7, last5h: 0, last24h: 0, last7d: 0 });
      writeFileSync(file, event('truncated', 3) + '\\n');
      assert.equal((await source()).spend.total, 3);
      renameSync(file, file + '.old');
      writeFileSync(file, event('rotated', 4) + '\\n');
      assert.equal((await source()).spend.total, 4);
      console.log('responsive; cumulative=5/7; torn-line; expiry; truncation; rotation');
    } finally { source.close(); rmSync(root, { recursive: true, force: true }); }
  `;
  const output = execFileSync(bunPath(), ["-e", script], { encoding: "utf8", timeout: 20_000 });
  expect(output).toContain("responsive; cumulative=5/7; torn-line; expiry; truncation; rotation");
}, 25_000);
