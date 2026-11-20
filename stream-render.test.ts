// @vitest-environment node
/**
 * The Claude stream is the public seam: JSONL in, four deliberately separate
 * outputs out. The human transcript may contain everything the model thought;
 * the final channel may contain only what the loop is allowed to classify.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs stream-render.py under python3");

const ROOT = __dirname;
const RENDERER = join(__dirname, "stream-render.py");
const scratch: string[] = [];

afterEach(() =>
  scratch
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

const assistant = (
  content: unknown[],
  timestamp = "2026-08-27T12:00:00.000Z",
): string =>
  JSON.stringify({ type: "assistant", message: { content }, timestamp });

const user = (content: unknown[]): string =>
  JSON.stringify({ type: "user", message: { content } });

const result = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Finished safely.\n<ralph>DONE</ralph>",
    permission_denials: [
      {
        tool_name: "Bash",
        tool_use_id: "toolu_denied",
        tool_input: {
          command:
            'curl -H "Authorization: Bearer abcdefghijklmnop" example.test',
        },
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
      output_tokens_details: { thinking_tokens: 5 },
    },
    ...overrides,
  });

interface Rendered {
  status: number;
  stdout: string;
  stderr: string;
  events: string;
  final: string;
  signals: string;
}

function render(
  lines: string[],
  options: { renderer?: string; env?: Record<string, string> } = {},
): Rendered {
  const dir = mkdtempSync(join(tmpdir(), "loggd-stream-render-"));
  scratch.push(dir);
  const events = join(dir, "events.jsonl");
  const final = join(dir, "final.txt");
  const signals = join(dir, "signals.jsonl");
  const out = spawnSync(
    "python3",
    [
      options.renderer ?? RENDERER,
      "--events",
      events,
      "--final",
      final,
      "--signals",
      signals,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      input: `${lines.join("\n")}\n`,
      // The renderer writes a codex orchestrator log under `RALPH_LOG_DIR`,
      // defaulting to `.ralph/logs` relative to the cwd (stream-render.py:180).
      // With the cwd above that is this checkout, and a live loop's own folder
      // when it runs the suite as its gate (#199).
      env: { ...process.env, RALPH_LOG_DIR: dir, ...options.env },
    },
  );
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    status: out.status ?? -1,
    stdout: out.stdout,
    stderr: out.stderr,
    events: read(events),
    final: read(final),
    signals: read(signals),
  };
}

describe("the orchestrator stream renderer", () => {
  it("appends a second session's events to the iteration's file, but starts a fresh final channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-stream-render-append-"));
    scratch.push(dir);
    const args = ["--events", join(dir, "events.jsonl"), "--final", join(dir, "final.txt"), "--signals", join(dir, "signals.jsonl")];
    const session = (id: string, sigil: string): void => {
      spawnSync("python3", [RENDERER, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, RALPH_LOG_DIR: dir },
        input: `${JSON.stringify({ type: "result", subtype: "success", session_id: id, result: sigil })}\n`,
      });
    };
    session("first", "<ralph>AWAIT_PR 7 ci</ralph>");
    session("second", "<ralph>DONE</ralph>");

    const sessions = readFileSync(join(dir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).session_id);
    expect(sessions).toEqual(["first", "second"]);
    expect(readFileSync(join(dir, "final.txt"), "utf8")).not.toContain("AWAIT_PR");
  });

  it("flushes the human timeline before the turn ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-stream-render-live-"));
    scratch.push(dir);
    const child = spawn(
      "python3",
      [
        RENDERER,
        "--events",
        join(dir, "events.jsonl"),
        "--final",
        join(dir, "final.txt"),
        "--signals",
        join(dir, "signals.jsonl"),
      ],
      { cwd: ROOT, env: { ...process.env, RALPH_LOG_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.write(
      `${assistant([{ type: "thinking", thinking: "still working" }])}\n`,
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(new Error("renderer did not flush while stdin remained open")),
        1_000,
      );
      const inspect = (): void => {
        if (stdout.includes("thinking: still working")) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stdout.on("data", inspect);
      inspect();
    });
    expect(stdout).toContain("thinking: still working");
    expect(child.exitCode).toBeNull();

    child.stdin.end(`${result({ permission_denials: [] })}\n`);
    await new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
  });

  it("renders a redacted timeline while keeping the final channel and accounting structured", () => {
    const secret = "super-secret-value-123456";
    const lines = [
      assistant([
        {
          type: "thinking",
          thinking: "I should not stop for <ralph>DONE</ralph> yet.",
        },
        { type: "text", text: "Checking the repository." },
        {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: `printf ${secret}` },
        },
      ]),
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          is_error: false,
          content: `command returned ${secret}`,
        },
      ]),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day",
          resetsAt: 1788188400,
        },
      }),
      result(),
    ];

    const out = render(lines, { env: { STREAM_RENDER_TEST_SECRET: secret } });

    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(
      /\[2026-08-27T12:00:00\.000Z] thinking: I should not stop/,
    );
    expect(out.stdout).toContain("text: Checking the repository.");
    expect(out.stdout).toContain(
      "tool: Bash — printf [redacted:env:STREAM_RENDER_TEST_SECRET]",
    );
    expect(out.stdout).toContain(
      "tool result: Bash — ok — command returned [redacted:env:STREAM_RENDER_TEST_SECRET]",
    );
    expect(out.stdout).toContain("rate limit: rejected — seven_day");
    expect(out.stdout).toContain(
      "usage: input 11, output 22, cache write 33, cache read 44, thinking 5",
    );
    expect(out.stdout).not.toContain(secret);

    expect(out.final).toBe("Finished safely.\n<ralph>DONE</ralph>\n");
    expect(out.final).not.toContain("I should not stop");

    const events = out.events
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            ralph_received_at?: unknown;
            ralph_stage?: unknown;
            usage?: unknown;
          },
      );
    expect(events).toHaveLength(lines.length);
    expect(
      events.every((event) => typeof event.ralph_received_at === "string"),
    ).toBe(true);
    expect(events.every((event) => event.ralph_stage === "orchestrator")).toBe(
      true,
    );
    expect(events.at(-1)?.usage).toEqual({
      input_tokens: 11,
      output_tokens: 22,
      cache_creation_input_tokens: 33,
      cache_read_input_tokens: 44,
      output_tokens_details: { thinking_tokens: 5 },
    });
    expect(out.events).not.toContain(secret);
    expect(out.events).toContain("[redacted:env:STREAM_RENDER_TEST_SECRET]");

    const signals = out.signals
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind?: unknown; source?: unknown });
    expect(signals.map((signal) => signal.kind)).toEqual([
      "usage-limit",
      "permission-denied",
    ]);
    // Both come from Claude's own events — a rejected rate-limit event and the
    // harness's `permission_denials` list — never from a tool result's text,
    // so a clean exit is still allowed to be classified by them.
    expect(signals.map((signal) => signal.source)).toEqual(["runner", "runner"]);
    expect(out.signals).not.toContain("abcdefghijklmnop");
    expect(out.signals).toContain("[redacted:bearer]");
  });

  it("turns red when the redactor is disabled by mutation", () => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-stream-render-mutant-"));
    scratch.push(dir);
    const mutant = join(dir, "stream-render.py");
    copyFileSync(RENDERER, mutant);
    copyFileSync(join(__dirname, "timeline.py"), join(dir, "timeline.py"));
    copyFileSync(
      join(__dirname, "runner-signals.json"),
      join(dir, "runner-signals.json"),
    );
    const source = readFileSync(mutant, "utf8");
    const mutated = source.replace(
      "redact = build_redactor(config, os.environ)",
      "redact = lambda text: text  # mutation: redaction disabled",
    );
    expect(mutated).not.toBe(source);
    writeFileSync(mutant, mutated);

    const secret = "mutation-secret-value-123456";
    const out = render(
      [
        assistant([
          {
            type: "tool_use",
            id: "toolu_bash",
            name: "Bash",
            input: { command: `echo ${secret}` },
          },
        ]),
        user([
          { type: "tool_result", tool_use_id: "toolu_bash", content: secret },
        ]),
        result({ permission_denials: [] }),
      ],
      { renderer: mutant, env: { STREAM_RENDER_TEST_SECRET: secret } },
    );

    expect(() =>
      expect(`${out.stdout}\n${out.events}`).not.toContain(secret),
    ).toThrow();
  });

  it("redacts before truncating a tool target, so a secret prefix cannot escape", () => {
    const secret = "prefix-secret-value-1234567890";
    const command = `${"x".repeat(230)}${secret}`;
    const out = render(
      [
        assistant([
          { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command } },
        ]),
        result({ permission_denials: [] }),
      ],
      { env: { STREAM_RENDER_TEST_SECRET: secret } },
    );

    expect(out.stdout).toContain("[redacted");
    expect(out.stdout).not.toContain(secret.slice(0, 10));
  });

  it("records rate-limit telemetry without treating usable capacity as failure", () => {
    const event = (rateLimitInfo: Record<string, unknown>): string =>
      JSON.stringify({ type: "rate_limit_event", rate_limit_info: rateLimitInfo });
    const out = render([
      event({ status: "allowed", rateLimitType: "five_hour" }),
      event({ status: "allowed_warning", rateLimitType: "seven_day" }),
      event({
        status: "rejected",
        rateLimitType: "overage",
        isUsingOverage: true,
      }),
      event({
        status: "rejected",
        rateLimitType: "overage",
        overageInUse: true,
      }),
      result({ permission_denials: [] }),
    ]);

    expect(out.status).toBe(0);
    expect(out.stdout).toContain("rate limit: allowed — five_hour");
    expect(out.stdout).toContain("rate limit: allowed_warning — seven_day");
    expect(out.stdout).toContain("rate limit: rejected — overage");
    expect(out.events).toContain('"status":"allowed_warning"');
    expect(out.signals).toBe("");
  });
});
