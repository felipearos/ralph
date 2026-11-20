// @vitest-environment node
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs usage.py under python3");

const REPORTER = join(__dirname, "usage.py");
const scratch: string[] = [];

interface ReporterOptions {
  args?: string[];
  ledger?: string;
  legacyLedger?: string;
  legacyState?: string;
  record?: boolean;
  env?: Record<string, string>;
  /** Subagent transcripts, by file name, where Claude Code writes them. */
  subagents?: Record<string, unknown[]>;
}

interface ReporterRun extends SpawnSyncReturns<string> {
  root: string;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const projectSlug = (path: string): string => {
  return path.replaceAll("/", "-").replaceAll(".", "-").replaceAll("_", "-");
};

const runReporter = (
  records: unknown[],
  options: ReporterOptions = {},
): ReporterRun => {
  const root = mkdtempSync(join(tmpdir(), "loggd-usage-"));
  scratch.push(root);
  const home = join(root, "home");
  const ralph = join(root, "ralph");
  const project = join(home, ".claude", "projects", projectSlug(root));
  mkdirSync(project, { recursive: true });
  mkdirSync(ralph, { recursive: true });
  writeFileSync(join(ralph, "usage.py"), readFileSync(REPORTER));
  writeFileSync(join(project, "session-a.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  for (const [name, lines] of Object.entries(options.subagents ?? {})) {
    mkdirSync(join(project, "session-a", "subagents"), { recursive: true });
    writeFileSync(join(project, "session-a", "subagents", name), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  if (options.ledger !== undefined) {
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(root, ".ralph", "logs", "usage-ledger.tsv"), options.ledger);
  }
  if (options.legacyLedger !== undefined) {
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(root, ".ralph", "logs", "cost-ledger.tsv"), options.legacyLedger);
  }
  if (options.legacyState !== undefined) {
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(root, ".ralph", "logs", "cost-state-session-a.json"), options.legacyState);
  }

  const recordArgs = options.record ? [] : ["--no-record"];
  const result = spawnSync("python3", [join(ralph, "usage.py"), "--session", "session-a", ...recordArgs, ...(options.args ?? [])], {
    cwd: root,
    encoding: "utf8",
    env: { HOME: home, NODE_ENV: "test", PATH: process.env.PATH ?? "", ...options.env },
  });
  return Object.assign(result, { root });
};

const assistant = (model: string, usage: Record<string, unknown>): unknown => ({
  type: "assistant",
  timestamp: "2026-08-27T12:00:00Z",
  message: { id: "message-a", model, usage },
});

describe("the usage report", () => {
  it("keeps the known-model context occupancy line unchanged", () => {
    const result = runReporter([
      assistant("claude-opus-5", {
        input_tokens: 100_000,
        output_tokens: 5_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 20_000,
      }),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("context: 220.0k/1.00M (22%) on claude-opus-5");
  });

  it("reports every token for an unknown model and degrades only its occupancy", () => {
    const result = runReporter([
      assistant("provider/new-model", {
        input_tokens: 120,
        output_tokens: 7,
        cache_read_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
      }),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("180 in (120 uncached, 30 cache read, 20 5m write, 10 1h write) / 7 out");
    expect(result.stdout).toContain("context: 180 (occupancy unknown) on provider/new-model");
  });

  it("reads a legacy ledger row with a trailing cost column", () => {
    const header = [
      "run_id", "session", "step", "ts", "label", "model", "input", "output",
      "cache_5m", "cache_1h", "cache_read", "cost_usd",
    ].join("\t");
    const row = [
      "run-a", "older-session", "1", "2026-08-27T11:00:00+00:00", "older step",
      "provider/old-model", "11", "2", "3", "4", "5", "9.9999",
    ].join("\t");
    const result = runReporter([
      assistant("provider/new-model", { input_tokens: 0, output_tokens: 0 }),
    ], { args: ["--run-id", "run-a"], legacyLedger: `${header}\n${row}\n` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("run run-a: 23 in (11 uncached, 5 cache read, 3 5m write, 4 1h write) / 2 out");
    expect(readFileSync(join(result.root, ".ralph", "logs", "usage-ledger.tsv"), "utf8").split("\n")[0])
      .toBe(header);
  });

  it("writes the token-only ledger schema", () => {
    const result = runReporter([
      assistant("claude-opus-5", { input_tokens: 1, output_tokens: 2 }),
    ], { args: ["--run-id", "run-a"], record: true });

    expect(result.status).toBe(0);
    expect(readFileSync(join(result.root, ".ralph", "logs", "usage-ledger.tsv"), "utf8").split("\n")[0])
      .toBe("run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read");
    expect(result.stdout).not.toContain("$");
  });

  it("migrates the matching legacy state without re-recording the transcript", () => {
    const usage = { input: 100, output: 20, cache_5m: 10, cache_1h: 5, cache_read: 30 };
    const header = [
      "run_id", "session", "step", "ts", "label", "model", "input", "output",
      "cache_5m", "cache_1h", "cache_read", "cost_usd",
    ].join("\t");
    const row = [
      "run-a", "session-a", "1", "2026-08-27T11:00:00+00:00", "first step",
      "claude-opus-5", "100", "20", "10", "5", "30", "1.2345",
    ].join("\t");
    const result = runReporter([
      assistant("claude-opus-5", {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
      }),
    ], {
      args: ["--run-id", "run-a"],
      legacyLedger: `${header}\n${row}\n`,
      legacyState: JSON.stringify({ step: 1, models: { "claude-opus-5": usage } }),
      record: true,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(result.root, ".ralph", "logs", "usage-ledger.tsv"), "utf8").trim().split("\n"))
      .toHaveLength(2);
    expect(readFileSync(join(result.root, ".ralph", "logs", "usage-state-session-a.json"), "utf8"))
      .toContain('"step": 2');
  });

  it("renders a markdown footer with token totals, cache split, and occupancy", () => {
    const result = runReporter([
      assistant("claude-opus-5", {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
      }),
    ], { args: ["--md"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("| scope | input tokens | output tokens | cache split |");
    expect(result.stdout).toContain("30 read / 10 5m write / 5 1h write");
    expect(result.stdout).toContain("145 / 1.00M (0%) on `claude-opus-5`");
    expect(result.stdout).not.toContain("$");
    expect(result.stdout).not.toMatch(/\bcost\b/i);
  });

  it("emits the three scopes as raw machine-readable JSON", () => {
    const result = runReporter([
      assistant("claude-opus-5", {
        input_tokens: 100_000,
        output_tokens: 5_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 20_000,
      }),
    ], { args: ["--json", "--run-id", "run-a"] });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      session: "session-a",
      run_id: "run-a",
      step: {
        number: 1,
        label: "step 1",
        usage: {
          input: 100_000,
          output: 5_000,
          cache_5m: 20_000,
          cache_1h: 0,
          cache_read: 100_000,
          input_total: 220_000,
        },
      },
      iteration: {
        turns: 1,
        elapsed_seconds: 0,
        elapsed: "0m00s",
        usage: { input_total: 220_000 },
      },
      run: { steps: 1, usage: { input_total: 220_000 } },
      context: { model: "claude-opus-5", tokens: 220_000, window: 1_000_000, percent: 22 },
    });
    expect(payload.iteration.models["claude-opus-5"].input_total).toBe(220_000);
    expect(result.stdout).not.toContain("token usage");
  });

  it("books a named subagent's turns under the model its own transcript names", () => {
    // Claude Code writes a subagent's turns beside the session, not in it, and
    // each carries the model that actually ran — not the alias it was asked for.
    // No `isSidechain` flag: the file it sits in is what makes it a subagent's.
    const review = {
      type: "assistant",
      timestamp: "2026-08-27T12:01:00Z",
      message: { id: "message-review", model: "claude-opus-5-5", usage: { input_tokens: 300, output_tokens: 40 } },
    };
    const result = runReporter([
      assistant("claude-opus-5", { input_tokens: 1_000, output_tokens: 10 }),
    ], {
      args: ["--json", "--run-id", "run-a"],
      subagents: { "agent-a1.jsonl": [review], "agent-a1.meta.json": [] },
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.iteration.models["claude-opus-5-5"]).toMatchObject({ input_total: 300, output: 40 });
    expect(payload.iteration.models["claude-opus-5"]).toMatchObject({ input_total: 1_000 });
    expect(payload.step.usage.output).toBe(50);
    // The window is the main chain's; the subagent's turn is later than it.
    expect(payload.context).toMatchObject({ model: "claude-opus-5", tokens: 1_000 });
    expect(payload.iteration).toMatchObject({ turns: 2, elapsed_seconds: 60 });
  });

  it("counts the earlier sessions of the same iteration in the iteration scope", () => {
    const header = "run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read\n";
    const row = (session: string, input: number): string =>
      `run-a\t${session}\t1\t2026-09-19T12:00:00+00:00\tx\tclaude-opus-5\t${input}\t0\t0\t0\t0\n`;
    const result = runReporter(
      [assistant("claude-opus-5", { input_tokens: 100, output_tokens: 0 })],
      {
        args: ["--json", "--run-id", "run-a"],
        ledger: header + row("session-built-it", 1_000) + row("another-iteration", 50_000),
        env: { RALPH_ITERATION_SESSIONS: "session-built-it session-a" },
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.iteration.usage.input).toBe(1_100);
    expect(payload.run.usage.input).toBe(51_100);
  });

  it("keeps the unknown-model occupancy honest in JSON", () => {
    const result = runReporter([
      assistant("provider/new-model", { input_tokens: 120, output_tokens: 7 }),
    ], { args: ["--json"] });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).context).toEqual({
      model: "provider/new-model",
      tokens: 120,
      window: null,
      percent: 0,
    });
  });

  it("records delegated usage as JSON when asked", () => {
    const result = runReporter([], { args: [
      "--record-external", "opencode-go/deepseek-v4-flash",
      "--input", "10", "--output", "2", "--cache-read", "3", "--cache-write", "4",
      "--json", "--run-id", "run-a",
    ]});

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).recorded).toMatchObject({
      session: "session-a",
      run_id: "run-a",
      step: 1,
      label: "delegated",
      model: "opencode-go/deepseek-v4-flash",
      usage: {
        input: 10,
        output: 2,
        cache_5m: 4,
        cache_1h: 0,
        cache_read: 3,
        input_total: 17,
      },
    });
  });
});
