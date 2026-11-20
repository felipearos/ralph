// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { knob, readUsageLimit } from "./usage-limit";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs bun usage-limit.ts detect and remaining");

const OPTS = { marginSeconds: 120, defaultSeconds: 1800, minSeconds: 60 };
const NOW = Date.parse("2026-10-21T12:00:00Z");

const rateLimit = (info: Record<string, unknown>) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: info });
const rejected = (extra: Record<string, unknown> = {}) =>
  rateLimit({ status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false, ...extra });
const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (text: string) => JSON.stringify({ type: "result", result: text });

describe("readUsageLimit", () => {
  it("reads a rejected five_hour reset from resetsAt plus the margin", () => {
    const resetsAt = NOW / 1000 + 3600;
    expect(readUsageLimit([rejected({ resetsAt })], NOW, OPTS)).toEqual({
      untilMs: (resetsAt + 120) * 1000, window: "five_hour", source: "event",
    });
  });

  it("ignores overageStatus rejected on an allowed_warning event", () => {
    const line = rateLimit({ status: "allowed_warning", overageStatus: "rejected", rateLimitType: "five_hour" });
    expect(readUsageLimit([line], NOW, OPTS)).toBeNull();
  });

  it("treats a rejection overage absorbed as no limit", () => {
    expect(readUsageLimit([rejected({ isUsingOverage: true, resetsAt: NOW / 1000 })], NOW, OPTS)).toBeNull();
    expect(readUsageLimit([rejected({ overageInUse: true, resetsAt: NOW / 1000 })], NOW, OPTS)).toBeNull();
  });

  it("decides on the last rate_limit_event", () => {
    const allowed = rateLimit({ status: "allowed", rateLimitType: "five_hour" });
    const limited = rejected({ resetsAt: NOW / 1000 + 60 });
    expect(readUsageLimit([limited, allowed], NOW, OPTS)).toBeNull();
    expect(readUsageLimit([allowed, limited], NOW, OPTS)?.source).toBe("event");
  });

  it("needs the event: the text alone is no limit", () => {
    expect(readUsageLimit([result("You've hit your session limit · resets 10:30pm (America/Santiago)")], NOW, OPTS))
      .toBeNull();
  });

  it("skips unparseable lines", () => {
    expect(readUsageLimit(["{not json", "", rejected({ resetsAt: NOW / 1000 })], NOW, OPTS)?.source).toBe("event");
  });

  it("falls back to the next occurrence of the text's wall-clock time", () => {
    const text = "You've hit your session limit · resets 10:30pm (America/Santiago)";
    // Santiago is UTC-3 in October 2026: 10:30pm there is 01:30Z the next day.
    const morning = Date.parse("2026-10-21T12:00:00Z");
    // seven_day so the five-hour cap does not mask the computed reset.
    expect(readUsageLimit([rejected({ rateLimitType: "seven_day" }), assistant(text)], morning, OPTS)).toEqual({
      untilMs: Date.parse("2026-10-22T01:30:00Z") + 120_000, window: "seven_day", source: "text",
    });
    // 23:00 in Santiago, past 10:30pm: the next occurrence is tomorrow night.
    const lateNight = Date.parse("2026-10-22T02:00:00Z");
    expect(readUsageLimit([rejected({ rateLimitType: "seven_day" }), result(text)], lateNight, OPTS)).toEqual({
      untilMs: Date.parse("2026-10-23T01:30:00Z") + 120_000, window: "seven_day", source: "text",
    });
  });

  it("uses the last text match and reads 12am and 12pm", () => {
    const week = rejected({ rateLimitType: "seven_day" });
    const lines = [week, assistant("resets 3pm (UTC)"), result("resets 12am (UTC)")];
    expect(readUsageLimit(lines, NOW, OPTS)?.untilMs).toBe(Date.parse("2026-10-22T00:00:00Z") + 120_000);
    const noon = readUsageLimit([rejected(), result("resets 12pm (UTC)")], Date.parse("2026-10-21T10:00:00Z"), OPTS);
    expect(noon?.untilMs).toBe(Date.parse("2026-10-21T12:00:00Z") + 120_000);
  });

  it("waits the default when the zone is unknown or there is no text", () => {
    const expected = { untilMs: NOW + 1_800_000, window: "five_hour", source: "default" };
    expect(readUsageLimit([rejected(), result("resets 10:30pm (Mars/Olympus)")], NOW, OPTS)).toEqual(expected);
    expect(readUsageLimit([rejected()], NOW, OPTS)).toEqual(expected);
    expect(readUsageLimit([rateLimit({ status: "rejected" })], NOW, OPTS)?.window).toBe("unknown");
  });

  it("caps the wait at the limit's window", () => {
    const weekOut = NOW / 1000 + 7 * 86_400;
    expect(readUsageLimit([rejected({ resetsAt: weekOut })], NOW, OPTS)?.untilMs).toBe(NOW + 18_000_000);
  });

  it("waits only the margin for a reset already past", () => {
    expect(readUsageLimit([rejected({ resetsAt: NOW / 1000 - 600 })], NOW, OPTS)?.untilMs).toBe(NOW + 120_000);
  });

  it("never arms a wait shorter than the floor, so a retry is never back to back", () => {
    const none = { marginSeconds: 0, defaultSeconds: 0, minSeconds: 60 };
    expect(readUsageLimit([rejected({ resetsAt: NOW / 1000 - 600 })], NOW, none)?.untilMs).toBe(NOW + 60_000);
    expect(readUsageLimit([rejected()], NOW, none)?.untilMs).toBe(NOW + 60_000);
    // A floor of 0 is still one second.
    expect(readUsageLimit([rejected()], NOW, { ...none, minSeconds: 0 })?.untilMs).toBe(NOW + 1000);
  });
});

describe("knob", () => {
  it("falls back to the default on a malformed value", () => {
    expect(knob("60", 120)).toBe(60);
    expect(knob("0", 120)).toBe(0);
    expect(knob("-5", 120)).toBe(120);
    expect(knob("soon", 120)).toBe(120);
    expect(knob(undefined, 120)).toBe(120);
  });
});

describe("usage-limit.ts CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-limit-"));
    dirs.push(dir);
    return dir;
  };
  const run = (args: string[]) =>
    spawnSync("bun", [join(import.meta.dirname, "usage-limit.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, RALPH_USAGE_NOW_MS: String(NOW), TZ: "UTC" },
    });

  it("detect writes the state and prints the wait", () => {
    const dir = scratch();
    const events = join(dir, "iter-1.events.jsonl");
    const state = join(dir, "nested", "usage-wait.json");
    writeFileSync(events, `${rejected({ resetsAt: NOW / 1000 + 3600 })}\n`);
    const detected = run(["detect", "--events", events, "--state", state]);
    expect(detected.status).toBe(0);
    expect(detected.stdout).toBe("waiting for usage reset until 13:02 (five_hour, event)\n");
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({
      until: "2026-10-21T13:02:00.000Z", window: "five_hour", source: "event", armedAt: "2026-10-21T12:00:00.000Z",
    });
    const left = run(["remaining", "--state", state]);
    expect([left.status, left.stdout]).toEqual([0, "3720\n"]);
  });

  it("detect exits 1 without state when not limited or the events are missing", () => {
    const dir = scratch();
    const events = join(dir, "iter-1.events.jsonl");
    const state = join(dir, "usage-wait.json");
    writeFileSync(events, `${rateLimit({ status: "allowed", overageStatus: "rejected" })}\n`);
    const allowed = run(["detect", "--events", events, "--state", state]);
    expect([allowed.status, allowed.stdout]).toEqual([1, ""]);
    const missing = run(["detect", "--events", join(dir, "nope.jsonl"), "--state", state]);
    expect([missing.status, missing.stdout]).toEqual([1, ""]);
    expect(existsSync(state)).toBe(false);
  });

  it("remaining prints 0 and exits 1 on missing or malformed state", () => {
    const dir = scratch();
    const missing = run(["remaining", "--state", join(dir, "usage-wait.json")]);
    expect([missing.status, missing.stdout]).toEqual([1, "0\n"]);
    const malformed = join(dir, "bad.json");
    writeFileSync(malformed, "{");
    expect(run(["remaining", "--state", malformed]).stdout).toBe("0\n");
  });
});
