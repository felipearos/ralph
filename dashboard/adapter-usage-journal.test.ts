// @vitest-environment node
/**
 * Token usage and the journal, read through the adapter.
 *
 * Usage is exercised against the REAL `usage.py --json` with a scratch HOME
 * holding the session transcript, and the journal against a REAL git
 * repository standing in for the harness's `origin/main`. The properties are
 * about honesty and read-only-ness: usage is read for the loop's own run and
 * recorded session and never advances the ledger; a missing session,
 * transcript, ledger, model window or journal is absent, never zero or empty.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  COMMAND_SURFACE,
  RalphContractError,
  createRalphAdapter,
  narrowJournalEntry,
  narrowUsage,
} from "./adapter";
import {
  assistantTurn,
  cleanupFixtures,
  createFixture,
  createJournalRepo,
  writeLoopState,
  writeTranscript,
  type Fixture,
} from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives the ralph adapter, which spawns bun CLIs");

const REPO_ROOT = join(__dirname, "..");

afterAll(cleanupFixtures);

const adapterFor = (
  f: Fixture,
  over: { env?: Record<string, string>; journalHome?: string } = {},
) =>
  createRalphAdapter({
    cliDir: REPO_ROOT,
    roots: [f.root],
    journalHome: over.journalHome ?? join(f.root, "no-harness"),
    env: {
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      HOME: join(f.root, "home"),
      RALPH_JOURNAL_DIR: "",
      ...over.env,
    },
  });

const LEDGER_HEADER =
  "run_id\tsession\tstep\tts\tlabel\tmodel\tinput\toutput\tcache_5m\tcache_1h\tcache_read\n";
const ledgerRow = (run: string, session: string, input: number, output: number): string =>
  `${run}\t${session}\t1\t2026-09-13T11:00:00+00:00\tearlier\tclaude-opus-5\t${input}\t${output}\t0\t0\t0\n`;

const turn = (model = "claude-opus-5") =>
  assistantTurn("message-1", model, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 1000,
  });

describe("token usage through the adapter", () => {
  it("reads usage.py --json for the loop's own run and session without advancing the ledger", async () => {
    const f = createFixture("usage");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph", run: "run-ralph", detail: "session sess-1" });
    writeTranscript(join(f.root, "home"), ralph, "sess-1", [turn()]);
    const ledger = join(ralph, ".ralph", "logs", "usage-ledger.tsv");
    const ledgerText =
      LEDGER_HEADER + ledgerRow("run-ralph", "sess-0", 10, 5) + ledgerRow("run-other", "sess-9", 999, 999);
    writeFileSync(ledger, ledgerText);
    f.registry([ralph]);

    const usage = (await adapterFor(f).read()).loops[0]?.usage;
    expect(usage).toMatchObject({
      session: "sess-1",
      runId: "run-ralph",
      iteration: {
        turns: 1,
        usage: { input: 100, output: 50, cache5m: 0, cache1h: 0, cacheRead: 1000, inputTotal: 1100 },
      },
      // The run scope folds in the earlier session of the same run, and only it.
      run: { steps: 2, usage: { input: 110, output: 55 } },
      context: { model: "claude-opus-5", tokens: 1100, window: 1_000_000, percent: 0.1 },
    });
    expect(usage?.iteration.models).toEqual([
      { model: "claude-opus-5", usage: expect.objectContaining({ output: 50 }) },
    ]);
    // Read-only: the ledger is untouched and no step baseline was written.
    expect(readFileSync(ledger, "utf8")).toBe(ledgerText);
    expect(existsSync(join(ralph, ".ralph", "logs", "usage-state-sess-1.json"))).toBe(false);
  });

  it("takes the session the record kept once the state has moved past iteration-start", async () => {
    const f = createFixture("usage-kept-session");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph", run: "run-ralph", session: "sess-2" });
    writeTranscript(join(f.root, "home"), ralph, "sess-2", [turn()]);
    f.registry([ralph]);

    const usage = (await adapterFor(f).read()).loops[0]?.usage;
    expect(usage).toMatchObject({ session: "sess-2", runId: "run-ralph" });
  });

  it("reports usage as unknown when no session is recorded, rather than guessing the newest transcript", async () => {
    const f = createFixture("usage-no-session");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph", run: "run-ralph" });
    // An operator's own Claude session in the same checkout is not the loop's.
    writeTranscript(join(f.root, "home"), ralph, "someone-else", [turn()]);
    f.registry([ralph]);

    expect((await adapterFor(f).read()).loops[0]?.usage).toBeNull();
  });

  it("reports usage as unknown when the recorded session has no transcript", async () => {
    const f = createFixture("usage-no-transcript");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph", run: "run-ralph", detail: "session sess-1" });
    f.registry([ralph]);

    expect((await adapterFor(f).read()).loops[0]?.usage).toBeNull();
  });

  it("leaves the run scope and occupancy unknown, not zero, without a ledger or a known model", async () => {
    const f = createFixture("usage-no-ledger");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph", run: "run-ralph", detail: "session sess-1" });
    writeTranscript(join(f.root, "home"), ralph, "sess-1", [turn("mystery-model")]);
    f.registry([ralph]);

    const usage = (await adapterFor(f).read()).loops[0]?.usage;
    expect(usage?.iteration.usage.output).toBe(50);
    expect(usage?.run).toBeNull();
    expect(usage?.context).toEqual({ model: "mystery-model", tokens: 1100, window: null, percent: null });
    expect(existsSync(join(ralph, ".ralph", "logs", "usage-ledger.tsv"))).toBe(false);
  });

  it("reads usage without recording it", () => {
    expect(COMMAND_SURFACE.usage).toEqual({
      contract: "usage",
      script: "usage.py",
      args: ["--json", "--no-record"],
    });
    expect(COMMAND_SURFACE.journalList.args[0]).toBe("ls-tree");
    expect(COMMAND_SURFACE.journalRead.args[0]).toBe("cat-file");
  });
});

describe("the usage contract guard", () => {
  const scope = { input: 1, output: 2, cache_5m: 3, cache_1h: 4, cache_read: 5, input_total: 13 };
  const valid = {
    session: "s",
    run_id: "r",
    step: { number: 1, label: "step 1", usage: scope },
    iteration: { turns: 1, elapsed_seconds: null, elapsed: "—", usage: scope, models: { m: scope } },
    run: { steps: 1, usage: scope },
    context: { model: "m", tokens: 9, window: 100, percent: 9 },
  };

  it("accepts the shape usage.py emits and renames it into the dashboard's vocabulary", () => {
    expect(narrowUsage(valid)).toEqual({
      session: "s",
      runId: "r",
      iteration: {
        turns: 1,
        elapsedSeconds: null,
        usage: { input: 1, output: 2, cache5m: 3, cache1h: 4, cacheRead: 5, inputTotal: 13 },
        models: [{ model: "m", usage: { input: 1, output: 2, cache5m: 3, cache1h: 4, cacheRead: 5, inputTotal: 13 } }],
      },
      run: { steps: 1, usage: { input: 1, output: 2, cache5m: 3, cache1h: 4, cacheRead: 5, inputTotal: 13 } },
      context: { model: "m", tokens: 9, window: 100, percent: 9 },
    });
  });

  it("rejects a drifted shape rather than coercing it", () => {
    expect(() => narrowUsage({})).toThrow(RalphContractError);
    expect(() =>
      narrowUsage({ ...valid, iteration: { ...valid.iteration, usage: { ...scope, output: "2" } } }),
    ).toThrow(/iteration\.usage\.output/);
    expect(() => narrowUsage({ ...valid, run: undefined })).toThrow(/\$\.run/);
  });
});

const ENTRIES = [
  {
    name: "20260812T090000Z-99-dddddddddddd.md",
    body: "# 2026-08-12 — #99: before loops signed their entries\n\n**Outcome: merged.** PR #1.\n",
  },
  {
    // Multi-byte text early in the batch: every later entry depends on the
    // reader counting bytes, not characters.
    name: "20260913T100000Z-101-aaaaaaaaaaaa.md",
    body: "# 2026-09-13 — #101: ünïcode — and dashes\n\n**Outcome: merged.** Loop: **ralph**. PR #5.\n",
  },
  {
    name: "20260913T110000Z-none-bbbbbbbbbbbb.md",
    body: "# 2026-09-13 — nothing was ready\n\n**Outcome: all blocked.** Loop: **rafa** (worktree `x`).\n",
  },
  {
    name: "20260913T120000Z-102-cccccccccccc.md",
    body: "# 2026-09-13 — #102: a hard rail\n\n**Outcome: blocked (migration hard rail).** Loop: **Ralph**.\n",
  },
];

const EXAMPLE_CONFIG = JSON.parse(
  readFileSync(join(REPO_ROOT, "examples", ".ralph", "config.json"), "utf8"),
) as Record<string, unknown>;

describe("the journal through the adapter", () => {
  const withLoop = (label: string): { f: Fixture; ralph: string } => {
    const f = createFixture(label);
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph" });
    f.registry([ralph]);
    return { f, ralph };
  };

  it("reads every entry under the journal dir from the harness's origin/main", async () => {
    const { f } = withLoop("journal");
    const harness = createJournalRepo(f.root, "journal/test", ENTRIES);

    const snapshot = await adapterFor(f, {
      journalHome: harness,
      env: { RALPH_JOURNAL_DIR: "journal/test" },
    }).read();
    const journal = snapshot.loops[0]?.journal;
    expect(journal?.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name));
    expect(journal?.[0]).toEqual({
      name: "20260812T090000Z-99-dddddddddddd.md",
      at: "2026-08-12T09:00:00.000Z",
      issue: 99,
      loop: null,
      title: "2026-08-12 — #99: before loops signed their entries",
      outcome: "merged",
    });
    expect(journal?.[1]).toMatchObject({ issue: 101, loop: "ralph", title: "2026-09-13 — #101: ünïcode — and dashes" });
    expect(journal?.[2]).toMatchObject({ issue: null, loop: "rafa", outcome: "all blocked" });
    expect(journal?.[3]).toMatchObject({
      at: "2026-09-13T12:00:00.000Z",
      issue: 102,
      loop: "ralph",
      outcome: "blocked (migration hard rail)",
    });
  });

  it("finds the journal dir through project-config when no override is set", async () => {
    const { f } = withLoop("journal-config");
    const harness = createJournalRepo(f.root, "journal/test", ENTRIES);
    mkdirSync(join(f.root, ".ralph"), { recursive: true });
    writeFileSync(
      join(f.root, ".ralph", "config.json"),
      JSON.stringify({ ...EXAMPLE_CONFIG, journal: { dir: "journal/test" } }),
    );

    const journal = (await adapterFor(f, { journalHome: harness }).read()).loops[0]?.journal;
    expect(journal).toHaveLength(ENTRIES.length);
  });

  it("reports the journal as unknown when the harness has no origin/main", async () => {
    const { f } = withLoop("journal-no-origin");
    const harness = createJournalRepo(f.root, "journal/test", ENTRIES, { origin: false });

    const snapshot = await adapterFor(f, {
      journalHome: harness,
      env: { RALPH_JOURNAL_DIR: "journal/test" },
    }).read();
    expect(snapshot.loops[0]?.journal).toBeNull();
  });

  it("reports a journal dir with no entries yet as empty, distinct from unknown", async () => {
    const { f } = withLoop("journal-empty");
    const harness = createJournalRepo(f.root, "journal/test", ENTRIES);

    const snapshot = await adapterFor(f, {
      journalHome: harness,
      env: { RALPH_JOURNAL_DIR: "journal/other" },
    }).read();
    expect(snapshot.loops[0]?.journal).toEqual([]);
  });

  it("narrows an entry without inventing what it does not say", () => {
    expect(narrowJournalEntry("notes.md", "free text\n")).toEqual({
      name: "notes.md",
      at: null,
      issue: null,
      loop: null,
      title: null,
      outcome: null,
    });
  });
});
