// @vitest-environment node
/**
 * The clerk's store when `clerk.channel` changes: the new channel inherits
 * none of the old one's reading position, which would skip or mis-file its
 * messages, and keeps every record keyed by ticket, which a channel move does
 * not change.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { emptyStore, readClerkStore, withClerkStore, type ClerkStore } from "./store";

const OLD = "C0TESTCHAN1";
const NEW = "C0MOVEDCHN1";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function oldStore(): ClerkStore {
  return {
    ...emptyStore(OLD),
    cursor: "1760961600.000100",
    processed: { "1760961600.000100": { state: "filed", key: "SHADOW-1760961600000100", at: "2026-10-20T12:00:00.000Z", roots: ["1760961600.000100"], copiedThrough: "1760961600.000100" } },
    batch: { id: "batch-1760961700.000100", handedAt: "2026-10-20T12:05:00.000Z", attempt: 1, reports: [] },
    progress: { "1760961700.000100": {} },
    reopened: { "1760961500.000100": { by: "U0ANA00001", at: "2026-10-20T12:00:00.000Z", roots: ["1760961500.000100"] } },
    failures: 2,
    shadow: { tickets: { "SHADOW-1760961600000100": { report: "1760961600.000100" } as never }, writes: [] },
    canvas: { id: "F0CREATED01", configured: "F0SHADOWCV1", rebuiltAt: "2026-10-20T12:00:00.000Z" },
    determinations: { "OAI-7": { type: "Error", priority: "Medium", app: "Backoffice", assignee: "agent", difficulty: "medium", storyPoints: 3, filedAt: "2026-10-20T12:00:00.000Z" } },
    confirmed: { "OAI-7": { outcome: "to-agent", at: "2026-10-21T12:00:00.000Z", done: true } },
    outcomes: { recorded: { "OAI-6": { at: "2026-10-21T12:00:00.000Z", report: "1760961400.000100" } }, watched: {} },
  };
}

describe("a store written for another channel", () => {
  it("drops the old channel's cursor, processed reports, batch and re-opens, and keeps the tickets' records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-store-"));
    roots.push(dir);
    const path = join(dir, "clara.json");
    const before = oldStore();
    writeFileSync(path, JSON.stringify(before));

    const { store, problem } = readClerkStore(path, NEW);
    expect(problem).toBe(
      `the clerk store ${path} is for ${OLD}, not ${NEW}; starting ${NEW}'s history over (the old channel's cursor and processed reports are dropped, the tickets' records kept)`,
    );
    expect(store).toEqual({
      ...emptyStore(NEW),
      shadow: before.shadow,
      canvas: before.canvas,
      determinations: before.determinations,
      confirmed: before.confirmed,
      outcomes: before.outcomes,
    });

    // Written back under the new channel: the next read is a plain one.
    await withClerkStore(path, NEW, () => {});
    expect(readClerkStore(path, NEW)).toEqual({ store, problem: null });
  });

  it("is still the store as it was for its own channel", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-store-"));
    roots.push(dir);
    const path = join(dir, "clara.json");
    writeFileSync(path, JSON.stringify(oldStore()));
    expect(readClerkStore(path, OLD)).toEqual({ store: oldStore(), problem: null });
  });
});
