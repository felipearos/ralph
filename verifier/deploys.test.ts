// @vitest-environment node
/**
 * The verifier's deploy adapters: Vercel (felipearos/ralph#563) and GitHub
 * Deployments (#564). The earliest successful production deploy at or after
 * the merge that contains the merge commit is when it landed; every way the
 * vendor or the history read can fail is `unavailable`, never a throw.
 */
import { describe, expect, it } from "vitest";

import type { Fetch } from "./credentials";
import { DEPLOY_PAGE, GITHUB_DEPLOY_PAGES, ghContains, githubLandedDeploy, vercelLandedDeploy, type Contains, type Gh } from "./deploys";

const MERGED_AT = "2026-10-29T10:00:00.000Z";
const T = Date.parse(MERGED_AT);
const MIN = 60_000;

const deployment = (uid: string, sha: string | undefined, at: number, ready = true) => ({
  uid,
  url: `${uid}.vercel.app`,
  created: at - MIN,
  ...(ready ? { ready: at } : {}),
  meta: sha === undefined ? {} : { githubCommitSha: sha },
});

function vendor(body: unknown, status = 200): { fetcher: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetcher: Fetch = async (url) => {
    urls.push(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetcher, urls };
}

/** History: `merge` is in each sha listed as containing it. */
const history = (containing: string[]): Contains => async (ancestor, descendant) =>
  ancestor === descendant || containing.includes(descendant);

const DEPLOY = { source: "vercel" as const, project: "prj_1", team: null };

describe("vercelLandedDeploy", () => {
  it("lands on a deploy of the merge commit itself", async () => {
    const { fetcher, urls } = vendor({ deployments: [deployment("d1", "merge", T + 5 * MIN)] });
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history([]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "landed", id: "d1", url: "d1.vercel.app", deployedAt: new Date(T + 5 * MIN).toISOString() });
    expect(urls[0]).toBe("https://api.vercel.com/v6/deployments?projectId=prj_1&target=production&state=READY&limit=50&since=" + Date.parse(MERGED_AT));
  });

  it("lands via a later commit's deploy that contains it", async () => {
    const { fetcher } = vendor({ deployments: [deployment("d2", "later", T + 9 * MIN)] });
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history(["later"]))("merge", MERGED_AT);
    expect(result).toMatchObject({ kind: "landed", id: "d2" });
  });

  it("chooses the earliest containing deploy, and uses created when ready is absent", async () => {
    const { fetcher } = vendor({
      deployments: [
        deployment("late", "later2", T + 30 * MIN),
        deployment("unrelated", "other", T + 2 * MIN),
        deployment("early", "later1", T + 10 * MIN, false),
        deployment("nosha", undefined, T + MIN),
      ],
    });
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history(["later1", "later2"]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "landed", id: "early", url: "early.vercel.app", deployedAt: new Date(T + 9 * MIN).toISOString() });
  });

  it("ignores a deploy from before the merge, and is pending when nothing contains it", async () => {
    const { fetcher } = vendor({
      deployments: [deployment("before", "merge", T - MIN), deployment("other", "other", T + MIN)],
    });
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history([]))("merge", MERGED_AT);
    expect(result.kind).toBe("pending");
  });

  it("is unavailable on a 500, with the status", async () => {
    const { fetcher } = vendor("oops", 500);
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history([]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "unavailable", why: expect.stringContaining("500") });
  });

  it("is unavailable when fetch throws or times out", async () => {
    for (const error of [new TypeError("fetch failed"), new DOMException("The operation timed out.", "TimeoutError")]) {
      const fetcher: Fetch = async () => { throw error; };
      const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, history([]))("merge", MERGED_AT);
      expect(result).toEqual({ kind: "unavailable", why: expect.stringContaining(error.message) });
    }
  });

  it("is unavailable on a body that is not JSON or not a deployment list", async () => {
    for (const body of ["<html>", { nope: true }]) {
      const result = await vercelLandedDeploy(DEPLOY, "tok", vendor(body).fetcher, history([]))("merge", MERGED_AT);
      expect(result.kind).toBe("unavailable");
    }
  });

  it("is unavailable when contains cannot tell for a candidate", async () => {
    const { fetcher } = vendor({ deployments: [deployment("d1", "later", T + MIN)] });
    const result = await vercelLandedDeploy(DEPLOY, "tok", fetcher, async () => null)("merge", MERGED_AT);
    expect(result.kind).toBe("unavailable");
  });

  it("names a team by id as teamId and by slug as slug", async () => {
    const byId = vendor({ deployments: [] });
    await vercelLandedDeploy({ ...DEPLOY, team: "team_abc" }, "tok", byId.fetcher, history([]))("merge", MERGED_AT);
    expect(byId.urls[0]).toMatch(/&teamId=team_abc(&|$)/);
    const bySlug = vendor({ deployments: [] });
    await vercelLandedDeploy({ ...DEPLOY, team: "example" }, "tok", bySlug.fetcher, history([]))("merge", MERGED_AT);
    expect(bySlug.urls[0]).toMatch(/&slug=example(&|$)/);
  });
});

describe("ghContains", () => {
  const gh = (answer: { ok: boolean; stdout: string }): { run: Gh; calls: string[][] } => {
    const calls: string[][] = [];
    return { run: async (args) => { calls.push(args); return { ...answer, stderr: "" }; }, calls };
  };

  it("maps the compare status onto true, false and null", async () => {
    for (const [stdout, want] of [["identical\n", true], ["ahead\n", true], ["behind\n", false], ["diverged\n", false]] as const) {
      const { run, calls } = gh({ ok: true, stdout });
      expect(await ghContains(run)("a", "b")).toBe(want);
      expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}/compare/a...b", "--jq", ".status"]);
    }
    expect(await ghContains(gh({ ok: false, stdout: "" }).run)("a", "b")).toBeNull();
  });

  it("answers equal shas without a call", async () => {
    const { run, calls } = gh({ ok: true, stdout: "behind" });
    expect(await ghContains(run)("a", "a")).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("githubLandedDeploy", () => {
  const PRODUCTION = { source: "github-deployments" as const, environment: "production" };
  const iso = (at: number) => new Date(at).toISOString();
  const ghDeployment = (id: number, sha: string, at: number, environment = "production") => ({ id, sha, environment, created_at: iso(at) });
  const status = (state: string, at: number, url?: string) => ({ state, created_at: iso(at), ...(url === undefined ? {} : { environment_url: url }) });

  type Answer = { ok: boolean; stdout: string; stderr?: string } | "throw";
  /** Serves the deployment list and each deployment's statuses by path, and records every call. */
  function github(list: unknown, statuses: Record<number, unknown> = {}, overrides: Record<string, Answer> = {}): { run: Gh; calls: string[][] } {
    const calls: string[][] = [];
    const run: Gh = async (args) => {
      calls.push(args);
      const path = args[1] ?? "";
      const override = Object.entries(overrides).find(([prefix]) => path.startsWith(prefix))?.[1];
      if (override === "throw") throw new Error("gh exploded\nstack");
      if (override !== undefined) return { stderr: "", ...override };
      const id = /deployments\/(\d+)\/statuses/.exec(path)?.[1];
      const body = id === undefined ? list : statuses[Number(id)] ?? [];
      return { ok: true, stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "" };
    };
    return { run, calls };
  }

  it("lands on a deployment of the merge commit once it has a success status, at that status's time", async () => {
    const { run, calls } = github([ghDeployment(7, "merge", T + MIN)], {
      7: [status("success", T + 6 * MIN, "https://app.example"), status("in_progress", T + 2 * MIN)],
    });
    const result = await githubLandedDeploy(PRODUCTION, run, history([]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "landed", id: "7", url: "https://app.example", deployedAt: iso(T + 6 * MIN) });
    expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}/deployments?environment=production&per_page=50"]);
    expect(calls[1]?.[1]).toMatch(/^repos\/\{owner\}\/\{repo\}\/deployments\/7\/statuses\?per_page=\d+$/);
  });

  it("lands via a later commit's deployment, choosing the earliest succeeded containing one", async () => {
    const { run } = github(
      [
        ghDeployment(3, "later2", T + 20 * MIN),
        ghDeployment(2, "other", T + 2 * MIN),
        ghDeployment(1, "later1", T + 5 * MIN),
      ],
      {
        3: [status("success", T + 25 * MIN)],
        2: [status("success", T + 4 * MIN)],
        1: [{ state: "success", created_at: iso(T + 9 * MIN), target_url: "https://logs.example" }],
      },
    );
    const result = await githubLandedDeploy(PRODUCTION, run, history(["later1", "later2"]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "landed", id: "1", url: "https://logs.example", deployedAt: iso(T + 9 * MIN) });
  });

  it("counts an earlier success later marked inactive at its success time", async () => {
    const { run } = github([ghDeployment(4, "merge", T + MIN), ghDeployment(5, "later", T + 10 * MIN)], {
      4: [status("inactive", T + 12 * MIN), status("success", T + 3 * MIN)],
      5: [status("success", T + 12 * MIN)],
    });
    const result = await githubLandedDeploy(PRODUCTION, run, history(["later"]))("merge", MERGED_AT);
    expect(result).toMatchObject({ kind: "landed", id: "4", url: null, deployedAt: iso(T + 3 * MIN) });
  });

  it("is pending for unfinished, failed, non-production and pre-merge deployments", async () => {
    const { run } = github(
      [
        ghDeployment(1, "merge", T + MIN),
        ghDeployment(2, "merge", T + 2 * MIN),
        ghDeployment(3, "merge", T + 3 * MIN, "preview"),
        ghDeployment(4, "merge", T + 4 * MIN, "staging"),
        ghDeployment(5, "merge", T - MIN),
        ghDeployment(6, "merge", T + 6 * MIN),
      ],
      {
        1: [status("in_progress", T + 2 * MIN), status("pending", T + MIN), status("queued", T + MIN)],
        2: [status("failure", T + 3 * MIN), status("error", T + 4 * MIN)],
        3: [status("success", T + 4 * MIN)],
        4: [status("success", T + 5 * MIN)],
        5: [status("success", T + 7 * MIN)],
      },
    );
    const result = await githubLandedDeploy(PRODUCTION, run, history([]))("merge", MERGED_AT);
    expect(result).toEqual({ kind: "pending", why: `no successful production deployment since ${MERGED_AT} contains merge` });
  });

  it("does not filter on time when the merge time does not parse", async () => {
    const { run } = github([ghDeployment(5, "merge", T - MIN)], { 5: [status("success", T)] });
    expect(await githubLandedDeploy(PRODUCTION, run, history([]))("merge", "not a date")).toMatchObject({ kind: "landed", id: "5" });
  });

  it("is unavailable, never a throw, when anything cannot be read", async () => {
    const cases: Array<[ReturnType<typeof github>, Contains, RegExp]> = [
      [github([], {}, { "repos/{owner}/{repo}/deployments?": { ok: false, stdout: "", stderr: "HTTP 403: rate limited\nmore" } }), history([]), /^GitHub deployments could not be listed: HTTP 403: rate limited$/],
      [github([], {}, { "repos/{owner}/{repo}/deployments?": "throw" }), history([]), /^GitHub deployments could not be listed: gh exploded$/],
      [github("<html>"), history([]), /GitHub.*not JSON/],
      [github({ deployments: [] }), history([]), /GitHub.*not an array/],
      [github([ghDeployment(8, "merge", T + MIN)], {}, { "repos/{owner}/{repo}/deployments/8/": { ok: false, stdout: "", stderr: "HTTP 502" } }), history([]), /GitHub statuses of deployment 8 could not be read: HTTP 502/],
      [github([ghDeployment(8, "merge", T + MIN)], { 8: "nope" }), history([]), /GitHub.*deployment 8.*not JSON/],
      [github([ghDeployment(8, "later", T + MIN)], { 8: [status("success", T + 2 * MIN)] }), async () => null, /GitHub deployment 8 \(later\) contains merge/],
      [github([ghDeployment(8, "later", T + MIN)], { 8: [status("success", T + 2 * MIN)] }), async () => { throw new Error("git"); }, /GitHub deployment 8/],
    ];
    for (const [{ run }, contains, why] of cases) {
      const result = await githubLandedDeploy(PRODUCTION, run, contains)("merge", MERGED_AT);
      expect(result.kind).toBe("unavailable");
      expect(result.kind === "unavailable" ? result.why : "").toMatch(why);
    }
  });

  it("encodes the configured environment into the list query", async () => {
    const { run, calls } = github([]);
    await githubLandedDeploy({ ...PRODUCTION, environment: "prod eu" }, run, history([]))("merge", MERGED_AT);
    expect(calls[0]?.[1]).toBe("repos/{owner}/{repo}/deployments?environment=prod%20eu&per_page=50");
  });

  it("matches the environment regardless of case, as GitHub does", async () => {
    const { run } = github([ghDeployment(7, "merge", T + MIN, "Production")], { 7: [status("success", T + 2 * MIN)] });
    expect(await githubLandedDeploy(PRODUCTION, run, history([]))("merge", MERGED_AT)).toMatchObject({ kind: "landed", id: "7" });
  });

  it("stops reading statuses once no later deployment could have gone live first", async () => {
    const { run, calls } = github(
      [ghDeployment(9, "later2", T + 20 * MIN), ghDeployment(8, "later1", T + 3 * MIN), ghDeployment(7, "merge", T + MIN)],
      { 7: [status("success", T + 2 * MIN)], 8: [status("success", T + 4 * MIN)], 9: [status("success", T + 21 * MIN)] },
    );
    expect(await githubLandedDeploy(PRODUCTION, run, history(["later1", "later2"]))("merge", MERGED_AT)).toMatchObject({ kind: "landed", id: "7" });
    expect(calls.filter((args) => /statuses/.test(args[1] ?? "")).map((args) => args[1])).toEqual([
      expect.stringContaining("deployments/7/statuses"),
    ]);
  });

  it("pages back past a full page of deployments all newer than the merge", async () => {
    const full = Array.from({ length: DEPLOY_PAGE }, (_, i) => ghDeployment(100 + i, `new${i}`, T + (60 - i) * MIN));
    const older = [ghDeployment(7, "merge", T + MIN), ghDeployment(6, "old", T - MIN)];
    const page1 = "repos/{owner}/{repo}/deployments?environment=production&per_page=50";
    const { run, calls } = github([], { 7: [status("success", T + 2 * MIN)] }, {
      [`${page1}&page=2`]: { ok: true, stdout: JSON.stringify(older) },
      [page1]: { ok: true, stdout: JSON.stringify(full) },
    });
    expect(await githubLandedDeploy(PRODUCTION, run, history([]))("merge", MERGED_AT)).toMatchObject({ kind: "landed", id: "7" });
    expect(calls.filter((args) => /deployments\?/.test(args[1] ?? "")).map((args) => args[1])).toEqual([page1, `${page1}&page=2`]);
  });

  it("is unavailable, not a late anchor, when every page it may read is newer than the merge", async () => {
    const full = Array.from({ length: DEPLOY_PAGE }, (_, i) => ghDeployment(100 + i, `new${i}`, T + (60 - i) * MIN));
    const { run, calls } = github(full);
    const result = await githubLandedDeploy(PRODUCTION, run, history([]))("merge", MERGED_AT);
    expect(result).toMatchObject({ kind: "unavailable" });
    expect(calls).toHaveLength(GITHUB_DEPLOY_PAGES);
  });
});
