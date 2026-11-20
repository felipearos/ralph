// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { activitiesFor, lastTimelineActivity, readTimeline, stageEventFor } from "./timeline";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the timeline CLI under bun");

const ROOT = __dirname;
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const assistant = (text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: text }] },
  });

const delegated = (text: string): string =>
  JSON.stringify({ type: "text", part: { text } });

async function waitForFirstLine(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes("\n")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the orchestrator did not initialize the timeline");
}

describe("the shared iteration event sink", () => {
  it("recognizes a complete external stage boundary", () => {
    expect(
      stageEventFor({
        type: "ralph_stage",
        state: "started",
        invocation: "executor-1",
        runner: "opencode",
        model: "opencode-go/model",
        ralph_stage: "executor",
        ralph_iteration: 3,
        ralph_run: "ralph-run-test",
        ralph_received_at: "2026-08-27T11:00:00.000000Z",
      }),
    ).toMatchObject({
      stage: "executor",
      state: "started",
      invocation: "executor-1",
      runner: "opencode",
    });
  });

  it("shows a Codex command as soon as it starts", () => {
    expect(
      activitiesFor({
        type: "item.started",
        item: { type: "command_execution", command: "bun run typecheck" },
        ralph_stage: "review.spec",
        ralph_iteration: 3,
        ralph_received_at: "2026-08-27T11:00:00.000000Z",
      }),
    ).toEqual([
      {
        stage: "review.spec",
        label: "tool bash — bun run typecheck",
        at: "2026-08-27T11:00:00.000000Z",
        iteration: 3,
        run: null,
      },
    ]);
  });

  it("keeps a rate-limit event's status, folding an overage-absorbed rejection", () => {
    const label = (rate_limit_info: Record<string, unknown>) =>
      activitiesFor({
        type: "rate_limit_event",
        rate_limit_info,
        ralph_stage: "orchestrator",
        ralph_received_at: "2026-08-27T11:00:00.000000Z",
      })[0]?.label;

    expect(label({ status: "allowed", rateLimitType: "five_hour" })).toBe("rate limit allowed");
    expect(label({ status: "rejected", rateLimitType: "seven_day" })).toBe("rate limit rejected");
    expect(label({ status: "rejected", isUsingOverage: true })).toBe("rate limit overage");
    expect(label({})).toBe("rate limit unknown");
  });

  it("selects the newest numeric iteration when mtimes tie", () => {
    const root = mkdtempSync(join(tmpdir(), "loggd-timeline-current-"));
    scratch.push(root);
    const logs = join(root, ".ralph", "logs");
    mkdirSync(logs, { recursive: true });
    const eventFor = (iteration: number) =>
      `${JSON.stringify({
        type: "text",
        part: { text: `iteration ${iteration}` },
        ralph_stage: "orchestrator",
        ralph_iteration: iteration,
        ralph_received_at: "2026-08-27T11:00:00.000000Z",
      })}\n`;
    const ninth = join(logs, "iter-20260827T110000-1-9.events.jsonl");
    const tenth = join(logs, "iter-20260827T110000-1-10.events.jsonl");
    writeFileSync(ninth, eventFor(9));
    writeFileSync(tenth, eventFor(10));
    const tied = new Date("2026-08-27T11:00:00Z");
    utimesSync(ninth, tied, tied);
    utimesSync(tenth, tied, tied);

    const timeline = readTimeline(root);
    expect(timeline.path).toBe(tenth);
    expect(timeline.activities[0]?.label).toBe("text — iteration 10");
  });

  it("orders concurrent receipts at microsecond precision", () => {
    const root = mkdtempSync(join(tmpdir(), "loggd-timeline-precision-"));
    scratch.push(root);
    const logs = join(root, ".ralph", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "iter-20260827T110000-1-4.events.jsonl"),
      [
        {
          type: "text",
          part: { text: "later" },
          ralph_stage: "executor",
          ralph_iteration: 4,
          ralph_received_at: "2026-08-27T11:00:00.000950Z",
        },
        {
          type: "text",
          part: { text: "earlier" },
          ralph_stage: "mapper",
          ralph_iteration: 4,
          ralph_received_at: "2026-08-27T11:00:00.000900Z",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    expect(readTimeline(root).activities.map((item) => item.label)).toEqual([
      "text — earlier",
      "text — later",
    ]);
    expect(lastTimelineActivity(root).activity?.label).toBe("text — later");
  });

  it("keeps every line parseable while the orchestrator and stages append together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loggd-timeline-concurrent-"));
    scratch.push(dir);
    const timeline = join(dir, "iteration.events.jsonl");
    // `RALPH_LOG_DIR` because both renderers put a codex orchestrator log under
    // it, defaulting to `.ralph/logs` relative to the cwd below — this checkout,
    // and a live loop's own folder when it runs the suite as its gate (#199).
    const env = { ...process.env, RALPH_ITERATION: "4", RALPH_LOG_DIR: dir };

    const orchestrator = spawn(
      "python3",
      [
        join(ROOT, "stream-render.py"),
        "--events",
        timeline,
        "--final",
        join(dir, "final.txt"),
        "--signals",
        join(dir, "orchestrator-signals.jsonl"),
      ],
      { cwd: ROOT, env, stdio: ["pipe", "ignore", "pipe"] },
    );
    orchestrator.stdin.write(`${assistant("orchestrator ready")}\n`);
    await waitForFirstLine(timeline);

    const startStage = (stage: string, index: number) => {
      const child = spawn(
        "python3",
        [
          join(ROOT, "delegate-render.py"),
          join(dir, `${stage}.usage`),
          "test/model",
          "opencode",
          join(dir, `${stage}.signals.jsonl`),
          "--timeline",
          timeline,
          "--stage",
          stage,
        ],
        { cwd: ROOT, env, stdio: ["pipe", "ignore", "pipe"] },
      );
      const payload = "x".repeat(6_000);
      child.stdin.end(
        Array.from({ length: 40 }, (_, event) =>
          delegated(`${stage}-${index}-${event}-${payload}`),
        ).join("\n") + "\n",
      );
      return child;
    };

    const mapper = startStage("mapper", 1);
    const executor = startStage("executor", 2);
    orchestrator.stdin.end(
      Array.from({ length: 40 }, (_, event) =>
        assistant(`orchestrator-${event}-${"y".repeat(6_000)}`),
      ).join("\n") + "\n",
    );

    const results = await Promise.all(
      [orchestrator, mapper, executor].map(
        (child) =>
          new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code ?? -1));
          }),
      ),
    );
    expect(results).toEqual([0, 0, 0]);

    const events = readFileSync(timeline, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toHaveLength(121);
    expect(
      events.filter((event) => event.ralph_stage === "orchestrator"),
    ).toHaveLength(41);
    expect(
      events.filter((event) => event.ralph_stage === "mapper"),
    ).toHaveLength(40);
    expect(
      events.filter((event) => event.ralph_stage === "executor"),
    ).toHaveLength(40);
  });

  it("prints a past iteration in receipt order with every stage attributed", () => {
    const root = mkdtempSync(join(tmpdir(), "loggd-timeline-cli-"));
    scratch.push(root);
    const logs = join(root, ".ralph", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "iter-20260827T100000-1.events.jsonl"),
      `${JSON.stringify({
        type: "text",
        part: { text: "old iteration" },
        ralph_stage: "mapper",
        ralph_iteration: 1,
        ralph_received_at: "2026-08-27T10:00:00.000000Z",
      })}\n`,
    );
    writeFileSync(
      join(logs, "iter-20260827T110000-1.events.jsonl"),
      [
        {
          type: "tool_use",
          part: { tool: "read", state: { input: { filePath: "src/late.ts" } } },
          ralph_stage: "mapper",
          ralph_iteration: 2,
          ralph_received_at: "2026-08-27T11:00:02.000000Z",
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "git status" },
              },
            ],
          },
          ralph_stage: "orchestrator",
          ralph_iteration: 2,
          ralph_received_at: "2026-08-27T11:00:01.000000Z",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const result = spawnSync(
      "bun",
      [join(ROOT, "timeline.ts"), "--iteration", "2"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, RALPH_TIMELINE_ROOT: root },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "[2026-08-27T11:00:01.000000Z] [orchestrator] tool Bash — git status",
      "[2026-08-27T11:00:02.000000Z] [mapper] tool read — src/late.ts",
    ]);
    expect(result.stdout).not.toContain("old iteration");
  });
});

describe("the timeline --json contract", () => {
  const ESC = "";

  const fixture = (): string => {
    const root = mkdtempSync(join(tmpdir(), "loggd-timeline-json-"));
    scratch.push(root);
    const logs = join(root, ".ralph", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "iter-20260827T110000-1-2.events.jsonl"),
      [
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: `${ESC}[31mFAIL${ESC}[0m src/late.test.ts`,
              },
            ],
          },
          ralph_stage: "executor",
          ralph_iteration: 2,
          ralph_run: "ralph-run-json",
          ralph_received_at: "2026-08-27T11:00:02.000000Z",
        },
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Bash", input: { command: "git status" } },
            ],
          },
          ralph_stage: "orchestrator",
          ralph_iteration: 2,
          ralph_run: "ralph-run-json",
          ralph_received_at: "2026-08-27T11:00:01.000000Z",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    return root;
  };

  const run = (root: string, args: string[]) =>
    spawnSync("bun", [join(ROOT, "timeline.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, RALPH_TIMELINE_ROOT: root },
    });

  it("emits the activity list as versioned JSON with no ANSI escape codes", () => {
    const root = fixture();
    const result = run(root, ["--json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      exists: true,
      path: join(root, ".ralph", "logs", "iter-20260827T110000-1-2.events.jsonl"),
      activities: [
        {
          stage: "orchestrator",
          label: "tool Bash — git status",
          at: "2026-08-27T11:00:01.000000Z",
          iteration: 2,
          run: "ralph-run-json",
        },
        {
          stage: "executor",
          label: "tool result ok — FAIL src/late.test.ts",
          at: "2026-08-27T11:00:02.000000Z",
          iteration: 2,
          run: "ralph-run-json",
        },
      ],
    });
  });

  it("carries exactly the activities the text mode renders, under the same filters", () => {
    const root = fixture();
    const text = run(root, ["--iteration", "2"]);
    const json = run(root, ["--iteration", "2", "--json"]);

    expect(text.status).toBe(0);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout) as {
      activities: { stage: string; label: string; at: string }[];
    };
    expect(parsed.activities.map((item) => `[${item.at}] [${item.stage}] ${item.label}`)).toEqual(
      // The text mode is left byte-for-byte as it was, escape codes included.
      text.stdout.replaceAll(/\[[0-9;]*m/g, "").trim().split("\n"),
    );
    expect(text.stdout).toContain(`${ESC}[31mFAIL`);
    expect(text.stdout).not.toContain("{");
  });

  it("reports a missing timeline as absent JSON rather than a stderr line", () => {
    const root = mkdtempSync(join(tmpdir(), "loggd-timeline-json-empty-"));
    scratch.push(root);

    const json = run(root, ["--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      version: 1,
      exists: false,
      path: null,
      activities: [],
    });

    const text = run(root, []);
    expect(text.status).toBe(1);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("timeline: no matching iteration event file");
  });

  it("does not match a filter it cannot satisfy", () => {
    const json = run(fixture(), ["--iteration", "9", "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ exists: false, activities: [] });
  });
});
