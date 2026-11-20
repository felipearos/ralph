// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "./test-timeouts";

import {
  formatDuration,
  main,
  measureSpeed,
  readSpeedLedger,
  recordSpeedEvent,
  speedReport,
  type SpeedEvent,
  type SpeedKind,
} from "./speed";

subprocessSuite("git, for the ledger's common-dir lookup outside a repository");

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch ledger directory: never the checkout's git common dir, which live loops share. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-speed-"));
  scratch.push(dir);
  return dir;
}

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function ev(kind: SpeedKind, seconds: number, extra: Partial<SpeedEvent> = {}): SpeedEvent {
  return {
    v: 1,
    at: at(seconds),
    kind,
    loop: "rafa",
    project: "software-factory",
    ticket: null,
    session: null,
    run: "run-1",
    iteration: null,
    ...extra,
  };
}

function writeLedger(dir: string, events: readonly SpeedEvent[]): void {
  mkdirSync(dir, { recursive: true });
  for (const event of events) appendFileSync(join(dir, `${event.loop}.jsonl`), `${JSON.stringify(event)}\n`);
}

/** Five tickets: claim-to-hand-off 600, 1200, 1800, 3600 s, and an older 7200 s one. */
function fixture(): SpeedEvent[] {
  const events: SpeedEvent[] = [];
  const durations: Array<[string, number, number]> = [
    ["1", 0, 600],
    ["2", 10_000, 1200],
    ["3", 20_000, 1800],
    ["4", 30_000, 3600],
    ["5", -20 * 86_400, 7200],
  ];
  for (const [ticket, start, length] of durations) {
    events.push(ev("claimed", start, { ticket }));
    events.push(ev("handed-off", start + length, { ticket, pr: `https://github.com/x/y/pull/${ticket}` }));
  }
  events.push(ev("claimed", 50_000, { ticket: "6" }));
  return events;
}

function run(argv: string[], env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { env, cwd: tmpdir(), out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("speed report", () => {
  it("computes median and p90 exactly, and --since drops older hand-offs", () => {
    const all = speedReport(fixture())[0]!;
    expect(all.handedOff).toBe(5);
    expect(all.inFlight).toBe(1);
    expect(all.medianClaimToHandoffSeconds).toBe(1800);
    expect(all.p90ClaimToHandoffSeconds).toBe(7200);
    expect(all.slowest.map((m) => m.ticket)).toEqual(["5", "4", "3", "2", "1"]);

    const recent = speedReport(fixture(), { since: new Date("2026-10-10") })[0]!;
    expect(recent.handedOff).toBe(4);
    expect(recent.medianClaimToHandoffSeconds).toBe(1500);
    expect(recent.p90ClaimToHandoffSeconds).toBe(3600);
    expect(speedReport(fixture(), { slowest: 2 })[0]?.slowest.map((m) => m.ticket)).toEqual(["5", "4"]);
    expect(speedReport(fixture(), { loop: "other" })).toEqual([]);
  });

  it("prints text and --json from the ledger directory, and refuses a bad --since", () => {
    const dir = scratchDir();
    writeLedger(dir, fixture());
    const env = { RALPH_SPEED_DIR: dir };

    const json = run(["report", "--since", "2026-10-10", "--json"], env);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.out);
    expect(doc.groups).toEqual(JSON.parse(JSON.stringify(speedReport(fixture(), { since: new Date("2026-10-10") }))));
    expect(doc.groups[0].medianClaimToHandoffSeconds).toBe(1500);

    const text = run(["report"], env);
    expect(text.code).toBe(0);
    expect(text.out).toContain("software-factory");
    expect(text.out).toContain("30m 00s");
    expect(text.out).toContain("2h 00m");

    expect(run(["report", "--since", "not-a-date"], env).code).toBe(2);
    expect(run(["report", "--bogus"], env).code).toBe(2);
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(725)).toBe("12m 05s");
    expect(formatDuration(3900)).toBe("1h 05m");
    expect(formatDuration(2 * 86_400 + 3 * 3600)).toBe("2d 03h");
    expect(formatDuration(null)).toBe("—");
  });
});

describe("measureSpeed", () => {
  it("counts a ticket over two iterations once, without the gap or the waits", () => {
    const events = [
      ev("iteration-start", -60, { iteration: 1 }),
      ev("claimed", 0, { ticket: "9", iteration: 1 }),
      ev("iteration-end", 600, { ticket: "9", iteration: 1, outcome: "RETRY_LATER", waitedSeconds: 100 }),
      ev("iteration-start", 3600, { ticket: "9", iteration: 2 }),
      ev("handed-off", 4000, { ticket: "9", iteration: 2, pr: "https://github.com/x/y/pull/9" }),
      ev("iteration-end", 4200, { iteration: 2, outcome: "DONE", waitedSeconds: 0 }),
    ];
    const { measured, inFlight } = measureSpeed(events);
    expect(inFlight).toEqual([]);
    expect(measured).toHaveLength(1);
    const m = measured[0]!;
    expect(m.claimToHandoffSeconds).toBe(4000);
    expect(m.iterations).toBe(2);
    // 600 s of iteration 1 inside the episode less its 100 s wait, plus 400 s of iteration 2.
    expect(m.activeSeconds).toBe(900);
    expect(m.activeSeconds).toBeLessThan(m.claimToHandoffSeconds);
    expect(m.pr).toBe("https://github.com/x/y/pull/9");
  });

  it("starts a new episode on a claim after the hand-off, and a release does not end one", () => {
    const events = [
      ev("claimed", 0, { ticket: "7" }),
      ev("released", 100, { ticket: "7" }),
      ev("claimed", 200, { ticket: "7" }),
      ev("merged", 1000, { ticket: "7" }),
      ev("claimed", 2000, { ticket: "7" }),
    ];
    const { measured, inFlight } = measureSpeed(events);
    expect(measured.map((m) => m.claimToHandoffSeconds)).toEqual([1000]);
    expect(inFlight.map((f) => f.claimedAt)).toEqual([at(2000)]);
  });

  it("does not count a blocked or released ticket as in flight until it is claimed again", () => {
    const blocked = measureSpeed([ev("claimed", 0, { ticket: "8" }), ev("blocked", 100, { ticket: "8" })]);
    expect(blocked.inFlight).toEqual([]);
    const reclaimed = measureSpeed([
      ev("claimed", 0, { ticket: "8" }),
      ev("released", 100, { ticket: "8" }),
      ev("claimed", 200, { ticket: "8" }),
    ]);
    expect(reclaimed.inFlight.map((f) => f.claimedAt)).toEqual([at(0)]);
  });
});

describe("recordSpeedEvent", () => {
  const baseEnv = (dir: string, iteration: string) => ({
    RALPH_SPEED_DIR: dir,
    RALPH_LOOP_NAME: "rafa",
    RALPH_PROJECT_ID: "software-factory",
    RALPH_SESSION_ID: "sess",
    RALPH_RUN_ID: "run-1",
    RALPH_ITERATION: iteration,
  });
  const lines = (dir: string) => readSpeedLedger(dir).events;

  it("fills the envelope from the environment and resolves the iteration ticket", () => {
    const dir = scratchDir();
    let clock = T0;
    const now = () => new Date((clock += 1000));
    const err: string[] = [];
    const record = (kind: SpeedKind, iteration: string, fields = {}) =>
      recordSpeedEvent(kind, fields, { env: baseEnv(dir, iteration), now, err: (l) => err.push(l) });

    // Nothing claimed yet: null.
    expect(record("iteration-start", "1")).toBeNull();
    // Same run+iteration named the ticket: it wins.
    record("claimed", "1", { ticket: "578" });
    record("iteration-end", "1", { outcome: "AWAIT_PR", waitedSeconds: 30 });
    // A later iteration finds the open claim.
    record("iteration-start", "2");
    record("handed-off", "2", { ticket: "578", pr: "https://github.com/x/y/pull/1" });
    // Claim closed: null again.
    record("iteration-start", "3");

    const events = lines(dir);
    expect(events.map((e) => [e.kind, e.ticket, e.iteration])).toEqual([
      ["iteration-start", null, 1],
      ["claimed", "578", 1],
      ["iteration-end", "578", 1],
      ["iteration-start", "578", 2],
      ["handed-off", "578", 2],
      ["iteration-start", null, 3],
    ]);
    expect(events[2]).toMatchObject({ outcome: "AWAIT_PR", waitedSeconds: 30, project: "software-factory" });
    expect(events[4]).toMatchObject({ pr: "https://github.com/x/y/pull/1", session: "sess", run: "run-1", loop: "rafa" });
    expect(err).toEqual([]);
  });

  it("prints one line and returns when the store cannot be written", () => {
    const dir = scratchDir();
    const file = join(dir, "a-file");
    writeFileSync(file, "");
    const err: string[] = [];
    const env = { RALPH_SPEED_DIR: join(file, "speed") };
    expect(() => recordSpeedEvent("claimed", { ticket: "1" }, { env, err: (l) => err.push(l) })).not.toThrow();
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^speed: could not record claimed: /);

    const cli = run(["record", "iteration-end", "--outcome", "DONE", "--waited", "5"], env);
    expect(cli.code).toBe(0);
    expect(cli.err).toMatch(/^speed: could not record iteration-end: /);
  });

  it("records through the CLI and refuses bad arguments", () => {
    const dir = scratchDir();
    const env = baseEnv(dir, "4");
    expect(run(["record", "claimed", "--ticket", "12"], env).code).toBe(0);
    expect(lines(dir)).toMatchObject([{ kind: "claimed", ticket: "12", iteration: 4 }]);
    expect(run(["record", "nope"], env).code).toBe(2);
    expect(run(["record", "claimed", "--frob"], env).code).toBe(2);
    expect(run(["record", "iteration-end", "--waited", "-1"], env).code).toBe(2);
    expect(run(["dance"], env).code).toBe(2);
  });
});

describe("readSpeedLedger", () => {
  it("skips and counts garbage lines, and a missing directory is empty", () => {
    const dir = scratchDir();
    writeLedger(dir, [ev("claimed", 0, { ticket: "1" })]);
    appendFileSync(join(dir, "rafa.jsonl"), "not json\n{\"v\":2}\n[]\n{\"v\":1,\"at\":\"x\",\"kind\":\"claimed\",\"loop\":\"r\"}\n{\"half\":");
    writeFileSync(join(dir, "notes.txt"), "ignored\n");
    const ledger = readSpeedLedger(dir);
    expect(ledger.events).toHaveLength(1);
    expect(ledger.skippedLines).toBe(5);
    expect(readFileSync(join(dir, "rafa.jsonl"), "utf8")).toContain("not json");
    expect(readSpeedLedger(join(dir, "missing"))).toEqual({ events: [], skippedLines: 0 });
  });
});

describe("outside a git repository", () => {
  // The fallback used to be a directory inside the cwd, which in a worktree is
  // an untracked file a PR could pick up. Now it is a reported failure.
  it("record logs one line and returns, and report exits 1", () => {
    const cwd = scratchDir();
    const env = { RALPH_LOOP_NAME: "rafa" };
    const errs: string[] = [];
    expect(recordSpeedEvent("claimed", { ticket: "1" }, { env, cwd, err: (line) => errs.push(line) })).not.toBeNull();
    expect(errs).toEqual([expect.stringMatching(/^speed: could not record claimed: .*not inside a git repository/)]);
    expect(main(["report"], { env, cwd, out: () => {}, err: (line) => errs.push(line) })).toBe(1);
    expect(readdirSync(cwd)).toEqual([]);
  });
});
