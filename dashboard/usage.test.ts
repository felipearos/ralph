// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createUsageReader,
  readAppended,
  issueForLabels,
  localDay,
  mergeDaily,
  parseEventLine,
  parseLedgerLine,
  summarizeUsage,
  type LoopLogs,
} from "./usage";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tags = (stage: string, iteration: number, at: string) => ({
  ralph_stage: stage,
  ralph_iteration: iteration,
  ralph_run: "run-1",
  ralph_received_at: at,
});

const init = (session: string, iteration: number, at: string) =>
  JSON.stringify({ type: "system", subtype: "init", session_id: session, ...tags("orchestrator", iteration, at) });

const result = (uuid: string, stage: string, session: string, iteration: number, at: string, cost: number, model = "claude-opus-5") =>
  JSON.stringify({
    type: "result",
    uuid,
    session_id: session,
    total_cost_usd: cost,
    modelUsage: {
      [model]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 4, costUSD: cost },
    },
    ...tags(stage, iteration, at),
  });

const rate = (at: string, info: Record<string, unknown>) =>
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, ...tags("orchestrator", 1, at) });

const ledger = (session: string, at: string, label: string, model: string, tokens: number[]) =>
  ["run-1", session, "1", at, label, model, ...tokens.map(String)].join("\t");

function worktree(events: string[], rows: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "usage-"));
  scratch.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, ".ralph", "logs", "iter-a-1.events.jsonl"), events.map((line) => `${line}\n`).join(""));
  writeFileSync(
    join(root, ".ralph", "logs", "usage-ledger.tsv"),
    ["run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read", ...rows].join("\n") + "\n",
  );
  return root;
}

function externalCost(root: string, name: string, model: string, tokens: number[], costs: number[]): void {
  const [input, output, cacheWrite, cacheRead] = tokens;
  const dir = join(root, ".ralph", "logs");
  writeFileSync(
    join(dir, `${name}.usage`),
    [
      `DELEGATE_MODEL=${model}`,
      `DELEGATE_INPUT=${input}`,
      `DELEGATE_OUTPUT=${output}`,
      `DELEGATE_CACHE_READ=${cacheRead}`,
      `DELEGATE_CACHE_WRITE=${cacheWrite}`,
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(dir, `${name}.log.jsonl`),
    costs.map((cost) => JSON.stringify({ type: "step_finish", part: { cost } })).join("\n") + "\n",
  );
}

describe("parsing", () => {
  it("ignores lines that carry nothing usage needs", () => {
    expect(parseEventLine(JSON.stringify({ type: "assistant", ...tags("orchestrator", 1, ago(1)) }))).toBeNull();
    expect(parseEventLine("{not json total_cost_usd")).toBeNull();
  });

  it("reads a rate event's windows, and an older event's limiting window alone", () => {
    const unified = parseEventLine(
      rate(ago(1), {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        isUsingOverage: false,
        unifiedWindows: { five_hour: { utilization: 0.08, resetsAt: 1789296600 }, seven_day: { utilization: 0.77, resetsAt: 1789398000 } },
      }),
    );
    expect(unified).toMatchObject({
      kind: "rate",
      value: { status: "allowed_warning", fiveHour: { utilization: 0.08 }, sevenDay: { utilization: 0.77 } },
    });
    const legacy = parseEventLine(rate(ago(1), { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: 1789296600 }));
    expect(legacy).toMatchObject({ kind: "rate", value: { fiveHour: { utilization: 1 }, sevenDay: null } });
  });

  it("reads ledger rows and skips the header and torn rows", () => {
    expect(parseLedgerLine("run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read")).toBeNull();
    expect(parseLedgerLine("run-1\ts\t1\t2026-09-15T10:00:00+00:00\tclaim #1")).toBeNull();
    expect(parseLedgerLine(ledger("s", ago(1), "x", "opencode-go/glm-5.3", [1, 2, 3, 4, 5]))).toMatchObject({
      input: 1,
      output: 2,
      cacheWrite: 7,
      cacheRead: 5,
    });
  });
});

describe("issueForLabels", () => {
  it("prefers a claim, then the most mentioned issue", () => {
    expect(issueForLabels(["collision note on #837", "claim #874", "push for #837"])).toBe(874);
    expect(issueForLabels(["push gate-failure for #848", "opened PR for #848", "note #12"])).toBe(848);
    expect(issueForLabels(["iteration 1 end"])).toBeNull();
  });
});

describe("summarizeUsage over real files", () => {
  it("reports live Codex tokens for every loop without double counting ledger checkpoints or resumed events", () => {
    const targets = ["ralph", "rafa", "remo", "rulo"].map((loop, index) => {
      const session = `${loop}-session`;
      const tokens = JSON.stringify({
        type: "assistant", runner: "codex", session_id: session,
        message: { id: `${loop}-usage-1`, model: "codex/gpt-5.4", usage: {
          input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80,
        } }, ...tags("orchestrator", 1, ago(1)),
      });
      return { loop, worktree: worktree([
        init(session, 1, ago(2)), tokens, tokens,
      ], [
        ledger(session, ago(1.5), `claim #${800 + index}`, "codex/gpt-5.4", [40, 10, 0, 0, 30]),
        ...["delegated", "mapper", "review.standards", "review.spec"].map(stage =>
          ledger(session, ago(1), `${stage}: brief.md`, "codex/gpt-5.4", [5, 2, 0, 0, 3])),
      ]) };
    });
    const reader = createUsageReader();
    const live = summarizeUsage(reader.read(targets), NOW);
    for (const loop of live.loops) {
      expect(loop).toMatchObject({ unpricedTokens: 240, costUsd: 0, runs: 0 });
      expect(loop.models).toEqual([{ model: "codex/gpt-5.4", costUsd: null,
        tokens: { input: 120, output: 28, cacheRead: 92, cacheWrite: 0 } }]);
    }
    expect(live.tasks.every(task => task.unreported)).toBe(true);
    for (const target of targets) {
      const session = `${target.loop}-session`;
      appendFileSync(join(target.worktree, ".ralph/logs/iter-a-1.events.jsonl"), JSON.stringify({
        type: "result", runner: "codex", subtype: "success", session_id: session,
        ...tags("orchestrator", 1, ago(0.5)),
      }) + "\n");
      appendFileSync(join(target.worktree, ".ralph/logs/usage-ledger.tsv"),
        ledger(session, ago(0.5), "iteration 1 end", "codex/gpt-5.4", [60, 10, 0, 0, 50]) + "\n");
    }
    const done = summarizeUsage(reader.read(targets), NOW);
    expect(done.loops).toEqual(live.loops);
    expect(done.tasks.every(task => !task.unreported && task.iterations === 1)).toBe(true);
    expect(done.tasks.map(task => task.issue).sort()).toEqual([800, 801, 802, 803]);
    expect(summarizeUsage(reader.read(targets), NOW)).toEqual(done);
    // A resumed turn contributes new deltas even though the session is the same.
    const resumed = targets[0]!;
    appendFileSync(join(resumed.worktree, ".ralph/logs/iter-a-1.events.jsonl"), JSON.stringify({
      type: "assistant", runner: "codex", session_id: "ralph-session",
      message: { id: "ralph-usage-2", model: "codex/gpt-5.4", usage: {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20,
      } }, ...tags("orchestrator", 1, ago(0.1)),
    }) + "\n");
    const continued = summarizeUsage(reader.read(targets), NOW);
    expect(continued.loops.find(loop => loop.loop === "ralph")?.unpricedTokens).toBe(275);
    expect(continued.loops.filter(loop => loop.loop !== "ralph").map(loop => loop.unpricedTokens)).toEqual([240, 240, 240]);
  });

  const events = [
    init("orch-1", 1, ago(3)),
    rate(ago(2.9), {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: NOW / 1000 + 3600 }, seven_day: { utilization: 0.8, resetsAt: NOW / 1000 - 60 } },
    }),
    result("exec-a", "executor", "exec-1", 1, ago(2.5), 2, "claude-sonnet-5"),
    result("orch-a", "orchestrator", "orch-1", 1, ago(2), 10),
    init("orch-2", 2, ago(1)),
    rate(ago(0.5), { status: "allowed" }),
  ];
  const rows = [
    ledger("orch-1", ago(2.8), "claim #874", "claude-opus-5", [1, 1, 0, 0, 1]),
    ledger("orch-1", ago(2.4), "delegated: brief-874.md", "opencode-go/glm-5.3", [100, 50, 0, 0, 10]),
    ledger("orch-2", ago(0.9), "claim #900", "claude-opus-5", [1, 1, 0, 0, 1]),
  ];

  it("attributes every run to the orchestrator's issue and prices nothing itself", () => {
    const reader = createUsageReader();
    const report = summarizeUsage(reader.read([{ loop: "rafa", worktree: worktree(events, rows) }]), NOW);

    expect(report.spend).toEqual({ last5h: 12, last24h: 12, last7d: 12, total: 12 });
    const [pending, done] = report.tasks;
    expect(pending).toMatchObject({ issue: 900, costUsd: 0, unreported: true, iterations: 1 });
    expect(done).toMatchObject({ issue: 874, costUsd: 12, runs: 2, iterations: 1, unpricedTokens: 160, unreported: false });
    expect(done!.stages).toEqual([
      { stage: "orchestrator", costUsd: 10 },
      { stage: "executor", costUsd: 2 },
    ]);
    expect(done!.models.find((model) => model.model === "opencode-go/glm-5.3")).toMatchObject({ costUsd: null });
    expect(report.loops[0]).toMatchObject({ loop: "rafa", costUsd: 12, runs: 2, unpricedTokens: 160 });
  });

  it("takes the plan status from the newest event and the windows from the newest that has them", () => {
    const report = summarizeUsage(createUsageReader().read([{ loop: "rafa", worktree: worktree(events, rows) }]), NOW);
    expect(report.plan).toMatchObject({
      status: "allowed",
      loop: "rafa",
      windowsAt: ago(2.9),
      fiveHour: { utilization: 0.4, lapsed: false },
      sevenDay: { utilization: 0.8, lapsed: true },
    });
  });

  it("adds OpenCode's reported step costs to the matching task and stage", () => {
    const root = worktree(events, rows);
    externalCost(root, "delegate-a", "opencode-go/glm-5.3", [100, 50, 0, 10], [0.021, 0.029]);

    const report = summarizeUsage(createUsageReader().read([{ loop: "rafa", worktree: root }]), NOW);
    const done = report.tasks.find((task) => task.issue === 874);
    expect(report.spend.total).toBeCloseTo(12.05);
    expect(done).toMatchObject({ costUsd: 12.05, runs: 3, unpricedTokens: 0 });
    expect(done!.stages).toEqual([
      { stage: "orchestrator", costUsd: 10 },
      { stage: "executor", costUsd: 2.05 },
    ]);
    expect(done!.models.find((model) => model.model === "opencode-go/glm-5.3")).toMatchObject({ costUsd: 0.05 });
  });

  it("reads only what was appended, and waits for a partial line to finish", () => {
    const root = worktree(events, rows);
    const file = join(root, ".ralph", "logs", "iter-a-1.events.jsonl");
    const reader = createUsageReader();
    const targets = [{ loop: "rafa", worktree: root }];
    expect(summarizeUsage(reader.read(targets), NOW).spend.total).toBe(12);

    const late = result("orch-b", "orchestrator", "orch-2", 2, ago(0.2), 5);
    appendFileSync(file, late.slice(0, 40));
    expect(summarizeUsage(reader.read(targets), NOW).spend.total).toBe(12);
    appendFileSync(file, `${late.slice(40)}\n`);
    const report = summarizeUsage(reader.read(targets), NOW);
    expect(report.spend.total).toBe(17);
    expect(report.tasks.find((task) => task.issue === 900)).toMatchObject({ costUsd: 5, unreported: false });
  });

  it("counts a run once even when two files carry it", () => {
    const logs: LoopLogs = {
      loop: "rafa",
      files: 2,
      results: [
        parseEventLine(result("dup", "executor", "e", 1, ago(1), 3))!.value as LoopLogs["results"][number],
        parseEventLine(result("dup", "executor", "e", 1, ago(1), 3))!.value as LoopLogs["results"][number],
      ],
      inits: [],
      rates: [],
      ledger: [],
      externalCosts: [],
    };
    const report = summarizeUsage([logs], NOW);
    expect(report.spend.total).toBe(3);
    expect(report.tasks).toMatchObject([{ issue: null, costUsd: 3 }]);
  });

  it("counts only the latest cumulative result from one session", () => {
    const logs: LoopLogs = {
      loop: "rulo",
      files: 1,
      results: [
        parseEventLine(result("turn-1", "orchestrator", "orch-1", 1, ago(2), 289))!.value as LoopLogs["results"][number],
        parseEventLine(result("notice-1", "orchestrator", "orch-1", 1, ago(1.5), 291))!.value as LoopLogs["results"][number],
        parseEventLine(result("notice-2", "orchestrator", "orch-1", 1, ago(1), 294))!.value as LoopLogs["results"][number],
      ],
      inits: [],
      rates: [],
      ledger: [parseLedgerLine(ledger("orch-1", ago(3), "claim #1121", "claude-opus-5", [1, 1, 0, 0, 1]))!],
      externalCosts: [],
    };

    const report = summarizeUsage([logs], NOW);
    expect(report.spend.total).toBe(294);
    expect(report.tasks).toMatchObject([{ issue: 1121, costUsd: 294, runs: 1, iterations: 1 }]);
    expect(report.loops).toMatchObject([{ loop: "rulo", costUsd: 294, runs: 1 }]);
  });

  it("buckets reported cost and unpriced tokens by local day, ninety days back at most", () => {
    const logs: LoopLogs = {
      loop: "rafa",
      files: 1,
      results: [
        parseEventLine(result("today", "executor", "e1", 1, ago(1), 3))!.value as LoopLogs["results"][number],
        parseEventLine(result("week", "executor", "e2", 2, ago(24 * 5), 2))!.value as LoopLogs["results"][number],
        // Past the series: counted in the total, absent from the days.
        parseEventLine(result("old", "executor", "e3", 3, ago(24 * 120), 50))!.value as LoopLogs["results"][number],
      ],
      inits: [],
      rates: [],
      ledger: [parseLedgerLine(ledger("o1", ago(2), "delegated: #5", "codex/gpt-5.6-terra", [10, 5, 0, 0, 100]))!],
      externalCosts: [],
    };
    const report = summarizeUsage([logs], NOW);
    expect(report.spend.total).toBe(55);
    expect(report.daily.map((day) => day.date)).toEqual([localDay(NOW - 5 * 24 * 3_600_000), localDay(NOW - 3_600_000)].sort());
    const today = report.daily.find((day) => day.date === localDay(NOW - 3_600_000))!;
    expect(today.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "claude-opus-5", costUsd: 3 }),
        expect.objectContaining({ model: "codex/gpt-5.6-terra", costUsd: null }),
      ]),
    );
    // Across projects, a day's models are summed, a cost-less one staying cost-less.
    const merged = mergeDaily([report.daily, report.daily]);
    expect(merged.find((day) => day.date === today.date)!.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "claude-opus-5", costUsd: 6 }),
        expect.objectContaining({ model: "codex/gpt-5.6-terra", costUsd: null, tokens: expect.objectContaining({ input: 20 }) }),
      ]),
    );
  });

  it("reports nothing for a loop with no logs", () => {
    const report = summarizeUsage(createUsageReader().read([{ loop: "rio", worktree: join(tmpdir(), "no-such-worktree") }]), NOW);
    expect(report).toMatchObject({ plan: null, tasks: [], spend: { total: 0 }, loops: [{ loop: "rio", costUsd: 0 }] });
  });
});


it("reads long UTF-8 lines across bounded chunks and defers a trailing partial line", () => {
  const root = worktree([], []);
  const file = join(root, 'chunked.txt');
  const line = 'x'.repeat(65535) + '🌍' + 'y'.repeat(90000);
  writeFileSync(file, line + '\nshort\n' + line);
  const cache = new Map();
  expect(readAppended(cache, file, (value) => value)).toEqual([line, 'short']);
  appendFileSync(file, '\n');
  expect(readAppended(cache, file, (value) => value)).toEqual([line, 'short', line]);
  // Shrinking within an incomplete suffix also resets the prior parsed data.
  appendFileSync(file, 'incomplete suffix');
  readAppended(cache, file, (value) => value);
  writeFileSync(file, 'replacement\n');
  expect(readAppended(cache, file, (value) => value)).toEqual(['replacement']);
});
