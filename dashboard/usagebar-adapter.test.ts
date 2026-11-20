import { describe, expect, it } from "vitest";

import type { ExecResult, Invocation } from "./executor";
import { carryStale, createUsageBarAdapter, narrowUsageBar, narrowUsageBarCost, USAGEBAR_SURFACE } from "./usagebar-adapter";

const AT = "2026-11-04T19:30:00.000Z";

// What `codexbar usage --format json` printed on the operator's host, trimmed.
const PRINTED = JSON.stringify([
  {
    provider: "codex",
    source: "oauth",
    usage: {
      primary: { usedPercent: 58, windowMinutes: 43200, resetsAt: "2026-11-23T00:48:27Z", resetDescription: "Nov 22 at 9:48 PM" },
      secondary: null,
      updatedAt: "2026-11-04T19:26:05Z",
      accountEmail: "operator@example.com",
      loginMethod: "free",
    },
    rateWindowLabels: { primary: "Session" },
  },
  {
    provider: "claude",
    source: "oauth",
    error: { message: "Claude OAuth usage endpoint is rate limited by Anthropic right now.", code: 3, kind: "provider" },
  },
]);

describe("narrowUsageBar", () => {
  it("keeps every provider, a failed one with its error and no windows", () => {
    expect(narrowUsageBar(PRINTED, AT)).toEqual({
      state: "read",
      readAt: AT,
      providers: [
        {
          provider: "codex",
          source: "oauth",
          account: "operator@example.com",
          plan: "free",
          updatedAt: "2026-11-04T19:26:05Z",
          windows: [
            {
              // UsageBar names a window by its length: 30 days is Monthly.
              label: "Monthly",
              usedPercent: 58,
              windowMinutes: 43200,
              resetsAt: "2026-11-23T00:48:27Z",
              resetDescription: "Nov 22 at 9:48 PM",
              pace: null,
            },
          ],
          error: null,
          stale: false,
        },
        {
          provider: "claude",
          source: "oauth",
          account: null,
          plan: null,
          updatedAt: null,
          windows: [],
          error: "Claude OAuth usage endpoint is rate limited by Anthropic right now.",
          stale: false,
        },
      ],
    });
  });

  it("names windows as UsageBar does, adds per-model extras, and drops synthetic placeholders", () => {
    const view = narrowUsageBar(
      JSON.stringify([
        {
          provider: "claude",
          usage: {
            primary: { usedPercent: 40, windowMinutes: 300 },
            secondary: { usedPercent: 80, windowMinutes: 10080 },
            tertiary: { usedPercent: 0, windowMinutes: 10080, isSyntheticPlaceholder: true },
            extraRateWindows: [{ id: "sonnet", title: "Sonnet", window: { usedPercent: 5, windowMinutes: 10080 } }],
          },
          pace: { secondary: { summary: "Behind pace | Expected 70% used | Runs out in 1d" } },
        },
      ]),
      AT,
    );
    expect(view.state === "read" && view.providers[0]!.windows.map((w) => [w.label, w.pace])).toEqual([
      ["Session (5h)", null],
      ["Weekly", "Behind pace | Expected 70% used | Runs out in 1d"],
      ["Sonnet", null],
    ]);
  });

  it("draws a window the CLI reports in two slots once, keeping the pace it carries", () => {
    const weekly = { usedPercent: 26, windowMinutes: 10080, resetsAt: "2026-11-09T15:00:00Z" };
    const view = narrowUsageBar(
      JSON.stringify([
        {
          provider: "claude",
          usage: { primary: weekly, secondary: weekly },
          pace: { secondary: { summary: "On pace | Expected 30% used | Lasts until reset" } },
        },
      ]),
      AT,
    );
    expect(view.state === "read" && view.providers[0]!.windows.map((w) => [w.label, w.pace])).toEqual([
      ["Weekly", "On pace | Expected 30% used | Lasts until reset"],
    ]);
  });

  it("carries a failed provider's last good windows forward, marked stale", () => {
    const good = narrowUsageBar(
      JSON.stringify([{ provider: "claude", usage: { primary: { usedPercent: 40, windowMinutes: 300 }, loginMethod: "max" } }]),
      AT,
    );
    const failed = narrowUsageBar(JSON.stringify([{ provider: "claude", error: { message: "rate limited" } }]), AT);
    expect(carryStale(good, failed)).toMatchObject({
      providers: [{ provider: "claude", error: "rate limited", stale: true, plan: "max", windows: [{ usedPercent: 40 }] }],
    });
    // With nothing to carry, the error stands alone.
    expect(carryStale(null, failed)).toMatchObject({ providers: [{ windows: [], stale: false }] });
  });

  it("reads anything that is not a JSON array as unavailable", () => {
    expect(narrowUsageBar("not json", AT)).toEqual({ state: "unavailable", readAt: AT, why: "codexbar printed no JSON" });
    expect(narrowUsageBar("{}", AT)).toMatchObject({ state: "unavailable" });
  });
});

describe("createUsageBarAdapter", () => {
  const scripted = (answers: ExecResult[]) => {
    const calls: Invocation[] = [];
    const exec = async (invocation: Invocation): Promise<ExecResult> => {
      calls.push(invocation);
      return answers.shift() ?? { status: 0, stdout: "[]", stderr: "" };
    };
    return { calls, exec };
  };

  it("runs the one pinned argv, and reads stdout even when the CLI exits non-zero", async () => {
    const { calls, exec } = scripted([{ status: 3, stdout: PRINTED, stderr: "libcurl: no version information available" }]);
    const read = createUsageBarAdapter({ exec, cwd: "/tmp", env: {} }).usage;
    expect(await read()).toMatchObject({ state: "read", providers: [{ provider: "codex" }, { provider: "claude" }] });
    expect(calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: USAGEBAR_SURFACE.usage.command, args: [...USAGEBAR_SURFACE.usage.args] },
    ]);
  });

  it("reports a host without UsageBar as unavailable, never throwing", async () => {
    const read = createUsageBarAdapter({
      exec: async () => {
        throw new Error("spawn codexbar ENOENT");
      },
      cwd: "/tmp",
      env: {},
    }).usage;
    expect(await read()).toMatchObject({ state: "unavailable", why: "spawn codexbar ENOENT" });
  });

  it("asks at most once per ttl, answering the stale reading while it refreshes", async () => {
    let nowMs = 0;
    const { calls, exec } = scripted([
      { status: 0, stdout: "[]", stderr: "" },
      { status: 0, stdout: PRINTED, stderr: "" },
    ]);
    const read = createUsageBarAdapter({ exec, cwd: "/tmp", env: {}, ttlMs: 1_000, now: () => nowMs }).usage;
    expect(await read()).toMatchObject({ state: "read", providers: [] });
    nowMs = 500;
    await read();
    expect(calls).toHaveLength(1);
    nowMs = 1_500;
    // Stale: answered at once, refreshed behind it.
    expect(await read()).toMatchObject({ providers: [] });
    expect(calls).toHaveLength(2);
    // The refresh runs behind the stale answer; one event-loop turn lands it.
    await new Promise((resolve) => setImmediate(resolve));
    expect(await read()).toMatchObject({ providers: [{ provider: "codex" }, { provider: "claude" }] });
  });

  it("answers reading rather than hold the route on a first limit read that hangs", async () => {
    const exec = () => new Promise<ExecResult>(() => {});
    const adapter = createUsageBarAdapter({ exec, cwd: "/tmp", env: {}, firstWaitMs: 5 });
    expect(await adapter.usage()).toEqual({ state: "reading" });
  });

  it("serves a slow first limit read once it lands, from one CLI run", async () => {
    let release: (result: ExecResult) => void = () => {};
    let runs = 0;
    const exec = () =>
      new Promise<ExecResult>((resolve) => {
        runs += 1;
        release = resolve;
      });
    const adapter = createUsageBarAdapter({ exec, cwd: "/tmp", env: {}, firstWaitMs: 5 });
    expect(await adapter.usage()).toEqual({ state: "reading" });
    expect(await adapter.usage()).toEqual({ state: "reading" });
    expect(runs).toBe(1);
    release({ status: 0, stdout: PRINTED, stderr: "" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await adapter.usage()).toMatchObject({ state: "read", providers: [{ provider: "codex" }, { provider: "claude" }] });
    expect(runs).toBe(1);
  });

  it("never waits on the minutes-long cost scan: it answers reading, then the reading once it lands", async () => {
    let release: (result: ExecResult) => void = () => {};
    const calls: Invocation[] = [];
    const exec = (invocation: Invocation) =>
      new Promise<ExecResult>((resolve) => {
        calls.push(invocation);
        release = resolve;
      });
    const adapter = createUsageBarAdapter({ exec, cwd: "/tmp", env: {} });
    expect(await adapter.cost()).toEqual({ state: "reading" });
    // A second ask while the scan runs starts no second scan.
    expect(await adapter.cost()).toEqual({ state: "reading" });
    expect(calls.map(({ args }) => args)).toEqual([[...USAGEBAR_SURFACE.cost.args]]);
    expect(calls[0]!.timeoutMs).toBeGreaterThanOrEqual(300_000);
    release({ status: 0, stdout: COST, stderr: "" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await adapter.cost()).toMatchObject({ state: "read" });
  });
});

// What `codexbar cost --format json --days 90` printed on the operator's host, trimmed.
const COST = JSON.stringify([
  {
    provider: "codex",
    daily: [
      {
        date: "2026-10-22",
        inputTokens: 1000,
        cacheReadTokens: 800,
        outputTokens: 100,
        totalTokens: 1100,
        totalCost: 9,
        modelBreakdowns: [
          { modelName: "gpt-6.1-sol", totalTokens: 880, cost: 9 },
          { modelName: "codex-auto-review", totalTokens: 220 },
        ],
      },
    ],
  },
  {
    provider: "claude",
    daily: [
      {
        date: "2026-10-22",
        inputTokens: 10,
        outputTokens: 90,
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        totalTokens: 1000,
        totalCost: 5,
        modelBreakdowns: [{ modelName: "claude-opus-5-5", totalTokens: 1000, cost: 5 }],
      },
    ],
  },
]);

describe("narrowUsageBarCost", () => {
  it("merges every provider's days into one series, Codex's cache reads out of its input", () => {
    const view = narrowUsageBarCost(COST, AT);
    expect(view).toEqual({
      state: "read",
      readAt: AT,
      daily: [
        {
          date: "2026-10-22",
          models: [
            { model: "codex/gpt-6.1-sol", costUsd: 9, tokens: { input: 160, output: 80, cacheRead: 640, cacheWrite: 0 } },
            // The CLI could not price it: no cost, as a runner that reports none.
            { model: "codex/codex-auto-review", costUsd: null, tokens: { input: 40, output: 20, cacheRead: 160, cacheWrite: 0 } },
            { model: "claude-opus-5-5", costUsd: 5, tokens: { input: 10, output: 90, cacheRead: 800, cacheWrite: 100 } },
          ],
        },
      ],
    });
  });

  it("reads anything that is not a JSON array as unavailable", () => {
    expect(narrowUsageBarCost("nope", AT)).toMatchObject({ state: "unavailable" });
  });
});
