import { describe, expect, it } from "vitest";

import { parseBacktest, repeatCount, type BacktestTicketRead } from "./backtest";
import { buildPrSample, caseKey, type PrSampleDeps } from "./eval-source";

const REPO = "acme/app";

interface Pr { number: number; createdAt: string; mergedAt: string; headRefName?: string; body?: string; firstCommit?: string; closes?: number[] }

/** A gh that knows a few PRs: `pr view`, the compare API for the merge-base, and closing issues. */
function fakeGh(prs: Pr[], calls: string[][] = []): PrSampleDeps["gh"] {
  return async (args) => {
    calls.push(args);
    const byNumber = (n: string) => {
      const pr = prs.find((entry) => String(entry.number) === n);
      if (pr === undefined) throw new Error(`gh: no PR ${n}`);
      return pr;
    };
    if (args[0] === "pr" && args[1] === "view" && args.includes("closingIssuesReferences")) {
      return JSON.stringify({ closingIssuesReferences: (byNumber(args[2]!).closes ?? []).map((number) => ({ number })) });
    }
    if (args[0] === "pr" && args[1] === "view") {
      const pr = byNumber(args[2]!);
      return JSON.stringify({
        number: pr.number, body: pr.body ?? "", headRefName: pr.headRefName ?? `feature/${pr.number}`, createdAt: pr.createdAt, mergedAt: pr.mergedAt,
        baseRefOid: "main-sha", headRefOid: `head-${pr.number}`, commits: [{ oid: pr.firstCommit ?? `first-${pr.number}` }],
      });
    }
    if (args[0] === "api") return `base-of-${args[1]!.split("...")[1]}\n`;
    throw new Error(`gh: unexpected ${args.join(" ")}`);
  };
}

const ticketRead = (ref: string): BacktestTicketRead => ({
  ok: true, ref, title: "Fix the button", body: "It stays disabled.",
  comments: [
    { author: "ana", createdAt: "2026-10-01T09:00:00Z", body: "before work began" },
    { author: "bo", createdAt: "2026-10-03T09:00:00Z", body: "the answer is X" },
  ],
});

const config = (source: Record<string, unknown>) => parseBacktest({
  project: "/srv/app", source: { kind: "pr", repo: REPO, ...source }, arms: [{ name: "opus" }, { name: "sonnet", lineup: "sonnet-coder" }],
  caps: { trialMinutes: 60, batchMinutes: 240 },
});

describe("parseBacktest with a PR source", () => {
  it("takes a repo, PRs and an optional ticket, with no clerk or sample", () => {
    const parsed = config({ prs: [12, 12, 13], ticket: "OA-7" });
    expect(parsed.source).toEqual({ kind: "pr", repo: REPO, prs: [12, 13], ticket: "OA-7" });
    expect(parsed.clerk).toBe("");
  });
  it.each([
    [{ prs: [] }, "source.prs must list 1 to 10 PR numbers"],
    [{ prs: [1], ticket: "oa-7" }, "source.ticket must be #<number> on GitHub or a tracker key"],
    [{ prs: [1], repo: "app" }, "source.repo must be an owner/name repo"],
    [{ prs: [1], kind: "issue" }, "source.kind must be pr"],
  ])("names the offending key: %#", (source, error) => {
    expect(() => config(source)).toThrow(`backtest config: ${error}`);
  });
  it("refuses a clerk or a sample beside a source", () => {
    expect(() => parseBacktest({ project: "/srv/app", clerk: "clara", source: { kind: "pr", repo: REPO, prs: [1] }, caps: { trialMinutes: 1, batchMinutes: 1 } }))
      .toThrow("a config with a source names no clerk or sample");
  });
});

describe("parseBacktest with a set source", () => {
  const setConfig = (source: Record<string, unknown>) => parseBacktest({
    project: "/srv/app", source: { kind: "set", ...source }, caps: { trialMinutes: 60, batchMinutes: 240 },
  });
  it("reads absent lists as no filter and dedupes the given ones", () => {
    expect(setConfig({}).source).toEqual({ kind: "set", tags: [], cases: [] });
    expect(setConfig({ tags: ["ui", "ui", "db"], cases: ["acme-app-12", "acme-app-12"] }).source)
      .toEqual({ kind: "set", tags: ["ui", "db"], cases: ["acme-app-12"] });
  });
  it("keeps the pinned set version, a sha or null", () => {
    expect(setConfig({ version: "abc1234" }).source).toEqual({ kind: "set", tags: [], cases: [], version: "abc1234" });
    expect(setConfig({ version: null }).source).toEqual({ kind: "set", tags: [], cases: [], version: null });
  });
  it("repeats disputed cases twice by default, as a PR source does", () => {
    expect(repeatCount(setConfig({}))).toBe(2);
  });
  it.each([
    [{ repo: REPO }, "unknown key source.repo"],
    [{ version: "main" }, "source.version must be the set's commit sha"],
    [{ tags: [""] }, "source.tags must list at most 200 non-empty tags"],
    [{ tags: "ui" }, "source.tags must list"],
    [{ cases: ["Acme_App"] }, "source.cases must list at most 200 kebab-case case ids"],
    [{ cases: Array.from({ length: 201 }, (_, i) => `c-${i}`) }, "source.cases must list at most 200"],
  ])("names the offending key: %#", (source, error) => {
    expect(() => setConfig(source)).toThrow(`backtest config: ${error}`);
  });
});

describe("buildPrSample", () => {
  it("freezes one case at the first-opened PR's merge-base, with the comments from before it opened", async () => {
    const asked: string[] = [];
    const calls: string[][] = [];
    const sample = await buildPrSample(config({ prs: [13, 12], ticket: "OA-7" }), {
      gh: fakeGh([
        { number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z" },
        { number: 13, createdAt: "2026-10-02T12:00:00Z", mergedAt: "2026-10-03T10:00:00Z" },
      ], calls),
      loopNames: ["ralph"],
      readTicket: async (ref) => { asked.push(ref); return ticketRead(ref); },
    });
    expect(asked).toEqual(["OA-7"]);
    expect(sample.arms).toEqual([{ name: "opus", lineup: "live", overlay: null }, { name: "sonnet", lineup: "sonnet-coder", overlay: null }]);
    const [ticket] = sample.tickets;
    expect(ticket).toMatchObject({
      oaKey: "OA-7", ticketRef: "OA-7", repo: REPO, mergeBase: "base-of-first-12", startedAt: "2026-10-02T10:00:00Z", reference: "person",
      comments: { kept: 1, dropped: 1 }, frozen: { title: "Fix the button", comments: [{ body: "before work began" }] },
    });
    // Listed in merge order.
    expect(ticket!.humanPrs.map((pr) => pr.number)).toEqual([13, 12]);
    expect(calls.find((args) => args[0] === "api")).toEqual(["api", `repos/${REPO}/compare/main-sha...first-12`, "--jq", ".merge_base_commit.sha"]);
    expect(sample.notes).toEqual([]);
  });

  it("reads the ticket from the issue the PR closes when the source names none, and keys a GitHub issue GH-<n>", async () => {
    const asked: string[] = [];
    const sample = await buildPrSample(config({ prs: [12] }), {
      gh: fakeGh([{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z", closes: [34] }]),
      loopNames: [], readTicket: async (ref) => { asked.push(ref); return ticketRead(ref); },
    });
    expect(asked).toEqual(["#34"]);
    expect(sample.tickets[0]).toMatchObject({ oaKey: "GH-34", ticketRef: "#34" });
  });

  it("takes a loop's merged PR as the reference, and says so", async () => {
    const sample = await buildPrSample(config({ prs: [12], ticket: "#34" }), {
      gh: fakeGh([{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z", headRefName: "rafa/34-fix" }]),
      loopNames: ["rafa"], readTicket: async (ref) => ticketRead(ref),
    });
    expect(sample.tickets[0]!.reference).toBe("loop");
    expect(sample.notes).toEqual(["the reference is a loop's merged work, not a person's"]);
  });

  it.each([
    [[{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "" }], "acme/app#12 is not merged"],
    [[{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z" }], "closes no issue; name the ticket it resolved as source.ticket"],
    [[{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z", closes: [1, 2] }], "closes 2 issues"],
  ])("refuses before any model runs: %#", async (prs, error) => {
    await expect(buildPrSample(config({ prs: [12] }), { gh: fakeGh(prs), loopNames: [], readTicket: async (ref) => ticketRead(ref) })).rejects.toThrow(error);
  });

  it("refuses a ticket it cannot read", async () => {
    await expect(buildPrSample(config({ prs: [12], ticket: "OA-7" }), {
      gh: fakeGh([{ number: 12, createdAt: "2026-10-02T10:00:00Z", mergedAt: "2026-10-04T10:00:00Z" }]),
      loopNames: [], readTicket: async () => ({ ok: false, reason: "404" }),
    })).rejects.toThrow("eval: cannot read ticket OA-7: 404");
  });

  it("keys GitHub issues apart from tracker keys", () => {
    expect(caseKey("#12")).toBe("GH-12");
    expect(caseKey("OA-12")).toBe("OA-12");
  });
});
