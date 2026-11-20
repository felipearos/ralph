// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ProjectSettingsView, SettingsWorktreeView } from "../contracts";
import { cleanUpCandidates, cleanUpConfirmLabel, cleanUpOutcome, cleanUpWhy } from "./worktree-cleanup-model";

function worktree(path: string, reconciliation: SettingsWorktreeView["reconciliation"], branch: string | null = null): SettingsWorktreeView {
  return { path, branch, main: false, loop: null, use: "idle", reconciliation };
}

function view(worktrees: SettingsWorktreeView[] | null): ProjectSettingsView {
  return {
    project: "loggd",
    checkout: { path: "/home/op/loggd", addedAt: null },
    worktreesDir: "/home/op/wt",
    worktreesDefault: true,
    defaultWorktreesDir: "/home/op/wt",
    config: { repo: "felipearos/loggd", owner: null, baseBranch: "main", displayName: "Loggd", gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] },
    problems: [],
    worktrees,
    worktreesProblem: null,
  };
}

describe("cleanUpCandidates", () => {
  it("offers only the prunable registrations, with their branch", () => {
    const candidates = cleanUpCandidates(
      view([
        worktree("/home/op/wt/gone", "prunable", "ralph/1-x"),
        worktree("/home/op/wt/locked", "orphaned", "ralph/2-y"),
        worktree("/home/op/wt/live", null, "main"),
        worktree("/home/op/wt/other", "unattributed"),
        worktree("/home/op/wt/detached-gone", "prunable"),
      ]),
    );
    expect(candidates).toEqual([
      { path: "/home/op/wt/gone", branch: "ralph/1-x" },
      { path: "/home/op/wt/detached-gone", branch: null },
    ]);
  });

  it("offers nothing while the view loads or when the worktrees were not read", () => {
    expect(cleanUpCandidates(null)).toEqual([]);
    expect(cleanUpCandidates(view(null))).toEqual([]);
  });
});

describe("cleanUpConfirmLabel", () => {
  it("counts the registrations, singular for one", () => {
    expect(cleanUpConfirmLabel(1)).toBe("Prune 1 registration");
    expect(cleanUpConfirmLabel(3)).toBe("Prune 3 registrations");
  });
});

describe("cleanUpWhy", () => {
  it("prefers the command's reason, then says when there is nothing to clean", () => {
    expect(cleanUpWhy("Local only", 2)).toBe("Local only");
    expect(cleanUpWhy(null, 0)).toBe("No stale registrations to clean up");
    expect(cleanUpWhy(null, 2)).toBeNull();
  });
});

describe("cleanUpOutcome", () => {
  it("is good when everything sent was pruned", () => {
    const outcome = cleanUpOutcome({ project: "loggd", outcome: "done", pruned: [{ path: "/a", branch: "b" }], skipped: [], why: "pruned 1" }, ["/a"]);
    expect(outcome.notice).toEqual({ tone: "good", title: "Pruned 1 registration", detail: "pruned 1" });
    expect(outcome.pruned).toEqual([{ path: "/a", branch: "b" }]);
    expect(outcome.skipped).toEqual([]);
  });

  it("stays good when the only skips are registrations that were not sent", () => {
    const skipped = [{ path: "/live", branch: "rafa", reason: "its directory is missing but git does not offer to prune it", registered: true }];
    const outcome = cleanUpOutcome({ project: "loggd", outcome: "done", pruned: [{ path: "/a", branch: null }], skipped, why: "pruned 1" }, ["/a"]);
    expect(outcome.notice.tone).toBe("good");
    expect(outcome.skipped).toEqual(skipped);
  });

  it("warns and lists the skips with their reasons", () => {
    const skipped = [{ path: "/c", branch: null, reason: "a loop runs in it", registered: true }];
    const outcome = cleanUpOutcome({ project: "loggd", outcome: "done", pruned: [], skipped, why: "skipped 1" }, ["/c"]);
    expect(outcome.notice).toEqual({ tone: "warn", title: "Pruned 0 registrations, skipped 1", detail: "skipped 1" });
    expect(outcome.skipped).toEqual(skipped);
  });

  it("does not warn over a sent path that is already gone", () => {
    const skipped = [{ path: "/gone", branch: null, reason: "it is no longer registered", registered: false }];
    const outcome = cleanUpOutcome({ project: "loggd", outcome: "done", pruned: [], skipped, why: "nothing to prune; skipped 1" }, ["/gone"]);
    expect(outcome.notice.tone).toBe("good");
  });

  it("is bad when the server refused", () => {
    const outcome = cleanUpOutcome({ project: "loggd", outcome: "refused", pruned: [], skipped: [], why: "no checkout" }, ["/a"]);
    expect(outcome.notice).toEqual({ tone: "bad", title: "Clean-up refused, nothing was pruned", detail: "no checkout" });
  });
});
