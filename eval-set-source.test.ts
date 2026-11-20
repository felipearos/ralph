import { describe, expect, it } from "vitest";

import { parseBacktest } from "./backtest";
import { buildSetSample, selectCases, ticketOfCase, type SetSampleDeps } from "./eval-set-source";
import { caseFromTicket, parseCase, type CaseStatus, type EvalCase } from "./evals-set";

const REPO = "acme/app";

/** A valid case through the real parser, so a fixture can never drift from the stored shape. */
/** An accepted operator check (#857) in its stored shape. */
const accepted = (spec: { test: string } | { command: string }) => ({ ...spec, base: "fail", reference: "pass", acceptedAt: "2026-11-19T00:00:00Z", acceptedBy: "felipe" });

const evalCase = (pr: number, options: { tags?: string[]; status?: CaseStatus; check?: { test: string } | { command: string } } = {}): EvalCase => parseCase({
  v: 1, id: `acme-app-${pr}`, kind: "coder", repo: REPO,
  prs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f1", headRefOid: "h1" }],
  baseCommit: `base-${pr}`, startedAt: "2026-10-28T01:00:00Z",
  ticket: { ref: `#${pr - 1}`, title: "Fix it", body: "It is broken", comments: [{ author: "ana", createdAt: "2026-10-27T00:00:00Z", body: "still broken" }], dropped: 2 },
  reference: "person", heldOut: ["src/a.test.ts"], tags: options.tags ?? ["ui"], reason: "a clean bugfix", notes: "the fix is in a.ts",
  ...(options.check === undefined ? {} : { check: accepted(options.check) }),
  status: options.status ?? "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe",
});

const setConfig = (source: { tags?: string[]; cases?: string[] } = {}) => parseBacktest({
  project: "/srv/app", source: { kind: "set", ...source }, arms: [{ name: "opus" }],
  caps: { trialMinutes: 60, batchMinutes: 240 }, sources: { [REPO]: "/srv/app" },
});

const ids = (cases: readonly EvalCase[]) => cases.map((c) => c.id);

describe("selectCases", () => {
  const cases = [
    evalCase(1, { tags: ["ui"] }),
    evalCase(2, { tags: ["db"], status: "saturated" }),
    evalCase(3, { tags: ["ui", "db"], status: "retired" }),
    evalCase(4, { tags: ["api"] }),
  ];
  it("selects every case but a retired one with no filter; a saturated case still runs", () => {
    expect(ids(selectCases(cases, { tags: [], cases: [] }))).toEqual(["acme-app-1", "acme-app-2", "acme-app-4"]);
  });
  it("keeps a case carrying any of the tags", () => {
    expect(ids(selectCases(cases, { tags: ["db", "api"], cases: [] }))).toEqual(["acme-app-2", "acme-app-4"]);
  });
  it("keeps only the listed ids, never a retired one", () => {
    expect(ids(selectCases(cases, { tags: [], cases: ["acme-app-4", "acme-app-3"] }))).toEqual(["acme-app-4"]);
  });
  it("needs both the tag and the id when both are given", () => {
    expect(ids(selectCases(cases, { tags: ["ui"], cases: ["acme-app-1", "acme-app-4"] }))).toEqual(["acme-app-1"]);
  });
});

describe("ticketOfCase", () => {
  it("round-trips through caseFromTicket and carries no graded-only field", () => {
    const c = evalCase(12, { check: { command: "bun test" } });
    const ticket = ticketOfCase(c);
    expect(ticket).toMatchObject({ oaKey: c.id, intakeKey: null, movedAt: c.startedAt, mergeBase: "base-12", ticketRef: "#11", comments: { kept: 1, dropped: 2 }, kind: "coder", reference: "person" });
    for (const key of ["heldOut", "notes", "check", "tags", "reason"]) expect(ticket).not.toHaveProperty(key);
    expect(JSON.stringify(ticket)).not.toContain("the fix is in a.ts");
    expect(JSON.stringify(ticket)).not.toContain("bun test");
    // A check enters only through `evals-set.ts check`, never at add, so the round trip carries none.
    const back = caseFromTicket(ticket, { heldOut: c.heldOut, tags: c.tags, reason: c.reason, notes: c.notes, addedAt: c.addedAt, addedBy: c.addedBy });
    const { check: _check, ...unchecked } = c;
    expect(back).toEqual(unchecked);
  });
});

describe("buildSetSample", () => {
  const deps = (cases: EvalCase[], unrunnable: SetSampleDeps["unrunnable"] = async () => null, version: string | null = "abc1234"): SetSampleDeps => ({
    readSet: () => ({ version, cases }),
    unrunnable,
  });

  it("runs the runnable cases, skips the rest with their reasons, and records the set's version and selection", async () => {
    const asked: [string, string | undefined][] = [];
    const sample = await buildSetSample(setConfig(), deps([evalCase(1), evalCase(2), evalCase(3)], async (c, checkout) => {
      asked.push([c.id, checkout]);
      if (c.id === "acme-app-2") return "base commit base-2 is not in /srv/app";
      if (c.id === "acme-app-3") throw new Error("gh exploded");
      return null;
    }));
    expect(asked).toEqual([["acme-app-1", "/srv/app"], ["acme-app-2", "/srv/app"], ["acme-app-3", "/srv/app"]]);
    expect(sample.tickets.map((ticket) => ticket.oaKey)).toEqual(["acme-app-1"]);
    expect(sample.skipped).toEqual([
      { oaKey: "acme-app-2", intakeKey: null, reason: "base commit base-2 is not in /srv/app" },
      { oaKey: "acme-app-3", intakeKey: null, reason: "gh exploded" },
    ]);
    expect(sample.set).toEqual({ version: "abc1234", selected: ["acme-app-1", "acme-app-2", "acme-app-3"] });
    expect(sample.arms).toEqual([{ name: "opus", lineup: "live", overlay: null }]);
    expect(sample.notes).toEqual(["2 selected cases cannot run; see Unrunnable"]);
  });

  it("records an uncommitted set as a null version, with no note when every case runs", async () => {
    const sample = await buildSetSample(setConfig(), deps([evalCase(1)], async () => null, null));
    expect(sample.set).toEqual({ version: null, selected: ["acme-app-1"] });
    expect(sample.notes).toEqual([]);
  });

  it("lists exactly the selected cases that carry an operator check, and hands scoring each one's test or command only", async () => {
    const sample = await buildSetSample(setConfig(), deps([evalCase(1, { check: { command: "bun test e2e" } }), evalCase(2), evalCase(3, { check: { test: "src/b.test.ts" } })]));
    expect(sample.set?.checks).toEqual(["acme-app-1", "acme-app-3"]);
    expect(sample.set?.checkRuns).toEqual({ "acme-app-1": { command: "bun test e2e" }, "acme-app-3": { test: "src/b.test.ts" } });
    expect(sample.tickets.map((ticket) => JSON.stringify(ticket)).join("")).not.toContain("bun test e2e");
  });

  it("leaves checks and checkRuns out when no selected case carries a check", async () => {
    const sample = await buildSetSample(setConfig(), deps([evalCase(1), evalCase(2)]));
    expect(sample.set).not.toHaveProperty("checks");
    expect(sample.set).not.toHaveProperty("checkRuns");
  });

  it("reports a hand-picked case that is retired or gone instead of dropping it", async () => {
    const sample = await buildSetSample(setConfig({ cases: ["acme-app-1", "acme-app-3", "acme-app-9"] }), deps([evalCase(1), evalCase(3, { status: "retired" })]));
    expect(sample.tickets.map((ticket) => ticket.oaKey)).toEqual(["acme-app-1"]);
    expect(sample.skipped).toEqual([
      { oaKey: "acme-app-3", intakeKey: null, reason: "the case is retired" },
      { oaKey: "acme-app-9", intakeKey: null, reason: "the case is not in the test set" },
    ]);
    expect(sample.set?.selected).toEqual(["acme-app-1"]);
  });

  it("finds the checkout whatever case the repo is spelled in", async () => {
    const asked: (string | undefined)[] = [];
    const config = parseBacktest({ project: "/srv/app", source: { kind: "set" }, arms: [{ name: "opus" }], caps: { trialMinutes: 60, batchMinutes: 240 }, sources: { "Acme/App": "/srv/app" } });
    await buildSetSample(config, deps([evalCase(1)], async (_c, checkout) => { asked.push(checkout); return null; }));
    expect(asked).toEqual(["/srv/app"]);
  });

  it("refuses the run when the set cannot be read", async () => {
    await expect(buildSetSample(setConfig(), { readSet: () => { throw new Error("evals case: bad.json: unknown key x"); }, unrunnable: async () => null }))
      .rejects.toThrow("unknown key x");
  });

  it("refuses an empty selection, naming the filter", async () => {
    await expect(buildSetSample(setConfig({ tags: ["perf"] }), deps([evalCase(1)]))).rejects.toThrow("the test set selects no case for tags perf");
    await expect(buildSetSample(setConfig(), deps([evalCase(1, { status: "retired" })]))).rejects.toThrow("the test set selects no case");
  });
});
