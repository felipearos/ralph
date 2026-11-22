// @vitest-environment node
/**
 * The app repos' PRs for the intake page's Seguimiento column: which keys a
 * PR names, the cache, and a GitHub that cannot be read being a note with
 * the last list (or none), never a throw. `gh` is a stub here: nothing spawns.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { PULLS_REFRESH_MS, keysIn, pullRefs, pullsCachePath, pullsNaming, readPulls, type GhRunner } from "./pulls";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const cachePath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-clerk-pulls-"));
  dirs.push(dir);
  return pullsCachePath(join(dir, "clara.json"));
};

const REPOS = ["example-org/acme-backoffice", "example-org/acme-pwa"];
const NOW = Date.parse("2026-10-22T19:00:00.000Z");

const ghRow = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Arregla OAI-${number}`,
  body: "",
  headRefName: `fix-${number}`,
  state: "OPEN",
  url: `https://github.com/x/y/pull/${number}`,
  createdAt: "2026-10-20T12:00:00Z",
  mergedAt: null,
  closedAt: null,
  ...over,
});

/** A `gh` that answers each repo's list from `rows`, and counts its calls. */
function stubGh(rows: Record<string, unknown[]>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (async (args: string[]) => {
    calls.push(args);
    const repo = args[args.indexOf("--repo") + 1]!;
    return JSON.stringify(rows[repo] ?? []);
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

describe("keysIn", () => {
  it("reads every key a title, body or branch names, whatever its case, and none out of a longer word or number", () => {
    expect(keysIn("Arregla OAI-7 (ver OA-200)", "", "oai-12-fix-login").sort()).toEqual(["OA-200", "OAI-12", "OAI-7"]);
    expect(keysIn("XOAI-1 and OAI-12")).toEqual(["XOAI-1", "OAI-12"]);
    expect(pullsNaming(pullRefs("x/y", [ghRow(1, { title: "XOAI-1, OAI-12" })]), ["OAI-1"])).toEqual([]);
    expect(pullsNaming(pullRefs("x/y", [ghRow(1, { title: "nada", body: "Cierra OAI-1." })]), ["OAI-1"])).toHaveLength(1);
    // A sibling quoted as code (pr-ref --criteria copies criteria that way) is not this PR's.
    const quoted = pullRefs("x/y", [ghRow(2, { title: "nada", body: "Ticket: OAI-1 https://x\n\n- [ ] sigue a `OAI-2`\n\n```\nOAI-3\n```", headRefName: "oai-1-fix" })]);
    expect(quoted[0]!.keys).toEqual(["OAI-1"]);
    expect(pullsNaming(quoted, ["OAI-2"])).toEqual([]);
  });
});

describe("pullRefs", () => {
  it("distinguishes an open draft while keeping merged and closed outcomes authoritative", () => {
    const refs = pullRefs("x/y", [
      ghRow(1, { isDraft: true }),
      ghRow(2, { isDraft: false }),
      ghRow(3, { isDraft: true, state: "MERGED" }),
      ghRow(4, { isDraft: true, state: "CLOSED" }),
    ]);
    expect(refs.map((ref) => ref.state)).toEqual(["borrador", "abierto", "mergeado", "cerrado"]);
    expect(refs[0]!.at).toBe("2026-10-20T12:00:00Z");
  });

  it("reads each state and the time it reached it, and drops a row with no number or link", () => {
    const refs = pullRefs("x/y", [
      ghRow(1),
      ghRow(2, { state: "MERGED", mergedAt: "2026-10-21T10:00:00Z", closedAt: "2026-10-21T10:00:00Z" }),
      ghRow(3, { state: "CLOSED", closedAt: "2026-10-21T11:00:00Z" }),
      { title: "sin número" },
      ghRow(4, { url: "" }),
    ]);
    expect(refs.map((ref) => [ref.number, ref.state, ref.at])).toEqual([
      [1, "abierto", "2026-10-20T12:00:00Z"],
      [2, "mergeado", "2026-10-21T10:00:00Z"],
      [3, "cerrado", "2026-10-21T11:00:00Z"],
    ]);
    expect(() => pullRefs("x/y", { not: "a list" })).toThrow(/no list/);
  });
});

describe("readPulls", () => {
  it("reads each repo once, then serves the cache until the refresh interval has passed", async () => {
    const path = cachePath();
    const gh = stubGh({ [REPOS[0]!]: [ghRow(1)], [REPOS[1]!]: [ghRow(2)] });
    const first = await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW, gh });
    expect(first.note).toBeNull();
    expect(first.pulls.map((pull) => [pull.repo, pull.number])).toEqual([
      [REPOS[0], 1],
      [REPOS[1], 2],
    ]);
    // One list per repo, never one search per ticket.
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[0]).toEqual(expect.arrayContaining(["pr", "list", "--repo", REPOS[0], "--state", "all"]));
    expect(gh.calls[0]![gh.calls[0]!.indexOf("--json") + 1]!.split(",")).toContain("isDraft");

    await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW + PULLS_REFRESH_MS - 1, gh });
    expect(gh.calls).toHaveLength(2);
    await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW + PULLS_REFRESH_MS, gh });
    expect(gh.calls).toHaveLength(4);
  });

  it("is a note and no PRs, never a throw, when GitHub cannot be read and nothing was read before", async () => {
    const failing: GhRunner = async () => {
      throw new Error("gh pr list failed: HTTP 502");
    };
    const read = await readPulls({ cachePath: cachePath(), repos: REPOS, nowMs: NOW, gh: failing });
    expect(read.pulls).toEqual([]);
    expect(read.note).toMatch(/^pull requests not read from .* — gh pr list failed: HTTP 502; the intake page shows no PRs, tried again in 15m$/);
  });

  it("keeps the last list on a failed refresh, and waits the interval before trying again", async () => {
    const path = cachePath();
    await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW, gh: stubGh({ [REPOS[0]!]: [ghRow(1)] }) });
    let calls = 0;
    const failing: GhRunner = async () => {
      calls++;
      return "not json";
    };
    const read = await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW + PULLS_REFRESH_MS, gh: failing });
    expect(read.pulls.map((pull) => pull.number)).toEqual([1]);
    expect(read.note).toMatch(/keeps the 1 read before/);
    const again = await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW + PULLS_REFRESH_MS + 60_000, gh: failing });
    expect(again).toEqual({ pulls: read.pulls, note: null });
    expect(calls).toBe(1);
  });

  it("asks nothing with no repos, and a cache it cannot write costs only the cache", async () => {
    const gh = stubGh({});
    expect(await readPulls({ cachePath: cachePath(), repos: [], nowMs: NOW, gh })).toEqual({ pulls: [], note: null });
    expect(gh.calls).toHaveLength(0);
    const path = cachePath();
    mkdirSync(path);
    expect((await readPulls({ cachePath: path, repos: REPOS, nowMs: NOW, gh })).note).toBeNull();
  });
});
