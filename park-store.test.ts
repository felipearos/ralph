// @vitest-environment node
/**
 * The park store (#774, for #770): the durable per-ticket record of what a
 * parked ticket waits on, which must outlive the supervisor that wrote it.
 *
 * Every test writes into its own temp directory or fixture checkout, never
 * into this repository's git dir or `.ralph/`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { subprocessSuite } from "./test-timeouts";

import {
  budgetHours,
  type Condition,
  emptyStore,
  listStore,
  main,
  markChecked,
  markEscalated,
  park,
  type ParkInput,
  parkStorePath,
  readStore,
  type Store,
  unpark,
  unparkIf,
  validateCondition,
  withStore,
} from "./park-store";

subprocessSuite("git for commonStatePath, and bun for the CLI");

const SCRIPT = fileURLToPath(new URL("./park-store.ts", import.meta.url));
const roots: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(joinPath(tmpdir(), "park-store-"));
  roots.push(dir);
  return dir;
};
const storeFile = (): string => joinPath(tempDir(), "ralph-parks.json");
const readFile = (path: string): Store => JSON.parse(readFileSync(path, "utf8")) as Store;

afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const T0 = "2026-10-22T10:00:00.000Z";
const T1 = "2026-10-22T11:00:00.000Z";

const input = (over: Partial<ParkInput> = {}): ParkInput => ({
  ticket: 12,
  loop: "ralph",
  label: "ralph-blocked",
  pr: 34,
  condition: { kind: "reference", ref: "#56" },
  summary: "waits on #56",
  ...over,
});

/** A pid that certainly belonged to a process on this host and is now gone. */
function deadPid(): number {
  const child = spawnSync("true");
  if (!child.pid) throw new Error("could not spawn a short-lived process");
  return child.pid;
}

/** Run `main` with console captured; returns the exit code and what it printed. */
async function run(argv: string[], env: Record<string, string | undefined>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { err.push(args.join(" ")); });
  const code = await main(argv, env as NodeJS.ProcessEnv);
  vi.restoreAllMocks();
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function bunCli(argv: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync("bun", [SCRIPT, ...argv], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe("parkStorePath", () => {
  it("resolves one ralph-parks.json in git's common directory from every worktree", () => {
    const root = tempDir();
    const primary = joinPath(root, "main");
    mkdirSync(primary);
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };
    git(primary, "init", "-q", "-b", "main");
    writeFileSync(joinPath(primary, "README"), "fixture\n");
    git(primary, "add", "README");
    git(primary, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    git(primary, "worktree", "add", "-q", joinPath(root, "other"), "-b", "other");

    const fromMain = parkStorePath(primary);
    expect(parkStorePath(joinPath(root, "other"))).toBe(fromMain);
    expect(fromMain.endsWith("/ralph-parks.json")).toBe(true);
    expect(fromMain.startsWith(realpathSync(root))).toBe(true);
  });

  it("RALPH_PARK_STORE, trimmed and non-empty, names the file the CLI writes", async () => {
    const path = storeFile();
    const { code } = await run(
      ["park", "--ticket", "1", "--loop", "ralph", "--label", "ralph-blocked", "--condition", '{"kind":"reference","ref":"#2"}', "--summary", "s"],
      { RALPH_PARK_STORE: `  ${path}  ` },
    );
    expect(code).toBe(0);
    expect(Object.keys(readFile(path).parks)).toEqual(["1"]);
  });
});

describe("validateCondition", () => {
  const ok: Array<[unknown, number | null, Condition]> = [
    [{ kind: "reference", ref: "#7" }, null, { kind: "reference", ref: "#7" }],
    [{ kind: "reference", ref: " owner/repo.x#7 " }, null, { kind: "reference", ref: "owner/repo.x#7" }],
    [{ kind: "check", name: "ci", on: "main" }, null, { kind: "check", name: "ci", on: "main" }],
    [{ kind: "check", name: " ci ", on: "pr" }, 3, { kind: "check", name: "ci", on: "pr" }],
    [{ kind: "step", check: "buildkite", step: "test" }, null, { kind: "step", check: "buildkite", step: "test" }],
    [{ kind: "label-removed", label: "rafa-blocked" }, null, { kind: "label-removed", label: "rafa-blocked" }],
  ];
  it.each(ok)("accepts %j (pr %s)", (raw, pr, expected) => {
    expect(validateCondition(raw, pr)).toEqual(expected);
  });

  const refused: Array<[unknown, number | null]> = [
    [null, null],
    [[], null],
    ["#7", null],
    [{ kind: "nope" }, null],
    [{ ref: "#7" }, null],
    [{ kind: "reference", ref: "7" }, null],
    [{ kind: "reference", ref: "#0" }, null],
    [{ kind: "reference", ref: "owner#7" }, null],
    [{ kind: "reference", ref: 7 }, null],
    [{ kind: "reference" }, null],
    [{ kind: "reference", ref: "#7", extra: 1 }, null],
    [{ kind: "check", on: "main" }, null],
    [{ kind: "check", name: "  ", on: "main" }, null],
    [{ kind: "check", name: "ci", on: "branch" }, null],
    [{ kind: "check", name: "ci" }, null],
    [{ kind: "check", name: "ci", on: "pr" }, null],
    [{ kind: "step", check: "ci" }, null],
    [{ kind: "step", step: "test" }, null],
    [{ kind: "step", check: "", step: "test" }, null],
    [{ kind: "label-removed", label: "rafa-wip" }, null],
    [{ kind: "label-removed" }, null],
  ];
  it.each(refused)("refuses %j (pr %s) with a reason", (raw, pr) => {
    expect(typeof validateCondition(raw, pr)).toBe("string");
  });

  it("tells a check on the PR with no PR to pass --pr", () => {
    expect(validateCondition({ kind: "check", name: "ci", on: "pr" }, null)).toMatch(/--pr/);
  });
});

describe("pure mutators", () => {
  it("park records a ticket with a 48h budget and empty marks", () => {
    const store = emptyStore();
    const record = park(store, input(), T0);
    expect(record).toEqual({
      ticket: 12, loop: "ralph", label: "ralph-blocked", pr: 34,
      condition: { kind: "reference", ref: "#56" }, summary: "waits on #56",
      since: T0, lastChecked: null, budgetUntil: "2026-10-24T10:00:00.000Z", escalatedAt: null,
    });
    expect(store.parks["12"]).toBe(record);
  });

  it("a second park of one ticket replaces the record: fresh since and budget, cleared marks", () => {
    const store = emptyStore();
    const first = park(store, input(), T0);
    first.lastChecked = T0;
    first.escalatedAt = T0;
    const second = park(store, input({ condition: { kind: "label-removed", label: "x-blocked" }, summary: "new" }), T1, 2);
    expect(Object.keys(store.parks)).toEqual(["12"]);
    expect(second).toMatchObject({ since: T1, budgetUntil: "2026-10-22T13:00:00.000Z", lastChecked: null, escalatedAt: null, summary: "new" });
    expect(second.condition).toEqual({ kind: "label-removed", label: "x-blocked" });
  });

  it("park throws on an invalid input, so withStore writes nothing", async () => {
    const path = storeFile();
    await expect(withStore(path, (store) => park(store, input({ condition: { kind: "check", name: "ci", on: "pr" }, pr: null }), T0)))
      .rejects.toThrow(/--pr/);
    expect(existsSync(path)).toBe(false);
  });

  it("unpark removes a ticket and says whether it was parked", () => {
    const store = emptyStore();
    park(store, input(), T0);
    expect(unpark(store, 12)).toBe(true);
    expect(unpark(store, 12)).toBe(false);
    expect(store.parks).toEqual({});
  });

  it("markChecked stamps lastChecked only on the park read at that since", () => {
    const store = emptyStore();
    park(store, input(), T0);
    expect(markChecked(store, 12, T1, T1)).toBe(false);
    expect(store.parks["12"]!.lastChecked).toBeNull();
    expect(markChecked(store, 12, T0, T1)).toBe(true);
    expect(store.parks["12"]!.lastChecked).toBe(T1);
    expect(markChecked(store, 99, T0, T1)).toBe(false);
  });

  it("markEscalated stamps once, sets lastChecked, and leaves a replaced park alone", () => {
    const store = emptyStore();
    park(store, input(), T0);
    expect(markEscalated(store, 12, T0, T1)).toBe(true);
    expect(store.parks["12"]).toMatchObject({ escalatedAt: T1, lastChecked: T1 });
    expect(markEscalated(store, 12, T0, "2026-10-22T12:00:00.000Z")).toBe(false);
    expect(store.parks["12"]!.escalatedAt).toBe(T1);
    park(store, input(), T1);
    expect(markEscalated(store, 12, T0, T1)).toBe(false);
    expect(store.parks["12"]!.escalatedAt).toBeNull();
  });

  it("unparkIf removes only the park read at that since", () => {
    const store = emptyStore();
    park(store, input(), T1);
    expect(unparkIf(store, 12, T0)).toBe(false);
    expect(Object.keys(store.parks)).toEqual(["12"]);
    expect(unparkIf(store, 12, T1)).toBe(true);
    expect(store.parks).toEqual({});
    expect(unparkIf(store, 12, T1)).toBe(false);
  });
});

describe("budgetHours", () => {
  it.each([
    [undefined, 48], ["", 48], ["0", 48], ["-3", 48], ["abc", 48], ["Infinity", 48], ["NaN", 48],
    ["6", 6], [" 1.5 ", 1.5], ["87600", 87_600], ["87601", 48], ["9999999999", 48],
  ])("%j -> %s", (raw, hours) => {
    expect(budgetHours(raw)).toBe(hours);
  });
});

describe("the file", () => {
  it("withStore writes atomically and leaves no lock or temp file behind", async () => {
    const path = storeFile();
    await withStore(path, (store) => park(store, input(), T0));
    expect(readFile(path).version).toBe(1);
    expect(readdirSync(joinPath(path, ".."))).toEqual(["ralph-parks.json"]);
  });

  it("breaks a lock older than 30s", async () => {
    const path = storeFile();
    writeFileSync(`${path}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    await withStore(path, (store) => park(store, input(), T0));
    expect(Object.keys(readStore(path).parks)).toEqual(["12"]);
  });

  it("gives up on a held lock with a park store error", async () => {
    const path = storeFile();
    writeFileSync(`${path}.lock`, "");
    await expect(withStore(path, () => 1, { attempts: 3, delayMs: 1 })).rejects.toThrow(/the park store is locked/);
  });

  it("by default waits past the 30s a lock takes to go stale", async () => {
    const path = storeFile();
    writeFileSync(`${path}.lock`, "");
    // 29s old: not stale yet, but it will be within the default wait.
    const old = new Date(Date.now() - 29_000);
    utimesSync(`${path}.lock`, old, old);
    await withStore(path, (store) => park(store, input(), T0));
    expect(Object.keys(readStore(path).parks)).toEqual(["12"]);
  });

  it("refuses to write over a file a newer version wrote, and reads it as empty", async () => {
    const path = storeFile();
    const content = JSON.stringify({ version: 2, parks: { "12": { anything: true } } });
    writeFileSync(path, content);
    expect(readStore(path)).toEqual(emptyStore());
    await expect(withStore(path, (store) => park(store, input(), T0))).rejects.toThrow(/newer ralph/);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it.each([
    ["missing", null],
    ["not JSON", "{nope"],
    ["an unknown version", JSON.stringify({ version: 0, parks: {} })],
    ["parks not an object", JSON.stringify({ version: 1, parks: [] })],
  ])("a %s file reads as empty, and the next write repairs it", async (_name, content) => {
    const path = storeFile();
    if (content !== null) writeFileSync(path, content);
    expect(readStore(path)).toEqual(emptyStore());
    expect(listStore(path)).toEqual([]);
    await withStore(path, (store) => park(store, input(), T0));
    expect(Object.keys(readFile(path).parks)).toEqual(["12"]);
  });

  it("drops malformed park records and keeps the good one", async () => {
    const path = storeFile();
    const good = park(emptyStore(), input(), T0);
    writeFileSync(path, JSON.stringify({
      version: 1,
      parks: {
        "12": good,
        "13": { ...good, ticket: 13, condition: { kind: "nope" } },
        "14": { ...good, ticket: 14, condition: { kind: "check", name: "ci", on: "pr" }, pr: null },
        "15": { ...good, ticket: 15, loop: "" },
        "16": { ...good, ticket: 99 },
        "abc": { ...good },
        "17": "not a park",
      },
    }));
    expect(Object.keys(readStore(path).parks)).toEqual(["12"]);
    expect(listStore(path).map((p) => p.ticket)).toEqual([12]);
  });

  it.each([
    ["a label that is not the loop's", { label: "rafa-blocked" }],
    ["a since that is not a date", { since: "yesterday" }],
    ["a budgetUntil that is not a date", { budgetUntil: "garbage" }],
  ])("drops a record with %s", (_name, over) => {
    const path = storeFile();
    const good = park(emptyStore(), input(), T0);
    writeFileSync(path, JSON.stringify({ version: 1, parks: { "12": { ...good, ...over } } }));
    expect(readStore(path)).toEqual(emptyStore());
  });

  it("a write keeps the records it could not read, unless it replaced them", async () => {
    // An older loop sharing the file with a newer one must not erase the
    // newer one's parks by writing back only what it understood.
    const path = storeFile();
    const good = park(emptyStore(), input(), T0);
    const future = { ...good, ticket: 20, condition: { kind: "deploy", env: "prod" } };
    const stale = { ...good, ticket: 21, condition: { kind: "deploy", env: "prod" } };
    writeFileSync(path, JSON.stringify({ version: 1, parks: { "12": good, "20": future, "21": stale } }));
    await withStore(path, (store) => { unpark(store, 12); park(store, input({ ticket: 21 }), T0); });
    const written = readFile(path).parks as Record<string, unknown>;
    expect(written["20"]).toEqual(future);
    expect(written["21"]).toEqual(park(emptyStore(), input({ ticket: 21 }), T0));
    expect(written["12"]).toBeUndefined();
  });

  it("listStore marks a park expired once now is past its budget", () => {
    const path = storeFile();
    const store = emptyStore();
    park(store, input(), T0, 1);
    park(store, input({ ticket: 3 }), T0, 48);
    writeFileSync(path, JSON.stringify(store));
    const listed = listStore(path, "2026-10-22T12:00:00.000Z");
    expect(listed.map((p) => [p.ticket, p.expired])).toEqual([[3, false], [12, true]]);
    expect(listed[1]).toMatchObject({ ...store.parks["12"], expired: true });
    expect(listStore(path, "2026-10-22T10:30:00.000Z").every((p) => !p.expired)).toBe(true);
  });
});

describe("no liveness pruning", () => {
  it("a park written by a CLI process that has exited, under a dead supervisor pid, still reads back", async () => {
    const path = storeFile();
    const dead = String(deadPid());
    const child = bunCli(
      ["park", "--ticket", "40", "--loop", "gone", "--label", "gone-blocked", "--pr", "9",
        "--condition", '{"kind":"check","name":"ci","on":"pr"}', "--summary", "waits on ci", "--json"],
      { RALPH_PARK_STORE: path, RALPH_SUPERVISOR_PID: dead },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ ticket: 40, loop: "gone", pr: 9 });

    expect(Object.keys(readStore(path).parks)).toEqual(["40"]);
    expect(listStore(path).map((p) => p.ticket)).toEqual([40]);
    await withStore(path, () => undefined);
    expect(Object.keys(readFile(path).parks)).toEqual(["40"]);

    const listed = bunCli(["list", "--json"], { RALPH_PARK_STORE: path, RALPH_SUPERVISOR_PID: dead });
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ ticket: 40, loop: "gone", expired: false })]);
  });

  it("the module imports nothing from host-lease", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/from "\.\/host-lease"/);
  });
});

describe("CLI", () => {
  const parkArgs = (over: Record<string, string> = {}): string[] => {
    const flags: Record<string, string> = {
      ticket: "12", loop: "ralph", label: "ralph-blocked",
      condition: '{"kind":"reference","ref":"#56"}', summary: "waits on #56", ...over,
    };
    return ["park", ...Object.entries(flags).flatMap(([name, value]) => [`--${name}`, value])];
  };

  it("park records, list shows it, unpark removes it and says which", async () => {
    const path = storeFile();
    const env = { RALPH_PARK_STORE: path };
    const parked = await run([...parkArgs({ pr: "34" }), "--json"], env);
    expect(parked.code).toBe(0);
    expect(JSON.parse(parked.out)).toMatchObject({ ticket: 12, pr: 34, lastChecked: null, escalatedAt: null });

    const human = await run(["list"], env);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^#12 .*reference/);
    expect(human.out).not.toMatch(/EXPIRED/);

    const listed = await run(["list", "--json"], env);
    expect(JSON.parse(listed.out)).toEqual([expect.objectContaining({ ticket: 12, expired: false })]);

    expect((await run(["unpark", "--ticket", "12"], env)).out).toMatch(/no longer parked/);
    const again = await run(["unpark", "--ticket", "12"], env);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/was not parked/);
    expect((await run(["list"], env)).out).toMatch(/no ticket is parked/);
  });

  it("list marks an expired park", async () => {
    const path = storeFile();
    const store = emptyStore();
    park(store, input(), "2020-01-01T00:00:00.000Z");
    writeFileSync(path, JSON.stringify(store));
    expect((await run(["list"], { RALPH_PARK_STORE: path })).out).toMatch(/#12 .*EXPIRED/);
  });

  it("RALPH_PARK_BUDGET_HOURS sets the budget; an invalid value falls back to 48", async () => {
    for (const [raw, hours] of [["6", 6], ["0", 48], ["-1", 48], ["abc", 48]] as const) {
      const path = storeFile();
      const { code, out } = await run([...parkArgs(), "--json"], { RALPH_PARK_STORE: path, RALPH_PARK_BUDGET_HOURS: raw });
      expect(code).toBe(0);
      const record = JSON.parse(out) as { since: string; budgetUntil: string };
      expect(Date.parse(record.budgetUntil) - Date.parse(record.since)).toBe(hours * 3_600_000);
    }
  });

  const refusals: Array<[string, string[]]> = [
    ["an unknown kind", parkArgs({ condition: '{"kind":"nope"}' })],
    ["a malformed reference", parkArgs({ condition: '{"kind":"reference","ref":"56"}' })],
    ["a check with no name", parkArgs({ condition: '{"kind":"check","on":"main"}' })],
    ["a check on a branch", parkArgs({ condition: '{"kind":"check","name":"ci","on":"dev"}' })],
    ["a check on the PR with no PR", parkArgs({ condition: '{"kind":"check","name":"ci","on":"pr"}' })],
    ["a step with no step", parkArgs({ condition: '{"kind":"step","check":"ci"}' })],
    ["a step with no check", parkArgs({ condition: '{"kind":"step","step":"test"}' })],
    ["a label that is not -blocked", parkArgs({ condition: '{"kind":"label-removed","label":"ralph-wip"}' })],
    ["a park label that is not the loop's own", parkArgs().map((arg) => (arg === "ralph-blocked" ? "rafa-blocked" : arg))],
    ["a condition that is not JSON", parkArgs({ condition: "{kind" })],
    ["a ticket of zero", parkArgs({ ticket: "0" })],
    ["a ticket that is not a number", parkArgs({ ticket: "abc" })],
    ["a blank loop", parkArgs({ loop: " " })],
    ["a blank summary", parkArgs({ summary: " " })],
    ["a pr that is not a positive integer", parkArgs({ pr: "-2" })],
    ["a missing ticket", parkArgs().filter((_, i, all) => all[i] !== "--ticket" && all[i - 1] !== "--ticket")],
    ["a missing label", parkArgs().filter((_, i, all) => all[i] !== "--label" && all[i - 1] !== "--label")],
    ["a missing summary", parkArgs().filter((_, i, all) => all[i] !== "--summary" && all[i - 1] !== "--summary")],
    ["a missing condition", parkArgs().filter((_, i, all) => all[i] !== "--condition" && all[i - 1] !== "--condition")],
    ["a flag given without a value", ["park", "--ticket", "--loop", "ralph", "--label", "ralph-blocked", "--condition", '{"kind":"reference","ref":"#1"}', "--summary", "s"]],
    ["a trailing flag without a value", [...parkArgs(), "--pr"]],
    ["an unpark with no ticket", ["unpark"]],
    ["an unknown command", ["frobnicate"]],
    ["no command", []],
  ];
  it.each(refusals)("refuses %s with 64, a reason on stderr, and writes nothing", async (_name, argv) => {
    const dir = tempDir();
    const path = joinPath(dir, "ralph-parks.json");
    const { code, err } = await run(argv, { RALPH_PARK_STORE: path });
    expect(code).toBe(64);
    expect(err).not.toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a refused park leaves an existing file unchanged", async () => {
    const path = storeFile();
    await run(parkArgs(), { RALPH_PARK_STORE: path });
    const before = readFileSync(path, "utf8");
    const { code } = await run(parkArgs({ condition: '{"kind":"nope"}' }), { RALPH_PARK_STORE: path });
    expect(code).toBe(64);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  describe("check", () => {
    it("prints the normalised condition and creates nothing", async () => {
      const dir = tempDir();
      const env = { RALPH_PARK_STORE: joinPath(dir, "sub", "ralph-parks.json") };
      const { code, out } = await run(["check", "--condition", '{"kind":"step","check":" ci ","step":"test"}'], env);
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({ kind: "step", check: "ci", step: "test" });
      expect(readdirSync(dir)).toEqual([]);
    });

    it("accepts a check on the PR when --pr is given", async () => {
      const { code } = await run(["check", "--pr", "3", "--condition", '{"kind":"check","name":"ci","on":"pr"}'], {});
      expect(code).toBe(0);
    });

    it("refuses a check on the PR without --pr, and says to pass it", async () => {
      const dir = tempDir();
      const { code, err } = await run(["check", "--condition", '{"kind":"check","name":"ci","on":"pr"}'], { RALPH_PARK_STORE: joinPath(dir, "p.json") });
      expect(code).toBe(64);
      expect(err).toMatch(/--pr/);
      expect(readdirSync(dir)).toEqual([]);
    });

    it.each([
      ['{"kind":"nope"}'], ["not json"], ['{"kind":"reference","ref":"#1","x":1}'],
    ])("refuses %s with 64", async (condition) => {
      expect((await run(["check", "--condition", condition], {})).code).toBe(64);
    });

    it("refuses a missing condition and a bad --pr", async () => {
      expect((await run(["check"], {})).code).toBe(64);
      expect((await run(["check", "--pr", "x", "--condition", '{"kind":"reference","ref":"#1"}'], {})).code).toBe(64);
    });

    it("runs as a bun subprocess with the same exit codes", () => {
      const dir = tempDir();
      const env = { RALPH_PARK_STORE: joinPath(dir, "ralph-parks.json") };
      const good = bunCli(["check", "--condition", '{"kind":"reference","ref":"o/r#5"}'], env);
      expect(good.status).toBe(0);
      expect(JSON.parse(good.stdout)).toEqual({ kind: "reference", ref: "o/r#5" });
      const bad = bunCli(["check", "--condition", '{"kind":"label-removed","label":"x"}'], env);
      expect(bad.status).toBe(64);
      expect(bad.stderr).toMatch(/-blocked/);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
