import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordBlockPark } from "./block-park";
import { latestBlockReason } from "./block-reason";
import { listStore } from "./park-store";

const NOW = "2026-11-11T10:00:00.000Z";

describe("recordBlockPark", () => {
  let dir: string;
  let file: string;
  let storePath: string;
  let logged: string[];
  let pushed: string[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "block-park-"));
    file = join(dir, "block-park.json");
    storePath = join(dir, "ralph-parks.json");
    logged = [];
    pushed = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (push: (argv: string[]) => void = (argv) => pushed.push(argv)) => ({
    file,
    storePath,
    now: () => NOW,
    log: (line: string) => logged.push(line),
    push,
    env: {},
  });
  const handOff = (value: unknown): void => writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));

  it("records a valid hand-off as a park and deletes the file", async () => {
    handOff({ ticket: 776, condition: { kind: "reference", ref: "#775" }, summary: "waiting for #775 to merge", pr: 812 });
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    const parks = listStore(storePath, NOW);
    expect(parks).toHaveLength(1);
    expect(parks[0]).toMatchObject({
      ticket: 776,
      loop: "ralph",
      label: "ralph-blocked",
      pr: 812,
      condition: { kind: "reference", ref: "#775" },
      summary: "waiting for #775 to merge",
      since: NOW,
    });
    expect(existsSync(file)).toBe(false);
    expect(pushed).toEqual([]);
  });

  it("parks with no PR when pr is absent or null", async () => {
    handOff({ ticket: 5, condition: { kind: "reference", ref: "#4" }, summary: "s", pr: null });
    await recordBlockPark({ ticket: 5, loop: "ralph" }, deps());
    expect(listStore(storePath, NOW)[0]).toMatchObject({ ticket: 5, pr: null });
  });

  it("does nothing when there is no hand-off", async () => {
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(existsSync(storePath)).toBe(false);
    expect(logged).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("drops an earlier park of the ticket when this block names no condition", async () => {
    handOff({ ticket: 776, condition: { kind: "reference", ref: "#775" }, summary: "the old wait" });
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(listStore(storePath, NOW)).toHaveLength(1);
    // Unblocked, re-claimed, and blocked again on something only a person can judge.
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(listStore(storePath, NOW)).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("leaves another ticket's park alone when this block names no condition", async () => {
    handOff({ ticket: 775, condition: { kind: "reference", ref: "#774" }, summary: "the other wait" });
    await recordBlockPark({ ticket: 775, loop: "ralph" }, deps());
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(listStore(storePath, NOW).map((record) => record.ticket)).toEqual([775]);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["another ticket's hand-off", { ticket: 775, condition: { kind: "reference", ref: "#1" }, summary: "s" }],
    ["a check on the PR with no PR", { ticket: 776, condition: { kind: "check", name: "x", on: "pr" }, summary: "s" }],
    ["an empty summary", { ticket: 776, condition: { kind: "reference", ref: "#1" }, summary: "  " }],
    ["a bad pr", { ticket: 776, condition: { kind: "reference", ref: "#1" }, summary: "s", pr: "812" }],
    ["a non-object", [1, 2]],
  ])("refuses %s: no park, file deleted, and the page goes out high", async (_what, value) => {
    // A present file means the session pushed normal trusting the park, so a
    // refusal must restore the high page or the alert is lost.
    handOff(value);
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(listStore(storePath, NOW)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.slice(0, 7)).toEqual(["push", "--kind", "ticket-blocked", "--priority", "high", "--ticket", "776"]);
    expect(pushed[0]![pushed[0]!.indexOf("--occurrence") + 1]).toBe(`park-refused:776:${NOW}`);
    expect(logged).toHaveLength(1);
  });

  it("pushes high itself when the park cannot be written", async () => {
    writeFileSync(storePath, JSON.stringify({ version: 2 }));
    handOff({ ticket: 776, condition: { kind: "reference", ref: "#775" }, summary: "waiting for #775" });
    await recordBlockPark({ ticket: 776, loop: "ralph" }, deps());
    expect(existsSync(file)).toBe(false);
    expect(pushed).toHaveLength(1);
    const argv = pushed[0]!;
    expect(argv.slice(0, 7)).toEqual(["push", "--kind", "ticket-blocked", "--priority", "high", "--ticket", "776"]);
    expect(argv[argv.indexOf("--occurrence") + 1]).toBe(`park-failed:776:${NOW}`);
    // Its mirrored comment is headed by the subject; a "Ticket #n blocked"
    // heading would become the newest block record and hide the session's own.
    const heading = `### ${argv[argv.indexOf("--subject") + 1]}`;
    expect(latestBlockReason([{ body: "needs-migration: draft PR #9 ready; apply m.sql" }, { body: `${heading}\n\nx` }]).kind).toBe("migration");
    expect(argv[argv.indexOf("--body") + 1]).toMatch(/^waiting for #775\n\nthe park could not be recorded: .*newer ralph/);
  });

  it("never throws when that push throws too", async () => {
    writeFileSync(storePath, JSON.stringify({ version: 2 }));
    handOff({ ticket: 776, condition: { kind: "reference", ref: "#775" }, summary: "s" });
    await expect(
      recordBlockPark({ ticket: 776, loop: "ralph" }, deps(() => { throw new Error("no bun"); })),
    ).resolves.toBeUndefined();
    expect(logged.some((line) => line.includes("no bun"))).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
