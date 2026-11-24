// @vitest-environment node
/**
 * What `ci-log.ts` promises a session with a red check: its arguments reach
 * the reader of that check's CI — less the one flag that reader refuses — gh-actions-log for GitHub Actions,
 * bk-log for Buildkite — and the reader's exit code is ci-log's. A fake gh and
 * fake readers that record their argv; nothing is spawned.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILDKITE_RERUN_REFUSAL, main, routeFor } from "./ci-log";
import type { Gh } from "./pr-wait";

const REPO = "acme-org/acme-app";
const BK_URL = "https://buildkite.com/acme-org/acme-app/builds/12";
const RUN_URL = `https://github.com/${REPO}/actions/runs/700`;
const BK_PROJECT: NodeJS.ProcessEnv = { RALPH_PROJECT_REPO: REPO, RALPH_REQUIRED_CHECKS: "buildkite/acme-app" };
const ACTIONS_PROJECT: NodeJS.ProcessEnv = { RALPH_PROJECT_REPO: REPO, RALPH_REQUIRED_CHECKS: "test" };

const failingBuildkite = { name: "buildkite/acme-app", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: BK_URL };
const failingActions = { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN_URL}/job/9` };
const passingActions = { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: RUN_URL };

type FakeGh = Gh & { calls: string[][] };

function rollupGh(rollup: unknown[] | null): FakeGh {
  const calls: string[][] = [];
  const gh = ((args: string[]) => {
    calls.push(args);
    if (rollup === null) return { status: 1, stdout: "", stderr: "gh: HTTP 502" };
    return { status: 0, stdout: JSON.stringify({ statusCheckRollup: rollup }), stderr: "" };
  }) as FakeGh;
  gh.calls = calls;
  return gh;
}

function readers(codes: { actions?: number; buildkite?: number } = {}) {
  const calls: Array<{ reader: "actions" | "buildkite"; argv: string[] }> = [];
  return {
    calls,
    actions: (argv: string[]) => {
      calls.push({ reader: "actions", argv });
      return codes.actions ?? 0;
    },
    buildkite: async (argv: string[]) => {
      calls.push({ reader: "buildkite", argv });
      return codes.buildkite ?? 0;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ci-log routing by URL", () => {
  it("sends an Actions run URL to gh-actions-log with its argv unchanged", async () => {
    const r = readers();
    const argv = [RUN_URL, "--full", ".ralph/logs"];
    expect(await main(argv, BK_PROJECT, { gh: rollupGh([]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "actions", argv }]);
  });

  it("sends a Buildkite build URL to bk-log with its argv unchanged", async () => {
    const r = readers();
    const argv = [BK_URL, "--json"];
    expect(await main(argv, ACTIONS_PROJECT, { gh: rollupGh([]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "buildkite", argv }]);
  });
});

describe("ci-log routing by PR", () => {
  it("sends a PR with a failing Actions check to gh-actions-log", async () => {
    const r = readers();
    const gh = rollupGh([failingActions]);
    const argv = ["--pr", "12"];
    expect(await main(argv, BK_PROJECT, { gh, ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "actions", argv }]);
    expect(gh.calls).toEqual([["pr", "view", "12", "--repo", REPO, "--json", "statusCheckRollup"]]);
  });

  it("sends a PR with a failing Buildkite check to bk-log, argv identical", async () => {
    const r = readers();
    const argv = ["--pr", "12", "--full", ".ralph/logs"];
    expect(await main(argv, ACTIONS_PROJECT, { gh: rollupGh([failingBuildkite, passingActions]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "buildkite", argv }]);
  });

  it("runs both readers, Buildkite first, when both kinds are failing; exit is the first non-zero", async () => {
    const r = readers({ buildkite: 0, actions: 2 });
    const argv = ["--pr", "12"];
    const both = { ...ACTIONS_PROJECT, RALPH_REQUIRED_CHECKS: "buildkite/acme-app\ntest" };
    expect(await main(argv, both, { gh: rollupGh([failingActions, failingBuildkite]), ...r })).toBe(2);
    expect(r.calls).toEqual([
      { reader: "buildkite", argv },
      { reader: "actions", argv },
    ]);
  });

  it("lets the failing required checks decide over a failing optional one", async () => {
    const r = readers();
    const optionalActions = { ...failingActions, name: "nightly" };
    const argv = ["--pr", "12"];
    expect(await main(argv, BK_PROJECT, { gh: rollupGh([optionalActions, failingBuildkite]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "buildkite", argv }]);
  });

  it("routes by the project when nothing is failing", async () => {
    const r = readers();
    expect(await main(["--pr", "12"], BK_PROJECT, { gh: rollupGh([passingActions]), ...r })).toBe(0);
    expect(r.calls.map((call) => call.reader)).toEqual(["buildkite"]);
  });

  it("routes by the project when the rollup cannot be read", async () => {
    const bk = readers();
    expect(await main(["--pr", "12"], BK_PROJECT, { gh: rollupGh(null), ...bk })).toBe(0);
    expect(bk.calls.map((call) => call.reader)).toEqual(["buildkite"]);
    const actions = readers();
    expect(await main(["--pr", "12"], ACTIONS_PROJECT, { gh: rollupGh(null), ...actions })).toBe(0);
    expect(actions.calls.map((call) => call.reader)).toEqual(["actions"]);
  });

  it("names --repo to gh when the argv carries it", async () => {
    const gh = rollupGh([failingActions]);
    await main(["--pr", "#12", "--repo", "acme-org/other"], ACTIONS_PROJECT, { gh, ...readers() });
    expect(gh.calls).toEqual([["pr", "view", "12", "--repo", "acme-org/other", "--json", "statusCheckRollup"]]);
  });
});

describe("ci-log strips the flag a reader does not know", () => {
  it("drops --repo <value> from bk-log's argv on a Buildkite route", async () => {
    const r = readers();
    const gh = rollupGh([failingBuildkite]);
    expect(await main(["--pr", "12", "--repo", "acme-org/other", "--json"], BK_PROJECT, { gh, ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "buildkite", argv: ["--pr", "12", "--json"] }]);
    // The rollup is still read in the named repo.
    expect(gh.calls).toEqual([["pr", "view", "12", "--repo", "acme-org/other", "--json", "statusCheckRollup"]]);
  });

  it("on a dual route with --job, drops --no-history for gh-actions-log and ignores the reader without the job", async () => {
    const both = { ...ACTIONS_PROJECT, RALPH_REQUIRED_CHECKS: "buildkite/acme-app\ntest" };
    const argv = ["--pr", "12", "--job", "e2e", "--no-history"];
    const r = readers({ buildkite: 1, actions: 0 });
    expect(await main(argv, both, { gh: rollupGh([failingActions, failingBuildkite]), ...r })).toBe(0);
    expect(r.calls).toEqual([
      { reader: "buildkite", argv },
      { reader: "actions", argv: ["--pr", "12", "--job", "e2e"] },
    ]);
    // Neither has the job: that is a 1.
    const none = readers({ buildkite: 1, actions: 1 });
    expect(await main(argv, both, { gh: rollupGh([failingActions, failingBuildkite]), ...none })).toBe(1);
    // A real failure in the other reader still counts.
    const broken = readers({ buildkite: 2, actions: 0 });
    expect(await main(argv, both, { gh: rollupGh([failingActions, failingBuildkite]), ...broken })).toBe(2);
  });
});

describe("ci-log routing by project", () => {
  for (const argv of [["--branch", "feature"], ["2425"]]) {
    it(`routes ${argv.join(" ")} by the required checks`, async () => {
      const bk = readers();
      expect(await main(argv, BK_PROJECT, { gh: rollupGh([]), ...bk })).toBe(0);
      expect(bk.calls).toEqual([{ reader: "buildkite", argv }]);
      const actions = readers();
      expect(await main(argv, ACTIONS_PROJECT, { gh: rollupGh([]), ...actions })).toBe(0);
      expect(actions.calls).toEqual([{ reader: "actions", argv }]);
    });
  }

  it("does not read the PR for a positional target or a branch", async () => {
    const gh = rollupGh([]);
    await main(["--branch", "feature"], ACTIONS_PROJECT, { gh, ...readers() });
    await main([RUN_URL], ACTIONS_PROJECT, { gh, ...readers() });
    expect(gh.calls).toEqual([]);
  });
});

describe("ci-log --rerun", () => {
  it("refuses a re-run on a Buildkite route without calling bk-log", async () => {
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
    const r = readers();
    expect(await main(["--pr", "12", "--rerun"], ACTIONS_PROJECT, { gh: rollupGh([failingBuildkite]), ...r })).toBe(1);
    expect(r.calls).toEqual([]);
    expect(err).toEqual([BUILDKITE_RERUN_REFUSAL]);
  });

  it("re-runs only the Actions run, without the Buildkite refusal, when both are failing", async () => {
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
    const r = readers();
    const argv = ["--pr", "12", "--rerun"];
    expect(await main(argv, ACTIONS_PROJECT, { gh: rollupGh([failingActions, failingBuildkite]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "actions", argv }]);
    expect(err).toEqual([]);
  });

  it("passes a re-run on an Actions route to gh-actions-log", async () => {
    const r = readers();
    const argv = ["--pr", "12", "--rerun"];
    expect(await main(argv, BK_PROJECT, { gh: rollupGh([failingActions]), ...r })).toBe(0);
    expect(r.calls).toEqual([{ reader: "actions", argv }]);
  });
});

describe("ci-log exit codes and errors", () => {
  it("returns the reader's exit code", async () => {
    expect(await main([BK_URL], ACTIONS_PROJECT, { gh: rollupGh([]), ...readers({ buildkite: 75 }) })).toBe(75);
    expect(await main([RUN_URL], ACTIONS_PROJECT, { gh: rollupGh([]), ...readers({ actions: 64 }) })).toBe(64);
  });

  it("prints ci-log: <msg> and exits 2 when a reader throws", async () => {
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void err.push(args.join(" ")));
    const code = await main([RUN_URL], ACTIONS_PROJECT, {
      gh: rollupGh([]),
      actions: () => {
        throw new Error("boom");
      },
    });
    expect(code).toBe(2);
    expect(err).toEqual(["ci-log: boom"]);
  });

  it("prints a usage naming both readers for --help, and calls neither", async () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    const r = readers();
    expect(await main(["--help"], ACTIONS_PROJECT, { gh: rollupGh([]), ...r })).toBe(0);
    expect(r.calls).toEqual([]);
    expect(out.join("\n")).toContain("bk-log.ts");
    expect(out.join("\n")).toContain("gh-actions-log.ts");
  });
});

describe("routeFor", () => {
  it("treats a bare number as the project's and a URL as its provider's", () => {
    expect(routeFor({ target: "#2425", requiredChecks: ["buildkite/acme-app"] })).toEqual(["buildkite"]);
    expect(routeFor({ target: "2425", requiredChecks: ["test"] })).toEqual(["actions"]);
    expect(routeFor({ target: BK_URL, requiredChecks: ["test"] })).toEqual(["buildkite"]);
    expect(routeFor({ target: `${RUN_URL}/job/9`, requiredChecks: ["buildkite/acme-app"] })).toEqual(["actions"]);
  });

  it("ignores passing and pending checks in the rollup", () => {
    const pending = { name: "buildkite/acme-app", status: "IN_PROGRESS", detailsUrl: BK_URL };
    expect(routeFor({ target: null, rollup: [pending, passingActions], requiredChecks: ["test"] })).toEqual(["actions"]);
    expect(routeFor({ target: null, rollup: [failingActions, pending], requiredChecks: ["buildkite/acme-app"] })).toEqual([
      "actions",
    ]);
  });
});
