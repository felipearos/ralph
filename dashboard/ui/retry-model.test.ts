// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { LoopRetryView } from "../contracts";
import { retryLine } from "./retry-model";

const retry = (over: Partial<LoopRetryView> = {}): LoopRetryView => ({
  attempt: 2,
  of: 7,
  cause: "no-sigil",
  nextAt: "2026-10-22T03:15:00.000Z",
  spent: false,
  ...over,
});

describe("retryLine", () => {
  it("names the attempt, the cause and the next time, left as ISO for the component", () => {
    expect(retryLine(retry())).toEqual({
      attempt: "2 of 7",
      cause: "no-sigil",
      next: { kind: "at", at: "2026-10-22T03:15:00.000Z" },
    });
  });

  it("says the retries are spent when the schedule gave up", () => {
    expect(retryLine(retry({ attempt: 7, nextAt: null, spent: true }))).toEqual({
      attempt: "7 of 7",
      cause: "no-sigil",
      next: { kind: "spent" },
    });
  });

  it("branches on spent, not on a next time still on the record", () => {
    expect(retryLine(retry({ spent: true }))?.next).toEqual({ kind: "spent" });
  });

  it("returns a past next time as is", () => {
    expect(retryLine(retry({ nextAt: "2000-01-01T00:00:00.000Z" }))?.next).toEqual({ kind: "at", at: "2000-01-01T00:00:00.000Z" });
  });

  it("has nothing to show for a loop carrying no retry", () => {
    expect(retryLine(undefined)).toBeNull();
  });
});
