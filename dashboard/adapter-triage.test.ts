// @vitest-environment node
/**
 * A triager's apply ledgers, read through the adapter (#147).
 *
 * The ledgers are JSONL the apply engine appends to AFTER each GitHub write,
 * so the properties here are about tolerance and honesty: a torn last line is
 * normal and must be skipped, a `skipped` entry is not a write, a worktree
 * with no ledger has written nothing (0, not unknown), and a directory that
 * cannot be read is unknown (null, not 0).
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createRalphAdapter } from "./adapter";
import { TRIAGE_MAX_WRITES_DEFAULT } from "./contracts";
import { triageLimits } from "../triage/validate";
import { cleanupFixtures, createFixture, writeLoopState, writeProjectConfig, type Fixture } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("drives the ralph adapter, which spawns bun CLIs");

const REPO_ROOT = join(__dirname, "..");

afterAll(cleanupFixtures);

const adapterFor = (f: Fixture, over: Record<string, string> = {}) =>
  createRalphAdapter({
    cliDir: REPO_ROOT,
    roots: [f.root],
    journalHome: join(f.root, "no-harness"),
    env: {
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      HOME: join(f.root, "home"),
      RALPH_JOURNAL_DIR: "",
      RALPH_TRIAGE_MAX_WRITES: "",
      ...over,
    },
  });

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const entry = (over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ opId: "op-1", op: "add-labels", at: ago(5), result: "applied", ...over })}\n`;

/** A scratch project with one triager worktree, and its log directory. */
const triagerFixture = (label: string): { f: Fixture; worktree: string; logs: string } => {
  const f = createFixture(label);
  writeProjectConfig(f.root, ["ralph", { name: "tria", role: "triager" }]);
  const worktree = f.worktree("tria");
  writeLoopState(worktree, { loop: "tria", run: "run-tria-01" });
  f.registry([worktree]);
  const logs = join(worktree, ".ralph", "logs");
  mkdirSync(logs, { recursive: true });
  return { f, worktree, logs };
};

const writesOf = async (f: Fixture, over: Record<string, string> = {}): Promise<number | null | undefined> => {
  const snapshot = await adapterFor(f, over).read();
  return snapshot.loops.find((loop) => loop.identity === "tria")?.triage?.writesLastHour;
};

describe("triage writes in the trailing hour", () => {
  it("counts applied writes inside the hour, and nothing else", async () => {
    const { f, logs } = triagerFixture("triage-window");
    writeFileSync(
      join(logs, "triage-apply-1131.jsonl"),
      [
        entry({ at: ago(5) }),
        entry({ at: ago(59) }),
        // Outside the window: the same write, an hour and a half ago.
        entry({ at: ago(90) }),
        // A rerun finding the write already done is not a write.
        entry({ at: ago(10), result: "skipped" }),
        // Unparseable, and a line with no timestamp at all.
        "{ not json\n",
        `${JSON.stringify({ opId: "op-9", op: "add-labels", result: "applied" })}\n`,
      ].join(""),
    );
    // A torn last line, which is what a killed apply leaves.
    writeFileSync(join(logs, "triage-apply-1132.jsonl"), `${entry({ at: ago(2) })}{"opId":"op-x","res`);

    expect(await writesOf(f)).toBe(3);
  });

  it("reads every unit's ledger, and only the ledgers", async () => {
    const { f, logs } = triagerFixture("triage-many");
    writeFileSync(join(logs, "triage-apply-1.jsonl"), entry());
    writeFileSync(join(logs, "triage-apply-22.jsonl"), entry() + entry({ opId: "op-2" }));
    // Neighbours in the same directory that are not apply ledgers.
    writeFileSync(join(logs, "triage-plan-1.json"), JSON.stringify({ unit: 1, ops: [] }));
    writeFileSync(join(logs, "triage-apply-notanumber.jsonl"), entry({ opId: "op-ignored" }));
    writeFileSync(join(logs, "usage-ledger.tsv"), "run_id\tsession\n");

    expect(await writesOf(f)).toBe(3);
  });

  it("does not read a ledger that cannot hold an in-window line", async () => {
    // The scan is bounded by the window, not by the directory: a triager keeps
    // one ledger per unit for ever, and these directories run to thousands of
    // files. An append-only ledger untouched for an hour provably holds no line
    // from the last hour, so it is skipped — and an OLD ledger whose entries
    // claim to be recent is therefore not counted.
    const { f, logs } = triagerFixture("triage-window-skip");
    const recent = join(logs, "triage-apply-1.jsonl");
    writeFileSync(recent, entry({ at: ago(5) }));
    const stale = join(logs, "triage-apply-2.jsonl");
    writeFileSync(stale, entry({ opId: "op-2", at: ago(5) }));
    const old = Date.now() - 5 * 60 * 60 * 1000;
    utimesSync(stale, old / 1000, old / 1000);

    expect(await writesOf(f)).toBe(1);
  });

  it("is zero for a triager that has never applied anything", async () => {
    // No ledger is a triager with nothing written, which the panel must not
    // draw as "unknown": the operator would go looking for a broken read.
    const { f } = triagerFixture("triage-none");
    expect(await writesOf(f)).toBe(0);
  });

  it("is unknown when a ledger cannot be read", async () => {
    // Unknown, not a partial count: a number that silently dropped one unit's
    // writes is worse than no number, because nothing says it is short.
    //
    // A DIRECTORY where a ledger should be, rather than `chmod 000`: the read
    // fails with EISDIR for any user, where a permission bit stops testing
    // anything the moment the suite runs as root.
    const { f, logs } = triagerFixture("triage-unreadable");
    writeFileSync(join(logs, "triage-apply-1.jsonl"), entry());
    mkdirSync(join(logs, "triage-apply-2.jsonl"));

    expect(await writesOf(f)).toBeNull();
  });
});

describe("the write cap the panel shows", () => {
  it("mirrors the validator's default, so a configured cap is read the same way", () => {
    // `contracts.ts` imports no ralph module, so its copy of the default is a
    // mirror. Changing `RALPH_TRIAGE_MAX_WRITES`'s default in the validator and
    // not here would have the dashboard quoting a number the validator would
    // not apply.
    expect(TRIAGE_MAX_WRITES_DEFAULT).toBe(triageLimits({}).maxWrites);
  });

  it("reports the validator's default when nothing set the variable", async () => {
    // Nothing in the harness sets `RALPH_TRIAGE_MAX_WRITES` — the README
    // documents the default instead — so unset is the universal case, and the
    // cap a plan is really held to is that default. Reporting null here would
    // blank the number on every deployment rather than tell the truth about it.
    const { f } = triagerFixture("triage-cap-unset");
    const capOf = async (over: Record<string, string>): Promise<number | null | undefined> =>
      (await adapterFor(f, over).read()).loops.find((loop) => loop.identity === "tria")?.triage?.maxWrites;
    expect(await capOf({ RALPH_TRIAGE_MAX_WRITES: "" })).toBe(triageLimits({}).maxWrites);
  });

  it("reads the configured cap, and falls back exactly as the validator does", async () => {
    const { f } = triagerFixture("triage-cap");
    const capOf = async (over: Record<string, string>): Promise<number | null | undefined> =>
      (await adapterFor(f, over).read()).loops.find((loop) => loop.identity === "tria")?.triage?.maxWrites;

    expect(await capOf({ RALPH_TRIAGE_MAX_WRITES: "12" })).toBe(12);
    // Not a positive integer: the validator takes the fallback, so this does too.
    expect(await capOf({ RALPH_TRIAGE_MAX_WRITES: "0" })).toBe(triageLimits({ RALPH_TRIAGE_MAX_WRITES: "0" }).maxWrites);
    expect(await capOf({ RALPH_TRIAGE_MAX_WRITES: "lots" })).toBe(
      triageLimits({ RALPH_TRIAGE_MAX_WRITES: "lots" }).maxWrites,
    );
  });
});
