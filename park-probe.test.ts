import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { type Condition, listStore, type Park, park as recordPark, type ParkInput, readStore, withStore } from "./park-store";
import { escalationArgv, evaluatePark, type IssueLive, type ParkReader, type ParkWriter, sweep, type SweepDeps } from "./park-probe";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("bun for the park-probe CLI");

const park = (condition: Condition, overrides: Partial<Park> = {}): Park => ({
  ticket: 42,
  loop: "rita",
  label: "rita-blocked",
  pr: 7,
  condition,
  summary: "waits",
  since: "2026-11-11T00:00:00.000Z",
  lastChecked: null,
  budgetUntil: "2026-11-13T00:00:00.000Z",
  escalatedAt: null,
  ...overrides,
});

/** A reader whose every read answers "nothing"; tests override what they need. */
const reader = (overrides: Partial<ParkReader> = {}): ParkReader => ({
  prChecks: async () => null,
  baseChecks: async () => null,
  prState: async () => null,
  issueState: async () => null,
  stepPassed: async () => null,
  issueLive: async () => null,
  prDraft: async () => null,
  ...overrides,
});

const boom = async (): Promise<never> => {
  throw new Error("gh api 403");
};

const REPO = "felipearos/ralph";

describe("evaluatePark: reference", () => {
  const ref = park({ kind: "reference", ref: "#10" });

  it("wakes on a merged or closed PR", async () => {
    expect(await evaluatePark(ref, reader({ prState: async () => "merged" }), REPO)).toBe("woke");
    expect(await evaluatePark(ref, reader({ prState: async () => "closed" }), REPO)).toBe("woke");
  });

  it("waits on an open PR without asking the issue endpoint", async () => {
    const asked: number[] = [];
    const r = reader({ prState: async () => "open", issueState: async (_, n) => (asked.push(n), "closed") });
    expect(await evaluatePark(ref, r, REPO)).toBe("waiting");
    expect(asked).toEqual([]);
  });

  it("reads an issue number through the issue endpoint", async () => {
    const seen: string[] = [];
    const r = reader({ issueState: async (repo, n) => (seen.push(`${repo}#${n}`), "closed") });
    expect(await evaluatePark(ref, r, REPO)).toBe("woke");
    expect(seen).toEqual(["felipearos/ralph#10"]);
    expect(await evaluatePark(ref, reader({ issueState: async () => "open" }), REPO)).toBe("waiting");
  });

  it("resolves a full ref against its own repo", async () => {
    const seen: string[] = [];
    const r = reader({ prState: async (repo, n) => (seen.push(`${repo}#${n}`), "merged") });
    expect(await evaluatePark(park({ kind: "reference", ref: "other/thing#3" }), r, null)).toBe("woke");
    expect(seen).toEqual(["other/thing#3"]);
  });

  it("waits when a read throws", async () => {
    expect(await evaluatePark(ref, reader({ prState: boom }), REPO)).toBe("waiting");
    expect(await evaluatePark(ref, reader({ issueState: boom }), REPO)).toBe("waiting");
  });

  it("is an error when a bare #n has no repo to resolve against", async () => {
    expect(await evaluatePark(ref, reader({ prState: async () => "merged" }), null)).toBe("error");
  });
});

describe("evaluatePark: check on the PR", () => {
  const check = park({ kind: "check", name: "buildkite/loggd", on: "pr" });

  it("wakes on a passing check, matched trimmed and case-insensitively", async () => {
    const r = reader({ prChecks: async () => [{ name: " Buildkite/Loggd ", state: "pass", url: null }] });
    expect(await evaluatePark(check, r, REPO)).toBe("woke");
  });

  it("reads the park's own PR", async () => {
    const asked: number[] = [];
    await evaluatePark(check, reader({ prChecks: async (pr) => (asked.push(pr), []) }), REPO);
    expect(asked).toEqual([7]);
  });

  it("waits on a failing, pending or other check", async () => {
    for (const checks of [
      [{ name: "buildkite/loggd", state: "fail" as const, url: null }],
      [{ name: "buildkite/loggd", state: "pending" as const, url: null }],
      [{ name: "vercel", state: "pass" as const, url: null }],
    ]) {
      expect(await evaluatePark(check, reader({ prChecks: async () => checks }), REPO)).toBe("waiting");
    }
  });

  it("waits when the read throws", async () => {
    expect(await evaluatePark(check, reader({ prChecks: boom }), REPO)).toBe("waiting");
  });

  it("is an error without a PR", async () => {
    expect(await evaluatePark({ ...check, pr: null }, reader(), REPO)).toBe("error");
  });
});

describe("evaluatePark: check on main", () => {
  const check = park({ kind: "check", name: "buildkite/loggd", on: "main" }, { pr: null });

  it("wakes when the base head passes the check", async () => {
    const r = reader({ baseChecks: async () => ({ sha: "abc", checks: [{ name: "buildkite/loggd", state: "pass", url: null }] }) });
    expect(await evaluatePark(check, r, REPO)).toBe("woke");
  });

  it("waits when the base head fails it", async () => {
    const r = reader({ baseChecks: async () => ({ sha: "abc", checks: [{ name: "buildkite/loggd", state: "fail", url: null }] }) });
    expect(await evaluatePark(check, r, REPO)).toBe("waiting");
  });

  it("waits when the read throws or has no answer", async () => {
    expect(await evaluatePark(check, reader({ baseChecks: boom }), REPO)).toBe("waiting");
    expect(await evaluatePark(check, reader(), REPO)).toBe("waiting");
  });
});

describe("evaluatePark: step", () => {
  const step = park({ kind: "step", check: "buildkite/loggd", step: "e2e" });

  it("wakes only on a step that passed", async () => {
    const asked: string[] = [];
    const r = reader({ stepPassed: async (check, key) => (asked.push(`${check}:${key}`), true) });
    expect(await evaluatePark(step, r, REPO)).toBe("woke");
    expect(asked).toEqual(["buildkite/loggd:e2e"]);
    expect(await evaluatePark(step, reader({ stepPassed: async () => false }), REPO)).toBe("waiting");
    expect(await evaluatePark(step, reader(), REPO)).toBe("waiting");
  });

  it("waits when the read throws", async () => {
    expect(await evaluatePark(step, reader({ stepPassed: boom }), REPO)).toBe("waiting");
  });
});

describe("evaluatePark: label-removed", () => {
  const live = (labels: string[]) => async () => ({ state: "open" as const, labels, assignees: [] });

  it("wakes once the park's own label is gone", async () => {
    const own = park({ kind: "label-removed", label: "rita-blocked" });
    expect(await evaluatePark(own, reader({ issueLive: live(["ready-for-agent"]) }), REPO)).toBe("woke");
    expect(await evaluatePark(own, reader({ issueLive: live(["rita-blocked"]) }), REPO)).toBe("waiting");
  });

  it("watches another loop's -blocked label, not the park's own", async () => {
    const other = park({ kind: "label-removed", label: "rafa-blocked" });
    expect(await evaluatePark(other, reader({ issueLive: live(["rita-blocked"]) }), REPO)).toBe("woke");
    expect(await evaluatePark(other, reader({ issueLive: live(["rita-blocked", "rafa-blocked"]) }), REPO)).toBe(
      "waiting",
    );
  });

  it("waits when the read throws or has no answer", async () => {
    const own = park({ kind: "label-removed", label: "rita-blocked" });
    expect(await evaluatePark(own, reader({ issueLive: boom }), REPO)).toBe("waiting");
    expect(await evaluatePark(own, reader(), REPO)).toBe("waiting");
  });
});

/* --------------------------------------------------------------------------
 * The sweep, over a real store file in a temp dir, a fake reader and a fake
 * writer that records every call.
 * ----------------------------------------------------------------------- */

const roots: string[] = [];
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const storeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "park-probe-"));
  roots.push(dir);
  return join(dir, "ralph-parks.json");
};

const T0 = "2026-11-11T00:00:00.000Z";
const NOW = "2026-11-11T01:00:00.000Z";
const LATE = "2026-11-14T00:00:00.000Z";

const parkInput = (ticket: number, condition: Condition, over: Partial<ParkInput> = {}): ParkInput => ({
  ticket, loop: "rita", label: "rita-blocked", pr: null, condition, summary: `#${ticket} waits`, ...over,
});

const seed = async (path: string, inputs: ParkInput[], at = T0): Promise<void> => {
  await withStore(path, (store) => { for (const input of inputs) recordPark(store, input, at); });
};

const open = (over: Partial<IssueLive> = {}): IssueLive => ({ state: "open", labels: ["rita-blocked"], assignees: [], ...over });

interface Harness {
  calls: string[];
  writer: ParkWriter;
  logs: string[];
  deps: (over?: Partial<SweepDeps>) => SweepDeps;
}

/** A writer that records each call, in order, in `calls` (reads are recorded there too). */
const harness = (path: string, r: Partial<ParkReader>, w: Partial<ParkWriter> = {}): Harness => {
  const calls: string[] = [];
  const logs: string[] = [];
  const writer: ParkWriter = {
    prReady: async (pr) => { calls.push(`prReady ${pr}`); await w.prReady?.(pr); },
    removeLabel: async (ticket, label) => { calls.push(`removeLabel ${ticket} ${label}`); await w.removeLabel?.(ticket, label); },
    notify: async (argv) => { calls.push(`notify ${argv.join(" ")}`); await w.notify?.(argv); },
  };
  const traced = reader(r);
  for (const key of Object.keys(traced) as (keyof ParkReader)[]) {
    const read = traced[key] as (...args: unknown[]) => Promise<unknown>;
    (traced as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => { calls.push(`read ${key}`); return read(...args); };
  }
  return {
    calls, writer, logs,
    deps: (over = {}) => ({
      storePath: path, reader: traced, writer, now: () => NOW, repo: REPO,
      readCap: 60, minIntervalSeconds: 120, log: (line) => logs.push(line), ...over,
    }),
  };
};

const writes = (calls: string[]): string[] => calls.filter((call) => !call.startsWith("read "));

describe("sweep: verdicts", () => {
  it("wakes a held condition: prReady, then removeLabel, then unpark", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" }, { pr: 7 })]);
    const h = harness(path, { issueLive: async () => open(), prState: async () => "merged", prDraft: async () => ({ state: "open", isDraft: true }) }, {
      removeLabel: () => { expect(listStore(path)).toHaveLength(1); },
    });
    const tally = await sweep(h.deps());
    expect(writes(h.calls)).toEqual(["prReady 7", "removeLabel 42 rita-blocked"]);
    expect(h.calls.indexOf("read prDraft")).toBeLessThan(h.calls.indexOf("prReady 7"));
    expect(listStore(path)).toEqual([]);
    expect(tally).toMatchObject({ woke: 1, waiting: 0, dropped: 0 });
  });

  it("does not ready a PR that is not a draft", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" }, { pr: 7 })]);
    const h = harness(path, { issueLive: async () => open(), prState: async () => "closed", prDraft: async () => ({ state: "open", isDraft: false }) });
    await sweep(h.deps());
    expect(writes(h.calls)).toEqual(["removeLabel 42 rita-blocked"]);
    expect(listStore(path)).toEqual([]);
  });

  it("waiting marks lastChecked and writes nothing else", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "step", check: "buildkite/loggd", step: "e2e" })]);
    const h = harness(path, { issueLive: async () => open(), stepPassed: async () => false });
    const tally = await sweep(h.deps());
    expect(writes(h.calls)).toEqual([]);
    expect(listStore(path)[0]!.lastChecked).toBe(NOW);
    expect(tally).toMatchObject({ waiting: 1, woke: 0, reads: 4 });
  });

  it("a throwing reader is waiting, never a wake or a drop", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "check", name: "ci", on: "main" })]);
    const h = harness(path, { issueLive: boom, baseChecks: boom });
    const tally = await sweep(h.deps());
    expect(writes(h.calls)).toEqual([]);
    expect(listStore(path)[0]!.lastChecked).toBe(NOW);
    expect(tally).toMatchObject({ waiting: 1, dropped: 0 });
  });

  it("an error verdict is logged and marked checked", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: async () => open() });
    const tally = await sweep(h.deps({ repo: null }));
    expect(tally.errors).toBe(1);
    expect(h.logs.join("\n")).toMatch(/#42: the reference condition cannot be evaluated/);
    expect(listStore(path)[0]!.lastChecked).toBe(NOW);
  });

  it("a write that throws leaves the park for a later sweep", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: async () => open(), prState: async () => "merged" }, { removeLabel: () => { throw new Error("gh 502"); } });
    const tally = await sweep(h.deps());
    expect(tally).toMatchObject({ failed: 1, woke: 0 });
    expect(listStore(path)).toHaveLength(1);
  });
});

describe("sweep: drops", () => {
  const drops = async (live: IssueLive, condition: Condition = { kind: "reference", ref: "#10" }): Promise<{ h: Harness; path: string }> => {
    const path = storeFile();
    await seed(path, [parkInput(42, condition, { pr: 7 })]);
    const h = harness(path, { issueLive: async () => live, prState: async () => "merged", prDraft: async () => ({ state: "open", isDraft: true }) });
    const tally = await sweep(h.deps());
    expect(tally.dropped).toBe(1);
    expect(listStore(path)).toEqual([]);
    expect(writes(h.calls)).toEqual([]);
    return { h, path };
  };

  it("drops a closed ticket", async () => { await drops(open({ state: "closed" })); });
  it("drops a ticket assigned before it blocked — the known false positive, in the safe direction", async () => {
    await drops(open({ assignees: ["felipearosr"] }));
  });
  it("drops a ticket another loop claimed with a -wip label", async () => { await drops(open({ labels: ["rita-blocked", "rafa-wip"] })); });
  it("drops a park whose label is gone", async () => { await drops(open({ labels: [] })); });
  it("drops a label-removed park on another loop's label when its own is gone", async () => {
    await drops(open({ labels: ["rafa-blocked"] }), { kind: "label-removed", label: "rafa-blocked" });
  });

  it("a label-removed condition on the park's own label gone is a wake, not a drop", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "label-removed", label: "rita-blocked" })]);
    const h = harness(path, { issueLive: async () => open({ labels: [] }) });
    const tally = await sweep(h.deps());
    expect(tally).toMatchObject({ woke: 1, dropped: 0 });
    expect(writes(h.calls)).toEqual(["removeLabel 42 rita-blocked"]);
    // The ticket's labels are read once, not again by evaluatePark.
    expect(h.calls.filter((call) => call === "read issueLive")).toHaveLength(1);
  });
});

describe("sweep: read cap and interval", () => {
  it("stops before a read that would pass the cap, and names the knob", async () => {
    const path = storeFile();
    await seed(path, [1, 2, 3].map((n) => parkInput(n, { kind: "reference", ref: "#10" })));
    const h = harness(path, { issueLive: async () => open(), prState: async () => "open", issueState: async () => "open" });
    // Each reserves issueLive + prState + issueState = 3 and reads 2 (an open
    // PR is not re-read as an issue): two parks read 4, the third would need 3.
    const tally = await sweep(h.deps({ readCap: 6 }));
    expect(tally).toMatchObject({ capped: true, reads: 4, waiting: 2 });
    expect(listStore(path).map((p) => p.lastChecked)).toEqual([NOW, NOW, null]);
    expect(h.logs.join("\n")).toMatch(/RALPH_PARK_SWEEP_READS/);
  });

  it("a store of step parks hits the cap: Buildkite reads count", async () => {
    const path = storeFile();
    await seed(path, Array.from({ length: 20 }, (_, i) => parkInput(i + 1, { kind: "step", check: "buildkite/loggd", step: "e2e" })));
    const h = harness(path, { issueLive: async () => open(), stepPassed: async () => false });
    const tally = await sweep(h.deps());
    expect(tally.capped).toBe(true);
    expect(tally.reads).toBeLessThanOrEqual(60);
    expect(h.calls.filter((call) => call === "read stepPassed")).toHaveLength(15);
  });

  it("skips a park checked within the interval without a read, and checks a never-checked one", async () => {
    const path = storeFile();
    await seed(path, [parkInput(1, { kind: "reference", ref: "#10" }), parkInput(2, { kind: "reference", ref: "#10" })]);
    await withStore(path, (store) => { store.parks["1"]!.lastChecked = "2026-11-11T00:59:00.000Z"; });
    const h = harness(path, { issueLive: async () => open(), prState: async () => "open", issueState: async () => "open" });
    const tally = await sweep(h.deps());
    expect(tally).toMatchObject({ skipped: 1, waiting: 1 });
    expect(h.calls.filter((call) => call === "read issueLive")).toHaveLength(1);
    expect(listStore(path).map((p) => p.lastChecked)).toEqual(["2026-11-11T00:59:00.000Z", NOW]);
  });

  it("walks the least recently checked first, so a cap does not starve the same parks", async () => {
    const path = storeFile();
    await seed(path, [parkInput(1, { kind: "reference", ref: "#10" }), parkInput(2, { kind: "reference", ref: "#10" })]);
    await withStore(path, (store) => { store.parks["1"]!.lastChecked = "2026-11-10T00:00:00.000Z"; });
    const seen: number[] = [];
    const h = harness(path, { issueLive: async (n) => (seen.push(n), open()), prState: async () => "open" });
    await sweep(h.deps({ readCap: 3 }));
    expect(seen).toEqual([2]);
  });
});

describe("sweep: stamp before the reads, and only this project's parks", () => {
  it("stamps lastChecked before its first read, so a sweep killed mid-read does not hold the park first in line", async () => {
    const path = storeFile();
    await seed(path, [parkInput(1, { kind: "reference", ref: "#10" })]);
    let stampedAtRead: string | null = "unread";
    const h = harness(path, {
      issueLive: async () => { stampedAtRead = readStore(path).parks["1"]!.lastChecked; return open(); },
      prState: async () => "open", issueState: async () => "open",
    });
    await sweep(h.deps());
    expect(stampedAtRead).toBe(NOW);
  });

  it("skips a park another sweep checked after this one listed the store", async () => {
    const path = storeFile();
    await seed(path, [parkInput(1, { kind: "reference", ref: "#10" }), parkInput(2, { kind: "reference", ref: "#10" })]);
    // Park 1's read stands in for a concurrent sweep that checks park 2 meanwhile.
    const h = harness(path, {
      issueLive: async (n) => {
        if (n === 1) await withStore(path, (store) => { store.parks["2"]!.lastChecked = NOW; });
        return open();
      },
      prState: async () => "open", issueState: async () => "open",
    });
    const tally = await sweep(h.deps());
    expect(h.calls.filter((call) => call === "read issueLive")).toHaveLength(1);
    expect(tally).toMatchObject({ skipped: 1, waiting: 1 });
  });

  it("leaves a park recorded by another project's loop alone, without a read", async () => {
    const path = storeFile();
    await seed(path, [parkInput(1, { kind: "reference", ref: "#10" }), { ...parkInput(2, { kind: "reference", ref: "#10" }), loop: "bruno", label: "bruno-blocked" }]);
    const h = harness(path, { issueLive: async () => ({ ...open(), state: "closed" }) });
    const tally = await sweep(h.deps({ ownsLoop: (loop) => loop === "rita" }));
    expect(tally).toMatchObject({ foreign: 1, dropped: 1 });
    expect(h.calls.filter((call) => call === "read issueLive")).toHaveLength(1);
    expect(listStore(path).map((p) => p.ticket)).toEqual([2]);
  });
});

describe("sweep: since re-check", () => {
  const replacing = (path: string) => async (): Promise<IssueLive> => {
    await withStore(path, (store) => { recordPark(store, parkInput(42, { kind: "check", name: "ci", on: "main" }), NOW); });
    return open();
  };

  it("does not unpark a park replaced while its condition was read", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: replacing(path), prState: async () => "merged" });
    const tally = await sweep(h.deps());
    expect(tally).toMatchObject({ woke: 0, raced: 1 });
    expect(writes(h.calls)).toEqual([]);
    expect(listStore(path)[0]).toMatchObject({ since: NOW, condition: { kind: "check" }, lastChecked: null });
  });

  it("does not drop a park replaced while the ticket was read", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: async () => { await replacing(path)(); return open({ state: "closed" }); } });
    await sweep(h.deps());
    expect(listStore(path)).toHaveLength(1);
  });

  it("does not escalate a park replaced while it was read", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: replacing(path) });
    const tally = await sweep(h.deps({ now: () => LATE }));
    expect(tally).toMatchObject({ escalated: 0, raced: 1 });
    expect(writes(h.calls)).toEqual([]);
    expect(listStore(path, LATE)[0]!.escalatedAt).toBeNull();
  });
});

describe("sweep: escalation", () => {
  it("escalates an expired park once across two sweeps, stamped before the push, never woken", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" }, { pr: 7 })]);
    let stampedFirst = false;
    const h = harness(path, { issueLive: async () => open(), prState: async () => "merged" }, {
      notify: () => { stampedFirst = readStore(path).parks["42"]!.escalatedAt === LATE; },
    });
    const first = await sweep(h.deps({ now: () => LATE }));
    const second = await sweep(h.deps({ now: () => "2026-11-14T01:00:00.000Z" }));
    expect(first.escalated).toBe(1);
    expect(second).toMatchObject({ escalated: 0, waiting: 1 });
    expect(stampedFirst).toBe(true);
    expect(writes(h.calls)).toEqual([`notify ${escalationArgv(listStore(path)[0]!).join(" ")}`]);
    expect(h.calls).not.toContain("read prState");
    expect(listStore(path)).toHaveLength(1);
  });

  it("pushes exactly the ticket-blocked page", () => {
    const record = { ...park({ kind: "reference", ref: "#10" }), summary: "waits on #10" };
    expect(escalationArgv(record)).toEqual([
      "push", "--kind", "ticket-blocked", "--priority", "high", "--ticket", "42",
      "--occurrence", `park-expired:42:${record.since}`,
      "--subject", "Ticket #42 parked 48h",
      "--body", 'waits on #10\n\nwaiting on: {"kind":"reference","ref":"#10"}',
    ]);
  });

  it("a push that throws is logged and never retried", async () => {
    const path = storeFile();
    await seed(path, [parkInput(42, { kind: "reference", ref: "#10" })]);
    const h = harness(path, { issueLive: async () => open() }, { notify: () => { throw new Error("push down"); } });
    await sweep(h.deps({ now: () => LATE }));
    await sweep(h.deps({ now: () => "2026-11-14T01:00:00.000Z" }));
    expect(writes(h.calls).filter((call) => call.startsWith("notify"))).toHaveLength(1);
    expect(h.logs.join("\n")).toMatch(/push down/);
    expect(listStore(path, LATE)[0]!.escalatedAt).toBe(LATE);
  });
});

describe("sweep: CLI", () => {
  const SCRIPT = fileURLToPath(new URL("./park-probe.ts", import.meta.url));
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync("bun", [SCRIPT, ...args], {
      cwd: tmpdir(), encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });

  it("an empty store is a quiet 0", () => {
    const out = cli(["sweep"], { RALPH_PARK_STORE: storeFile() });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe("");
  });

  it("refuses an unknown command with 64", () => {
    expect(cli(["wake"], { RALPH_PARK_STORE: storeFile() }).status).toBe(64);
  });
});
