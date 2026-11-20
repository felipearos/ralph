import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { appendLedger, createdIssues, doneOps, ledgerPath, readLedger } from "./ledger";

const scratchRoots: string[] = [];
const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ralph-${label}-`));
  scratchRoots.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<Parameters<typeof appendLedger>[1]> = {}) => ({
  opId: "a1",
  op: "add-label" as const,
  at: "2026-09-30T00:00:00Z",
  result: "applied" as const,
  ...overrides,
});

describe("ledgerPath", () => {
  it("names one file per unit under the project's log dir", () => {
    expect(ledgerPath(42, "/tmp/project")).toBe("/tmp/project/.ralph/logs/triage-apply-42.jsonl");
  });
});

describe("readLedger", () => {
  it("reads a missing file as nothing applied", () => {
    expect(readLedger(join(scratch("ledger-missing"), "absent.jsonl"))).toEqual([]);
  });

  it("round-trips appended entries and creates the parent directory", () => {
    const path = ledgerPath(7, scratch("ledger-append"));
    appendLedger(path, entry());
    appendLedger(path, entry({ opId: "a2", op: "comment", commentId: "IC_1" }));
    expect(readLedger(path).map((line) => line.opId)).toEqual(["a1", "a2"]);
    expect(readLedger(path)[1]!.commentId).toBe("IC_1");
  });

  it("skips a truncated last line, which is what a kill mid-write leaves", () => {
    const path = ledgerPath(7, scratch("ledger-truncated"));
    appendLedger(path, entry());
    appendLedger(path, entry({ opId: "a2" }));
    const text = readFileSync(path, "utf8");
    writeFileSync(path, `${text.slice(0, text.length - 12)}`);
    expect(readLedger(path).map((line) => line.opId)).toEqual(["a1"]);
  });

  it("skips a line that parses but is not an entry", () => {
    const path = ledgerPath(7, scratch("ledger-shape"));
    appendLedger(path, entry());
    writeFileSync(path, `${readFileSync(path, "utf8")}{"opId":"a2"}\n`);
    expect(readLedger(path)).toHaveLength(1);
  });
});

describe("doneOps", () => {
  it("answers only for ops the ledger says were APPLIED", () => {
    const done = doneOps([entry(), entry({ opId: "a2", result: "skipped" })]);
    expect([...done.keys()]).toEqual(["a1"]);
  });

  it("keeps the newest applied record for an id", () => {
    const done = doneOps([entry({ detail: "first" }), entry({ detail: "second" })]);
    expect(done.get("a1")!.detail).toBe("second");
  });
});

describe("createdIssues", () => {
  it("maps a create-issue op id to the issue it produced", () => {
    const created = createdIssues([
      entry({ opId: "n1", op: "create-issue", issue: 501 }),
      entry({ opId: "n2", op: "create-issue" }),
      entry({ opId: "n3", op: "create-issue", issue: 502, result: "skipped" }),
    ]);
    expect([...created]).toEqual([["n1", 501]]);
  });
});
