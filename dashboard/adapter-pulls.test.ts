// @vitest-environment node
/**
 * Each ticket's PR standing, narrowed from `gh pr list` (open with its check
 * rollup, then merged). Pure: no `gh` runs here.
 */
import { describe, expect, it } from "vitest";

import { COMMAND_SURFACE, RalphContractError, narrowPullStatuses, pullState } from "./adapter";

const run = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });
const commit = (context: string, state: string) => ({ context, state });

describe("a PR's standing from its checks", () => {
  it("is green when every check ended well, neutral and skipped included", () => {
    expect(
      pullState([
        run("Summary", "COMPLETED", "SUCCESS"),
        run("Rule: queue (queue)", "COMPLETED", "NEUTRAL"),
        commit("buildkite/loggd", "SUCCESS"),
      ]),
    ).toBe("green");
  });

  it("is testing while a check runs, a pending commit status included", () => {
    expect(pullState([run("Summary", "COMPLETED", "SUCCESS"), commit("buildkite/loggd", "PENDING")])).toBe("testing");
    expect(pullState([run("Supabase Preview", "IN_PROGRESS")])).toBe("testing");
  });

  it("is queued while the merge queue's own check runs, and only that is pending", () => {
    expect(pullState([run("Mergify Merge Queue", "IN_PROGRESS"), commit("buildkite/loggd", "SUCCESS")])).toBe("queued");
  });

  it("is failing on any red check, even in the queue; a cancelled one is not red", () => {
    expect(pullState([run("Mergify Merge Queue", "IN_PROGRESS"), commit("buildkite/loggd", "FAILURE")])).toBe("failing");
    expect(pullState([run("Supabase Preview", "COMPLETED", "CANCELLED"), commit("Vercel", "SUCCESS")])).toBe("green");
  });

  it("is open, not green, when no check has reported", () => {
    expect(pullState([])).toBe("open");
  });
});

describe("narrowing gh pr list to one status per ticket", () => {
  it("takes the newest PR per ticket, an open one before any merged one", () => {
    const open = [
      { number: 2399, isDraft: true, closingIssuesReferences: [{ number: 10 }], statusCheckRollup: [commit("ci", "PENDING")] },
      { number: 2390, isDraft: false, closingIssuesReferences: [{ number: 10 }], statusCheckRollup: [] },
    ];
    const merged = [
      { number: 2378, closingIssuesReferences: [{ number: 10 }, { number: 11 }], mergedAt: "2026-10-13T12:00:00Z" },
      { number: 2300, closingIssuesReferences: [{ number: 11 }] },
      { number: 2299, closingIssuesReferences: [] },
    ];
    expect(narrowPullStatuses(open, merged)).toEqual([
      { issue: 10, pr: 2399, state: "testing", draft: true, mergedAt: null },
      { issue: 11, pr: 2378, state: "merged", draft: false, mergedAt: "2026-10-13T12:00:00Z" },
    ]);
  });

  it("throws on a drifted shape rather than drawing a guess", () => {
    expect(() => narrowPullStatuses({}, [])).toThrow(RalphContractError);
    expect(() => narrowPullStatuses([{ number: "x" }], [])).toThrow(RalphContractError);
  });

  it("reads PRs only, never writes", () => {
    for (const surface of [COMMAND_SURFACE.pullsOpen, COMMAND_SURFACE.pullsMerged]) {
      expect(surface.args.slice(0, 2)).toEqual(["pr", "list"]);
      for (const verb of ["merge", "edit", "close", "ready", "comment", "review"]) expect(surface.args).not.toContain(verb);
    }
  });
});
