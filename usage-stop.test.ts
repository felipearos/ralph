// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseProjectConfig, validateProjectConfig } from "./project-config";
import { subprocessSuite } from "./test-timeouts";
import { decide, effectiveRule, latestReading, parseOverride, readingIn, resolveRule, type Override } from "./usage-stop";

subprocessSuite("runs bun usage-stop.ts check, set, clear and waive");

const NOW = Date.parse("2026-11-12T12:00:00Z");
const RESET = NOW / 1000 + 3 * 24 * 3600;

const rateEvent = (windows: Record<string, { utilization: number; resetsAt?: number }>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: windows, ...extra },
    ralph_received_at: "2026-11-12T11:00:00Z",
  });

const BASE_CONFIG = {
  repo: "acme/widgets",
  owner: "acme",
  baseBranch: "main",
  displayName: "Widgets",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/widgets" },
  loops: ["ralph", { name: "rafa", role: "coder", usageStop: { percent: 90 } }, { name: "doc", role: "ci-doctor", usageStop: null }],
};

describe("the usageStop schema", () => {
  it("accepts a project stop and per-loop overrides, null exempting a loop", () => {
    expect(validateProjectConfig({ ...BASE_CONFIG, usageStop: { percent: 80 } })).toEqual([]);
    expect(validateProjectConfig({ ...BASE_CONFIG, usageStop: { percent: 70, window: "five_hour", hardPercent: 85 } })).toEqual([]);
  });

  it("refuses what it cannot read rather than guessing a line", () => {
    const problems = (usageStop: unknown) => validateProjectConfig({ ...BASE_CONFIG, usageStop });
    expect(problems(null)).toEqual(["'usageStop' must be an object with a 'percent'"]);
    expect(problems({ percent: 0 })).toEqual(["'usageStop.percent' must be a whole number from 1 to 100"]);
    expect(problems({ percent: 80.5 })).toEqual(["'usageStop.percent' must be a whole number from 1 to 100"]);
    expect(problems({ percent: 80, window: "month" })).toEqual(["'usageStop.window' must be one of seven_day, five_hour"]);
    expect(problems({ percent: 80, hardPercent: 70 })).toEqual(["'usageStop.hardPercent' must not be below 'usageStop.percent'"]);
    expect(problems({ percent: 80, pct: 1 })).toEqual(["unknown key 'usageStop.pct'"]);
    expect(validateProjectConfig({ ...BASE_CONFIG, loops: [{ name: "rafa", usageStop: { percent: 101 } }] })).toEqual([
      "'loops[0].usageStop.percent' must be a whole number from 1 to 100",
    ]);
  });

  it("carries a loop's stop onto its roster entry, and leaves other entries as they were", () => {
    const config = parseProjectConfig(JSON.stringify(BASE_CONFIG));
    expect(config.roster).toEqual([
      { name: "ralph", role: "coder" },
      { name: "rafa", role: "coder", usageStop: { percent: 90 } },
      { name: "doc", role: "ci-doctor", usageStop: null },
    ]);
  });
});

describe("effectiveRule", () => {
  const config = parseProjectConfig(JSON.stringify({ ...BASE_CONFIG, usageStop: { percent: 80 } }));
  const override = (entries: Override["entries"]): Override => ({ entries });

  it("defaults the window to the week and the park to 95%, never below the stop", () => {
    expect(resolveRule({ percent: 80 })).toEqual({ percent: 80, window: "seven_day", hardPercent: 95 });
    expect(resolveRule({ percent: 98 })).toEqual({ percent: 98, window: "seven_day", hardPercent: 98 });
  });

  it("takes the loop's committed stop over the project's, and null exempts", () => {
    expect(effectiveRule("ralph", config, null)).toEqual({ rule: resolveRule({ percent: 80 }), source: "config" });
    expect(effectiveRule("rafa", config, null)).toEqual({ rule: resolveRule({ percent: 90 }), source: "config-loop" });
    expect(effectiveRule("doc", config, null)).toEqual({ rule: null, source: "config-loop" });
  });

  it("takes the override over the config, the loop's over the project's", () => {
    const both = override({ "*": { rule: { percent: 60 }, at: "" }, rafa: { rule: { percent: 70 }, at: "" } });
    expect(effectiveRule("rafa", config, both)).toEqual({ rule: resolveRule({ percent: 70 }), source: "override" });
    expect(effectiveRule("ralph", config, both)).toEqual({ rule: resolveRule({ percent: 60 }), source: "override-project" });
    expect(effectiveRule("ralph", config, override({ ralph: { rule: null, at: "" } }))).toEqual({ rule: null, source: "override" });
  });

  it("lets a waiver-only override entry fall through to the next layer", () => {
    const waived = override({ ralph: { waiveUntil: "2026-11-15T00:00:00Z", at: "" } });
    expect(effectiveRule("ralph", config, waived).source).toBe("config");
  });

  it("is no stop at all with neither config nor override", () => {
    expect(effectiveRule("ralph", null, null)).toEqual({ rule: null, source: "none" });
  });
});

describe("parseOverride", () => {
  it("drops a bad entry and keeps the rest", () => {
    const { override, problem } = parseOverride(
      JSON.stringify({ entries: { rafa: { rule: { percent: 0 }, at: "x" }, ralph: { rule: { percent: 70 }, at: "y" } } }),
    );
    expect(override?.entries.ralph?.rule).toEqual({ percent: 70 });
    expect(override?.entries.rafa?.rule).toBeUndefined();
    expect(problem).toContain("entries.rafa.rule.percent");
  });

  it("reads a file that is not an override as none", () => {
    expect(parseOverride("{").override).toBeNull();
    expect(parseOverride("[]").override).toBeNull();
  });
});

describe("readingIn", () => {
  it("reads the newest event that reports the watched window", () => {
    const lines = [
      rateEvent({ seven_day: { utilization: 0.5, resetsAt: RESET } }),
      rateEvent({ five_hour: { utilization: 0.9, resetsAt: RESET } }),
      "{not json",
    ];
    expect(readingIn(lines, "seven_day")).toMatchObject({ utilization: 0.5, resetsAtMs: RESET * 1000 });
    expect(readingIn(lines, "five_hour")).toMatchObject({ utilization: 0.9 });
  });

  it("reads the older shape that reports the binding window at the top level", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: RESET },
    });
    expect(readingIn([line], "seven_day")).toMatchObject({ utilization: 0.81 });
  });

  it("is no reading without a reset time, which could never be told stale", () => {
    expect(readingIn([rateEvent({ seven_day: { utilization: 0.99 } })], "seven_day")).toBeNull();
  });
});

describe("latestReading", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("looks through the newest events files first, past ones without the window", () => {
    dir = mkdtempSync(join(tmpdir(), "usage-stop-logs-"));
    const older = join(dir, "iter-1.events.jsonl");
    const newer = join(dir, "iter-2.events.jsonl");
    writeFileSync(older, `${rateEvent({ seven_day: { utilization: 0.4, resetsAt: RESET } })}\n`);
    writeFileSync(newer, `${rateEvent({ five_hour: { utilization: 0.2, resetsAt: RESET } })}\n`);
    writeFileSync(join(dir, "supervisor.log"), rateEvent({ seven_day: { utilization: 0.99, resetsAt: RESET } }));
    utimesSync(older, new Date(NOW - 60_000), new Date(NOW - 60_000));
    utimesSync(newer, new Date(NOW), new Date(NOW));
    expect(latestReading(dir, "seven_day")?.utilization).toBe(0.4);
    expect(latestReading(dir, "five_hour")?.utilization).toBe(0.2);
  });

  it("is null for a directory that is not there", () => {
    expect(latestReading("/nonexistent/usage-stop", "seven_day")).toBeNull();
  });
});

describe("decide", () => {
  const rule = resolveRule({ percent: 80 });
  const reading = (utilization: number, resetsAt = RESET) => ({ utilization, resetsAtMs: resetsAt * 1000, at: null });

  it("runs below the stop, drains at it, parks at the hard threshold", () => {
    expect(decide(rule, reading(0.66), NOW, 120).verdict).toBe("run");
    const drain = decide(rule, reading(0.8), NOW, 120);
    expect(drain).toMatchObject({ verdict: "drain", key: `seven_day:${RESET}`, seconds: 3 * 24 * 3600 + 120 });
    expect(drain.detail).toContain("seven_day 80% ≥ 80%");
    expect(decide(rule, reading(0.95), NOW, 120).verdict).toBe("park");
  });

  it("runs on every doubt: no rule, no reading, a window already reset", () => {
    expect(decide(null, reading(1), NOW, 120)).toMatchObject({ verdict: "run", detail: "no usage stop" });
    expect(decide(rule, null, NOW, 120).verdict).toBe("run");
    expect(decide(rule, reading(1, NOW / 1000 - 1), NOW, 120).verdict).toBe("run");
  });

  it("runs past the stop while a waiver lasts, and stops again after it", () => {
    expect(decide(rule, reading(0.97), NOW, 120, NOW + 1000).verdict).toBe("run");
    expect(decide(rule, reading(0.97), NOW, 120, NOW - 1000).verdict).toBe("park");
  });
});

describe("the CLI", () => {
  let root = "";
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  const project = (config: Record<string, unknown>) => {
    root = mkdtempSync(join(tmpdir(), "usage-stop-cli-"));
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(config));
    return root;
  };
  const cli = (...args: string[]) => {
    const out = spawnSync("bun", [join(__dirname, "usage-stop.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RALPH_PROJECT: root,
        RALPH_USAGE_NOW_MS: String(NOW),
        RALPH_USAGE_STOP_FILE: join(root, "override.json"),
      },
    });
    return { status: out.status, stdout: out.stdout.trim(), stderr: out.stderr };
  };
  const verdict = (loop: string) => cli("check", "--loop", loop).stdout.split("\t");
  const spend = (utilization: number) =>
    writeFileSync(join(root, ".ralph", "logs", "iter-1.events.jsonl"), `${rateEvent({ seven_day: { utilization, resetsAt: RESET } })}\n`);

  it("checks against the committed config and the loop's own reading", () => {
    project({ ...BASE_CONFIG, usageStop: { percent: 80 } });
    expect(verdict("ralph")[0]).toBe("run");
    spend(0.85);
    expect(verdict("ralph").slice(0, 3)).toEqual(["drain", String(3 * 24 * 3600 + 120), `seven_day:${RESET}`]);
    expect(verdict("rafa")[0]).toBe("run");
    expect(verdict("doc")[0]).toBe("run");
    spend(0.96);
    expect(verdict("ralph")[0]).toBe("park");
  });

  it("applies an override at once, and clearing it brings the config back", () => {
    project({ ...BASE_CONFIG, usageStop: { percent: 80 } });
    spend(0.85);
    expect(cli("set", "--loop", "ralph", "--percent", "90").status).toBe(0);
    expect(verdict("ralph")[0]).toBe("run");
    expect(cli("set", "--loop", "*", "--percent", "50", "--hard", "60").status).toBe(0);
    expect(verdict("rafa")[0]).toBe("park");
    expect(cli("set", "--loop", "ralph", "--off").status).toBe(0);
    expect(verdict("ralph")[0]).toBe("run");
    expect(cli("clear", "--loop", "ralph").status).toBe(0);
    expect(verdict("ralph")[0]).toBe("park");
    const file = JSON.parse(readFileSync(join(root, "override.json"), "utf8"));
    expect(Object.keys(file.entries)).toEqual(["*"]);
  });

  it("refuses an override the schema would refuse, and writes nothing", () => {
    project(BASE_CONFIG);
    const out = cli("set", "--loop", "ralph", "--percent", "120");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("whole number from 1 to 100");
    expect(cli("show", "--loop", "ralph").stdout).toContain('"source": "none"');
  });

  it("waives the stop until the watched window resets", () => {
    project({ ...BASE_CONFIG, usageStop: { percent: 80 } });
    expect(cli("waive", "--loop", "ralph").status).toBe(2);
    spend(0.97);
    expect(verdict("ralph")[0]).toBe("park");
    const out = cli("waive", "--loop", "ralph");
    expect(out.status).toBe(0);
    expect(verdict("ralph")[0]).toBe("run");
    const file = JSON.parse(readFileSync(join(root, "override.json"), "utf8"));
    expect(Date.parse(file.entries.ralph.waiveUntil)).toBe((RESET + 120) * 1000);
  });

  it("runs when the override is garbage or the config unreadable", () => {
    project({ ...BASE_CONFIG, usageStop: { percent: 80 } });
    spend(0.99);
    writeFileSync(join(root, "override.json"), "{");
    expect(verdict("ralph")[0]).toBe("park");
    writeFileSync(join(root, ".ralph", "config.json"), "{");
    expect(verdict("ralph")[0]).toBe("run");
    expect(cli("check").stdout).toBe("run\t0\t-\tno loop named");
  });
});
