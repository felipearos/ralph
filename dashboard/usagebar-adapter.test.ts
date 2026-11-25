import { describe, expect, it } from "vitest";

import type { ExecResult, Invocation } from "./executor";
import type { UsageBarView } from "./contracts";
import {
  baselineOf,
  carryStale,
  createUsageBarAdapter,
  narrowUsageBar,
  narrowUsageBarCost,
  recalled,
  USAGEBAR_SURFACE,
} from "./usagebar-adapter";

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

  it("recalls only a remembered reading's providers that have bars, as fresh rows", () => {
    expect(recalled(null)).toBeNull();
    expect(recalled({ state: "unavailable", readAt: AT, why: "x" })).toBeNull();
    expect(recalled({ state: "read", readAt: AT, providers: [{ provider: "gemini", windows: [] }] })).toBeNull();
    expect(
      recalled({
        state: "read",
        readAt: AT,
        providers: [
          { provider: "claude", plan: "max", error: "rate limited", stale: true, windows: [{ label: "Weekly", usedPercent: 40 }, { label: 3 }] },
          { provider: "gemini", windows: [] },
        ],
      }),
    ).toEqual({
      state: "read",
      readAt: AT,
      seenAt: { claude: AT },
      providers: [
        {
          provider: "claude",
          source: null,
          account: null,
          plan: "max",
          updatedAt: null,
          error: null,
          stale: false,
          windows: [{ label: "Weekly", usedPercent: 40, windowMinutes: null, resetsAt: null, resetDescription: null, pace: null }],
        },
      ],
    });
  });

  it("baselines every provider with bars, keeping those a reading left out", () => {
    const before = narrowUsageBar(
      JSON.stringify([
        { provider: "codex", usage: { primary: { usedPercent: 10, windowMinutes: 43200 } } },
        { provider: "claude", usage: { primary: { usedPercent: 40, windowMinutes: 300 } } },
      ]),
      AT,
    );
    const partial = narrowUsageBar(JSON.stringify([{ provider: "codex", error: { message: "down" } }]), AT);
    const base = baselineOf(null, before)!;
    expect(base.seenAt).toEqual({ codex: AT, claude: AT });
    // Codex is named with no bars and nothing carried: it drops; Claude, unnamed, stays.
    expect(baselineOf(base, partial)).toMatchObject({ providers: [{ provider: "claude" }], seenAt: { claude: AT } });
    expect(baselineOf(base, { state: "unavailable", readAt: AT, why: "x" })).toBe(base);
    expect(baselineOf(null, partial)).toBeNull();
    // Left out past the keep window, a provider counts as disabled and is forgotten.
    const later = narrowUsageBar(
      JSON.stringify([{ provider: "codex", usage: { primary: { usedPercent: 11, windowMinutes: 43200 } } }]),
      new Date(Date.parse(AT) + 7 * 60 * 60_000).toISOString(),
    );
    expect(baselineOf(base, later)?.providers.map((p) => p.provider)).toEqual(["codex"]);
    const soon = narrowUsageBar(
      JSON.stringify([{ provider: "codex", usage: { primary: { usedPercent: 11, windowMinutes: 43200 } } }]),
      new Date(Date.parse(AT) + 60 * 60_000).toISOString(),
    );
    expect(baselineOf(base, soon)?.providers.map((p) => p.provider)).toEqual(["codex", "claude"]);
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

  it("remembers the last good reading, so a restart inside a rate-limit cooldown still shows the bars", async () => {
    const GOOD = JSON.stringify([
      { provider: "claude", source: "oauth", usage: { primary: { usedPercent: 40, windowMinutes: 300 }, loginMethod: "max" } },
    ]);
    const LIMITED = JSON.stringify([{ provider: "claude", source: "oauth", error: { message: "rate limited" } }]);
    let saved: UsageBarView | null = null;
    const memory = { load: () => (saved === null ? null : JSON.parse(JSON.stringify(saved))), save: (view: UsageBarView) => (saved = view) };

    const first = createUsageBarAdapter({ exec: scripted([{ status: 0, stdout: GOOD, stderr: "" }]).exec, cwd: "/tmp", env: {}, memory });
    await first.usage();
    expect(saved).toMatchObject({ providers: [{ provider: "claude", windows: [{ usedPercent: 40 }] }] });

    // The server restarts while Claude's endpoint is still cooling down.
    const second = createUsageBarAdapter({ exec: scripted([{ status: 3, stdout: LIMITED, stderr: "" }]).exec, cwd: "/tmp", env: {}, memory });
    expect(await second.usage()).toMatchObject({
      providers: [{ provider: "claude", error: "rate limited", stale: true, plan: "max", windows: [{ usedPercent: 40 }] }],
    });
    // The carried reading is remembered as it stands; it carries again next time.
    expect(saved).toMatchObject({ providers: [{ stale: true, windows: [{ usedPercent: 40 }] }] });
  });

  it("does not forget the reading over a run that printed nothing, nor remember one without bars", async () => {
    const saves: UsageBarView[] = [];
    const memory = { load: () => null, save: (view: UsageBarView) => void saves.push(view) };
    let nowMs = 0;
    const { exec } = scripted([
      { status: 0, stdout: JSON.stringify([{ provider: "claude", usage: { primary: { usedPercent: 40, windowMinutes: 300 } } }]), stderr: "" },
      { status: 1, stdout: "", stderr: "boom" },
      { status: 3, stdout: JSON.stringify([{ provider: "claude", error: { message: "rate limited" } }]), stderr: "" },
    ]);
    const adapter = createUsageBarAdapter({ exec, cwd: "/tmp", env: {}, ttlMs: 1, now: () => nowMs, memory });
    const settle = async () => {
      nowMs += 10;
      await adapter.usage();
      await new Promise((resolve) => setImmediate(resolve));
    };
    await adapter.usage();
    await settle();
    await settle();
    expect(await adapter.usage()).toMatchObject({ providers: [{ stale: true, windows: [{ usedPercent: 40 }] }] });
    expect(saves).toHaveLength(2);
  });

  it("shows the remembered bars, stale, when the CLI prints nothing after a restart", async () => {
    const memory = {
      load: () => ({
        state: "read",
        readAt: AT,
        providers: [{ provider: "claude", plan: "max", windows: [{ label: "Weekly", usedPercent: 40 }] }],
      }),
      save: () => {},
    };
    let nowMs = Date.parse(AT) + 3_600_000;
    const { exec } = scripted([
      { status: 1, stdout: "", stderr: "codexbar: timed out" },
      { status: 1, stdout: "", stderr: "codexbar: timed out" },
    ]);
    const adapter = createUsageBarAdapter({ exec, cwd: "/tmp", env: {}, ttlMs: 1, now: () => nowMs, memory });
    expect(await adapter.usage()).toMatchObject({ readAt: AT });
    nowMs += 10;
    await adapter.usage();
    await new Promise((resolve) => setImmediate(resolve));
    // Failed runs measure nothing: the reading keeps the time its bars were read.
    expect(await adapter.usage()).toMatchObject({
      state: "read",
      readAt: AT,
      providers: [{ provider: "claude", error: "codexbar: timed out", stale: true, windows: [{ usedPercent: 40 }] }],
    });
  });

  it("keeps a provider a partial read left out, so its bars survive a restart", async () => {
    let saved: UsageBarView | null = null;
    const memory = { load: () => saved, save: (view: UsageBarView) => (saved = view) };
    const both = JSON.stringify([
      { provider: "codex", usage: { primary: { usedPercent: 10, windowMinutes: 43200 } } },
      { provider: "claude", usage: { primary: { usedPercent: 40, windowMinutes: 300 } } },
    ]);
    const codexOnly = JSON.stringify([{ provider: "codex", usage: { primary: { usedPercent: 12, windowMinutes: 43200 } } }]);
    let nowMs = 0;
    const first = createUsageBarAdapter({
      exec: scripted([
        { status: 0, stdout: both, stderr: "" },
        { status: 0, stdout: codexOnly, stderr: "" },
      ]).exec,
      cwd: "/tmp",
      env: {},
      ttlMs: 1,
      now: () => nowMs,
      memory,
    });
    await first.usage();
    nowMs = 10;
    await first.usage();
    await new Promise((resolve) => setImmediate(resolve));
    expect(saved).toMatchObject({ providers: [{ provider: "codex", windows: [{ usedPercent: 12 }] }, { provider: "claude" }] });

    const limited = JSON.stringify([{ provider: "claude", error: { message: "rate limited" } }]);
    const second = createUsageBarAdapter({ exec: scripted([{ status: 3, stdout: limited, stderr: "" }]).exec, cwd: "/tmp", env: {}, memory });
    expect(await second.usage()).toMatchObject({ providers: [{ provider: "claude", stale: true, windows: [{ usedPercent: 40 }] }] });
  });

  it("survives a memory that throws", async () => {
    const memory = {
      load: () => {
        throw new Error("EACCES");
      },
      save: () => {
        throw new Error("ENOSPC");
      },
    };
    const adapter = createUsageBarAdapter({ exec: scripted([{ status: 0, stdout: PRINTED, stderr: "" }]).exec, cwd: "/tmp", env: {}, memory });
    expect(await adapter.usage()).toMatchObject({ state: "read" });
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
