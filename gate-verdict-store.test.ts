// @vitest-environment node
/**
 * The gate verdict record (#771): the one verdict a loop's intake gate holds
 * on after an iteration refuted it.
 *
 * Every test writes into its own temp directory, never into this checkout's
 * `.ralph/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

import {
  budgetSpent,
  clearHeld,
  releaseHeld,
  compactDuration,
  gateVerdictPath,
  holdAge,
  holdBudgetHours,
  markNotified,
  readHeld,
  sameSubject,
  verdictSubject,
  writeHeld,
  type HeldVerdict,
} from "./gate-verdict-store";

subprocessSuite("bun for the gate-verdict-store CLI exit codes");

const SCRIPT = fileURLToPath(new URL("./gate-verdict-store.ts", import.meta.url));

const tempStore = (): string => {
  const dir = scratchDir("gate-verdict-");
  return joinPath(dir, "logs", "gate-verdict.json");
};

const cli = (path: string, ...args: string[]) => {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    env: { ...process.env, RALPH_GATE_VERDICT_STORE: path },
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const T0 = new Date("2026-11-10T00:00:00.000Z");
const hoursAfter = (hours: number): Date => new Date(T0.getTime() + hours * 3_600_000);

describe("verdictSubject", () => {
  it("reads a frontier ticket from the whole gate line, caveat and all", () => {
    expect(verdictSubject("frontier-gate: work available — frontier ticket #12 — Some title (open PRs unreadable; the iteration re-checks)"))
      .toEqual({ kind: "frontier-ticket", ticket: 12 });
  });

  it("reads the case text alone", () => {
    expect(verdictSubject("frontier ticket #12 — Some title")).toEqual({ kind: "frontier-ticket", ticket: 12 });
    expect(verdictSubject("spec #7 has no open children left — closing it is the task"))
      .toEqual({ kind: "closable-spec", ticket: 7 });
  });

  it("takes any gate name as the prefix", () => {
    expect(verdictSubject("triage-gate: work available — spec #7 has no open children left — closing it is the task"))
      .toEqual({ kind: "closable-spec", ticket: 7 });
  });

  it("compares by kind and ticket only, so a title edit is the same subject", () => {
    const a = verdictSubject("frontier ticket #12 — Old title");
    const b = verdictSubject("frontier-gate: work available — frontier ticket #12 — New title (open PRs unreadable)");
    expect(sameSubject(a, b)).toBe(true);
    expect(sameSubject(a, verdictSubject("frontier ticket #13 — Old title"))).toBe(false);
    expect(sameSubject(a, { kind: "closable-spec", ticket: 12 })).toBe(false);
    expect(sameSubject(a, null)).toBe(false);
  });

  it("holds on nothing else", () => {
    for (const text of [
      "frontier-gate: work available — PR #5 to shepherd — red checks",
      "frontier-gate: work available — own claim #44 is still open",
      "frontier-gate: work available — local recovery: branch rafa/12 has commits",
      "frontier-gate: nothing to do — every ticket is blocked",
      "",
      "frontier ticket #0 — zero",
      "frontier ticket #12x",
    ]) expect(verdictSubject(text), text).toBeNull();
  });

  it("is not fooled by a title that names a frontier ticket", () => {
    expect(verdictSubject("frontier-gate: work available — PR #5 to shepherd — follow-up to frontier ticket #9")).toBeNull();
    expect(verdictSubject("frontier ticket #12 — supersedes frontier ticket #9")).toEqual({ kind: "frontier-ticket", ticket: 12 });
  });
});

describe("the record", () => {
  it("resolves under .ralph/logs unless the env names another path", () => {
    expect(gateVerdictPath({}, "/w")).toBe("/w/.ralph/logs/gate-verdict.json");
    expect(gateVerdictPath({ RALPH_GATE_VERDICT_STORE: " /x/y.json " }, "/w")).toBe("/x/y.json");
  });

  it("writes, reads and clears", async () => {
    const path = tempStore();
    expect(readHeld(path)).toBeNull();
    expect(await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0)).toBe("written");
    expect(readHeld(path)).toEqual({ kind: "frontier-ticket", ticket: 12, first: T0.toISOString(), notified: false, released: false, reholds: 0 });
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    expect(await clearHeld(path)).toBe("cleared");
    expect(readHeld(path)).toBeNull();
    expect(await clearHeld(path)).toBe("absent");
  });

  it("leaves the same subject untouched and says so", async () => {
    const path = tempStore();
    await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0);
    expect(await markNotified(path)).toBe(true);
    expect(await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, hoursAfter(5))).toBe("same");
    expect(readHeld(path)).toEqual({ kind: "frontier-ticket", ticket: 12, first: T0.toISOString(), notified: true, released: false, reholds: 0 });
  });

  it("restarts the clock and the notice for a different subject", async () => {
    const path = tempStore();
    await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0);
    await markNotified(path);
    expect(await writeHeld(path, { kind: "closable-spec", ticket: 12 }, hoursAfter(5))).toBe("written");
    expect(readHeld(path)).toEqual({ kind: "closable-spec", ticket: 12, first: hoursAfter(5).toISOString(), notified: false, released: false, reholds: 0 });
  });

  it("keeps the record when asked to and the subject is unchanged", async () => {
    const path = tempStore();
    await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0);
    expect(await clearHeld(path, { kind: "frontier-ticket", ticket: 12 })).toBe("kept");
    expect(readHeld(path)).not.toBeNull();
    expect(await clearHeld(path, { kind: "frontier-ticket", ticket: 13 })).toBe("cleared");
    expect(readHeld(path)).toBeNull();
  });

  it("marks notified only on an existing record", async () => {
    const path = tempStore();
    expect(await markNotified(path)).toBe(false);
    expect(existsSync(path)).toBe(false);
    await writeHeld(path, { kind: "frontier-ticket", ticket: 3 }, T0);
    expect(await markNotified(path)).toBe(true);
    expect(readHeld(path)?.notified).toBe(true);
  });

  it("reads a malformed record as none, and the next write repairs it", async () => {
    const good = { version: 1, kind: "frontier-ticket", ticket: 4, first: T0.toISOString(), notified: false };
    for (const content of [
      "garbage{",
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, kind: "shepherd-pr" }),
      JSON.stringify({ ...good, ticket: 0 }),
      JSON.stringify({ ...good, ticket: 1.5 }),
      JSON.stringify({ ...good, first: "not a time" }),
      JSON.stringify({ ...good, notified: "yes" }),
      JSON.stringify({ ...good, released: "yes" }),
      JSON.stringify({ ...good, released: null }),
      JSON.stringify({ ...good, reholds: "1" }),
      JSON.stringify({ ...good, reholds: -1 }),
      JSON.stringify({ ...good, reholds: 1.5 }),
      JSON.stringify([good]),
    ]) {
      const path = tempStore();
      mkdirSync(joinPath(path, ".."), { recursive: true });
      writeFileSync(path, content);
      expect(readHeld(path), content).toBeNull();
      expect(await writeHeld(path, { kind: "frontier-ticket", ticket: 4 }, T0)).toBe("written");
      expect(readHeld(path)).toEqual({ kind: "frontier-ticket", ticket: 4, first: T0.toISOString(), notified: false, released: false, reholds: 0 });
    }
  });

  it("reads a record written before release existed as unreleased, with no re-holds", () => {
    const path = tempStore();
    mkdirSync(joinPath(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, kind: "frontier-ticket", ticket: 4, first: T0.toISOString(), notified: true }));
    expect(readHeld(path)).toEqual({ kind: "frontier-ticket", ticket: 4, first: T0.toISOString(), notified: true, released: false, reholds: 0 });
  });

  it("marks a release on the record and keeps its clock", async () => {
    const path = tempStore();
    expect(await releaseHeld(path)).toBe("absent");
    expect(existsSync(path)).toBe(false);
    await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0);
    await markNotified(path);
    expect(await releaseHeld(path)).toBe("released");
    expect(readHeld(path)).toEqual({ kind: "frontier-ticket", ticket: 12, first: T0.toISOString(), notified: true, released: true, reholds: 0 });
    expect(await releaseHeld(path)).toBe("already");
    // The supervisor's spawn on the same subject keeps a released record too.
    expect(await clearHeld(path, { kind: "frontier-ticket", ticket: 12 })).toBe("kept");
    expect(readHeld(path)?.released).toBe(true);
  });

  it("re-holds a verdict that came back on its original clock, once silently and then as the same", async () => {
    const path = tempStore();
    const subject = { kind: "frontier-ticket", ticket: 12 } as const;
    await writeHeld(path, subject, T0);
    await markNotified(path);
    await releaseHeld(path);
    expect(await writeHeld(path, subject, hoursAfter(5))).toBe("reheld");
    expect(readHeld(path)).toEqual({ ...subject, first: T0.toISOString(), notified: true, released: false, reholds: 1 });
    // Not released now: the same subject again is a hold that did not take.
    expect(await writeHeld(path, subject, hoursAfter(6))).toBe("same");
    expect(readHeld(path)?.reholds).toBe(1);
    await releaseHeld(path);
    expect(await writeHeld(path, subject, hoursAfter(7))).toBe("same");
    expect(readHeld(path)).toEqual({ ...subject, first: T0.toISOString(), notified: true, released: false, reholds: 2 });
  });

  it("replaces a released record with a fresh one for a different subject", async () => {
    const path = tempStore();
    await writeHeld(path, { kind: "frontier-ticket", ticket: 12 }, T0);
    await markNotified(path);
    await releaseHeld(path);
    expect(await writeHeld(path, { kind: "frontier-ticket", ticket: 13 }, hoursAfter(5))).toBe("written");
    expect(readHeld(path)).toEqual({
      kind: "frontier-ticket", ticket: 13, first: hoursAfter(5).toISOString(), notified: false, released: false, reholds: 0,
    });
  });

  it("throws when the record cannot be written", async () => {
    const dir = scratchDir("gate-verdict-");
    writeFileSync(joinPath(dir, "logs"), "a file where the directory should be");
    await expect(writeHeld(joinPath(dir, "logs", "gate-verdict.json"), { kind: "frontier-ticket", ticket: 1 }, T0)).rejects.toThrow();
  });

  it("breaks a stale lock", async () => {
    const path = tempStore();
    mkdirSync(joinPath(path, ".."), { recursive: true });
    writeFileSync(`${path}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    expect(await writeHeld(path, { kind: "frontier-ticket", ticket: 2 }, T0)).toBe("written");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("the budget", () => {
  const held: HeldVerdict = { kind: "frontier-ticket", ticket: 12, first: T0.toISOString(), notified: false, released: false, reholds: 0 };

  it("defaults to 48 hours and refuses anything but a positive integer", () => {
    expect(holdBudgetHours(undefined)).toBe(48);
    expect(holdBudgetHours("")).toBe(48);
    expect(holdBudgetHours("6")).toBe(6);
    for (const raw of ["0", "-1", "1.5", "abc", "06"]) expect(holdBudgetHours(raw), raw).toBeNull();
  });

  it("is spent at the budget, not before", () => {
    expect(budgetSpent(held, new Date(hoursAfter(48).getTime() - 1), 48)).toBe(false);
    expect(budgetSpent(held, hoursAfter(48), 48)).toBe(true);
    expect(budgetSpent(held, hoursAfter(49), 48)).toBe(true);
  });

  it("treats a first in the future as unspent and age zero", () => {
    expect(budgetSpent(held, hoursAfter(-5), 1)).toBe(false);
    expect(holdAge(held, hoursAfter(-5))).toBe(0);
    expect(holdAge(held, hoursAfter(2))).toBe(7_200);
  });

  it("formats a compact duration", () => {
    expect(compactDuration(45 * 60)).toBe("45m");
    expect(compactDuration(51 * 3_600)).toBe("2d3h");
    expect(compactDuration(30)).toBe("30s");
  });
});

describe("the CLI", () => {
  it("speaks in exit codes", () => {
    const path = tempStore();
    const line = "frontier-gate: work available — frontier ticket #12 — Some title";
    expect(cli(path, "read").code).toBe(1);
    expect(cli(path, "describe").code).toBe(1);
    expect(cli(path, "notify").code).toBe(1);
    expect(cli(path, "write", "--case", "frontier-gate: work available — PR #5 to shepherd").code).toBe(2);
    expect(cli(path, "write", "--case", line).code).toBe(0);
    const same = cli(path, "write", "--case", "frontier ticket #12 — Renamed");
    expect(same.code).toBe(3);
    expect(same.stdout).toContain("already held since");
    expect(cli(path, "notified").code).toBe(1);
    expect(cli(path, "notify").code).toBe(0);
    const notified = cli(path, "notified");
    expect(notified.code).toBe(0);
    expect(notified.stdout).toBe("");
    expect(cli(path, "read").stdout.trim()).toMatch(/^frontier-ticket 12 \S+ true$/);
    expect(JSON.parse(cli(path, "read", "--json").stdout)).toMatchObject({ version: 1, kind: "frontier-ticket", ticket: 12 });
    expect(cli(path, "describe").stdout).toMatch(/^frontier ticket #12, held since \S+ \(\d+s\)/);
    expect(cli(path, "clear", "--keep-if-case", line).code).toBe(0);
    expect(readHeld(path)).not.toBeNull();
    expect(cli(path, "clear").code).toBe(0);
    expect(readHeld(path)).toBeNull();
  });

  it("releases, re-holds and stops reading notified once released", () => {
    const path = tempStore();
    const line = "frontier-gate: work available — frontier ticket #12 — Some title";
    expect(cli(path, "release").code).toBe(0);
    expect(cli(path, "write", "--case", line).code).toBe(0);
    expect(cli(path, "notify").code).toBe(0);
    expect(cli(path, "notified").code).toBe(0);
    const first = readHeld(path)?.first;
    const released = cli(path, "release");
    expect(released.code).toBe(0);
    expect(released.stdout).toContain("released");
    expect(readHeld(path)).toMatchObject({ released: true, notified: true, first });
    // A released record holds nothing: the loop must not read as blocked on it.
    expect(cli(path, "notified").code).toBe(1);
    expect(cli(path, "release").code).toBe(0);
    const reheld = cli(path, "write", "--case", line);
    expect(reheld.code).toBe(0);
    expect(reheld.stdout).toContain("came back");
    expect(reheld.stdout).toContain(`held since ${first}`);
    expect(cli(path, "notified").code).toBe(0);
    expect(cli(path, "release").code).toBe(0);
    const again = cli(path, "write", "--case", line);
    expect(again.code).toBe(3);
    expect(readHeld(path)).toMatchObject({ released: false, reholds: 2, first });
  });

  it("refuses bad usage with 64 and a failed write with 1", () => {
    const path = tempStore();
    expect(cli(path, "bogus").code).toBe(64);
    expect(cli(path, "write").code).toBe(64);
    expect(cli(path, "write", "--case").code).toBe(64);
    expect(cli(path, "clear", "--keep-if-case").code).toBe(64);
    expect(cli(path, "release", "--now").code).toBe(64);
    const dir = scratchDir("gate-verdict-");
    writeFileSync(joinPath(dir, "logs"), "a file");
    const failed = cli(joinPath(dir, "logs", "gate-verdict.json"), "write", "--case", "frontier ticket #1 — t");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("gate-verdict-store:");
  });
});
