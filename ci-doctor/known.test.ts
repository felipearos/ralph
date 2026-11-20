// @vitest-environment node
/**
 * What the ci-doctor's store promises a coder reading a red: the `known:`
 * lines. The claims pinned hardest here are the ones a stale store could get
 * dangerously wrong — "not the diff", "likely the diff" and "fix PR open" all
 * stop a loop working, so each is checked against a case the doctor has since
 * settled as well as a live one.
 */
import { describe, expect, it } from "vitest";

import { INFRA_LIMIT, knownNotes, type KnownContext } from "./known";
import { emptyStore, identify, type Case, type CaseKind, type CaseState, type CiHealthStore, type Evidence } from "./store";

const FILE = "components/__tests__/diary.test.tsx";
const TEST = `${FILE} > DiaryTab media mode > applies a TV-only genre`;
const TITLE = `FAIL ${TEST}`;

const LOGGD: KnownContext = { branch: "ralph/1901-x", repoSlug: "loggd" };

const evidence = (build: number, kind: string, branch = "main"): Evidence => ({
  build,
  branch,
  commit: "deadbeef",
  kind,
  line: "Test timed out in 5000ms.",
});

const kase = (over: Partial<Case> & { kind: CaseKind; state: CaseState }): Case => ({
  evidence: [],
  cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const storeWith = (cases: Record<string, Case>, over: Partial<CiHealthStore> = {}): CiHealthStore => ({
  ...emptyStore(),
  cases,
  ...over,
});

/** The lines for the one failure every test here sends in. */
const linesFor = (store: CiHealthStore, context: KnownContext = LOGGD, title = TITLE): string[] =>
  knownNotes(store, [{ title, files: [FILE] }], context).byTestId[identify(title, [FILE]).testId] ?? [];

describe("knownNotes — a flake case", () => {
  const confirmed = (over: Partial<Case> = {}): CiHealthStore =>
    storeWith({
      [`flake:${TEST}`]: kase({
        kind: "flake",
        state: "confirmed",
        evidence: [evidence(2690, "assertion"), evidence(2701, "timeout")],
        cost72h: { redBuilds: 9, mainReds: 2, dequeues: 0 },
        ...over,
      }),
    });

  it("reproduces the line the ticket specifies, verbatim", () => {
    expect(linesFor(confirmed({ issue: 1901, pr: 1910 }))).toEqual([
      "loggd #1901 — confirmed flake (timeout, 9 reds/72h), fix PR #1910 open",
    ]);
  });

  it("stands alone with neither an issue nor a fix PR", () => {
    expect(linesFor(confirmed())).toEqual(["confirmed flake (timeout, 9 reds/72h)"]);
  });

  it("drops the slug but keeps the issue when the repo is unknown", () => {
    expect(linesFor(confirmed({ issue: 1901 }), { branch: null, repoSlug: null })).toEqual([
      "#1901 — confirmed flake (timeout, 9 reds/72h)",
    ]);
  });

  it("reports filed and fixing as confirmed, because they are", () => {
    for (const state of ["filed", "fixing"] as const) {
      expect(linesFor(confirmed({ state }))[0]).toContain("confirmed flake");
    }
  });

  it("marks a candidate as not confirmed yet", () => {
    expect(linesFor(confirmed({ state: "candidate", cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 } }))).toEqual([
      "flake candidate (timeout, 1 red/72h) — not confirmed yet",
    ]);
  });

  it("names the build a fixed flake was fixed after, and copes without one", () => {
    expect(linesFor(confirmed({ state: "fixed", fixedAt: { build: 2750, at: "2026-10-04T00:00:00Z" } }))).toEqual([
      "flake fixed after build 2750",
    ]);
    expect(linesFor(confirmed({ state: "fixed", fixedAt: null }))).toEqual(["flake fixed"]);
  });

  it("says when a flake was handed to the coders", () => {
    expect(linesFor(confirmed({ state: "handed-off" }))).toEqual([
      "flake handed to the coders (timeout, 9 reds/72h)",
    ]);
  });

  it("reports nothing for a retired case", () => {
    expect(linesFor(confirmed({ state: "retired" }))).toEqual([]);
  });

  it("omits the parenthetical when there is no evidence and no red count", () => {
    expect(linesFor(confirmed({ evidence: [], cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 } }))).toEqual([
      "confirmed flake",
    ]);
  });
});

describe("knownNotes — a regression case", () => {
  const regression = (over: Partial<Case> = {}, main: CiHealthStore["main"] = { state: "red", since: "", build: 2705 }) =>
    storeWith(
      {
        [`regression:${TEST}`]: kase({
          kind: "regression",
          state: "confirmed",
          evidence: [evidence(2711, "assertion"), evidence(2701, "assertion")],
          cost72h: { redBuilds: 4, mainReds: 4, dequeues: 0 },
          ...over,
        }),
      },
      { main },
    );

  it("prints the main-red line from the earliest build the test went red on", () => {
    expect(linesFor(regression())).toEqual(["main red since build 2701 on this test — not the diff"]);
  });

  it("puts it in the past tense once main is green again", () => {
    expect(linesFor(regression({}, { state: "green", since: "", build: 2730 }))).toEqual([
      "main was red on this test from build 2701 — not the diff",
    ]);
  });

  it("falls back to the store's own main-red boundary with no evidence", () => {
    expect(linesFor(regression({ evidence: [] }))).toEqual(["main red since build 2705 on this test — not the diff"]);
  });

  it("prints no build number rather than a zero when neither is known", () => {
    expect(linesFor(regression({ evidence: [] }, { state: "red", since: "", build: 0 }))).toEqual([
      "main red on this test — not the diff",
    ]);
  });

  it("carries the filed issue", () => {
    expect(linesFor(regression({ issue: 44 }))[0]).toBe(
      "loggd #44 — main red since build 2701 on this test — not the diff",
    );
  });
});

describe("knownNotes — a branch-only case", () => {
  const key = `pr-specific:ralph/1901-x:${TEST}`;
  const store = storeWith({
    [key]: kase({
      kind: "pr-specific",
      state: "confirmed",
      evidence: [evidence(2712, "assertion", "ralph/1901-x")],
      cost72h: { redBuilds: 3, mainReds: 0, dequeues: 0 },
    }),
  });

  it("matches only the build's own branch", () => {
    expect(linesFor(store)).toEqual(["red only on this branch (3 reds/72h) — likely the diff"]);
    expect(linesFor(store, { branch: "ralph/other", repoSlug: "loggd" })).toEqual([]);
    expect(linesFor(store, { branch: null, repoSlug: "loggd" })).toEqual([]);
  });
});

describe("knownNotes — a case the doctor has settled", () => {
  const settled = (key: string, over: Partial<Case> & { kind: CaseKind }): CiHealthStore =>
    storeWith(
      {
        [key]: kase({
          state: "fixed",
          evidence: [evidence(2701, "assertion")],
          cost72h: { redBuilds: 4, mainReds: 4, dequeues: 0 },
          ...over,
        }),
      },
      { main: { state: "red", since: "", build: 2740 } },
    );

  it("never says 'not the diff' off a fixed regression", () => {
    expect(linesFor(settled(`regression:${TEST}`, { kind: "regression" }))).toEqual([]);
  });

  it("never says 'likely the diff' off a fixed branch case", () => {
    expect(linesFor(settled(`pr-specific:ralph/1901-x:${TEST}`, { kind: "pr-specific" }))).toEqual([]);
  });

  it("keeps a fixed flake, because 'fixed after build N' is itself the news", () => {
    expect(
      linesFor(settled(`flake:${TEST}`, { kind: "flake", fixedAt: { build: 2750, at: "2026-10-04T00:00:00Z" } })),
    ).toEqual(["flake fixed after build 2750"]);
  });

  it("does not claim a landed fix PR is still open", () => {
    expect(
      linesFor(
        settled(`flake:${TEST}`, {
          kind: "flake",
          pr: 1910,
          fixedAt: { build: 2750, at: "2026-10-04T00:00:00Z" },
        }),
      ),
    ).toEqual(["flake fixed after build 2750, fixed by PR #1910"]);
  });
});

describe("knownNotes — a store the version gate let through malformed", () => {
  it("degrades one bad case to a quieter line instead of costing every other its verdict", () => {
    // `readStore` merges a version-1 document's `cases` through untouched, so
    // a hand-edited store reaches here with fields the type promises missing.
    const store = storeWith({
      [`flake:${TEST}`]: { kind: "flake", state: "confirmed" } as unknown as Case,
    });
    expect(linesFor(store)).toEqual(["confirmed flake"]);
  });
});

describe("knownNotes — a state the version gate let through absent", () => {
  it("says nothing rather than printing the word undefined", () => {
    // Round 1 of this ticket's review deleted `flakeClaim`'s `default` arm to
    // make the switch exhaustive, and this is the line that came out.
    const store = storeWith({
      [`flake:${TEST}`]: { kind: "flake", issue: 77 } as unknown as Case,
      "infra:boot": { kind: "infra" } as unknown as Case,
    });
    const notes = knownNotes(store, [{ title: TITLE, files: [FILE] }], LOGGD);
    expect(notes.byTestId).toEqual({});
    expect(notes.incidents).toEqual(["boot"]);
  });

  it("survives a store whose cases or main are explicitly null", () => {
    for (const over of [{ cases: null }, { main: null }] as unknown as Partial<CiHealthStore>[]) {
      const store = { ...emptyStore(), ...over } as CiHealthStore;
      expect(() => knownNotes(store, [{ title: TITLE, files: [FILE] }], LOGGD)).not.toThrow();
    }
  });
});

describe("knownNotes — two jobs sharing one jest title", () => {
  it("keys each verdict to the test it was recorded against, not to the title", () => {
    const title = "● Suite › case";
    const store = storeWith({
      "one.test.ts > Suite > case": kase({ kind: "flake", state: "confirmed", issue: 1 }),
      "two.test.ts > Suite > case": kase({ kind: "flake", state: "confirmed", issue: 2 }),
      [`flake:one.test.ts > Suite > case`]: kase({ kind: "flake", state: "confirmed", issue: 1 }),
      [`flake:two.test.ts > Suite > case`]: kase({ kind: "flake", state: "confirmed", issue: 2 }),
    });
    const notes = knownNotes(
      store,
      [
        { title, files: ["one.test.ts"] },
        { title, files: ["two.test.ts"] },
      ],
      LOGGD,
    );
    // Keyed by title, the second would have replaced the first and been
    // printed under both jobs — the wrong issue number on job one.
    expect(notes.byTestId["one.test.ts > Suite > case"]).toEqual(["loggd #1 — confirmed flake"]);
    expect(notes.byTestId["two.test.ts > Suite > case"]).toEqual(["loggd #2 — confirmed flake"]);
  });
});

describe("knownNotes — main of an unknown colour", () => {
  it("reports the evidence and claims no colour", () => {
    const store = storeWith(
      {
        [`regression:${TEST}`]: kase({
          kind: "regression",
          state: "confirmed",
          evidence: [evidence(2701, "assertion")],
        }),
      },
      { main: { state: "unknown", since: "", build: 0 } },
    );
    expect(linesFor(store)).toEqual(["main red on this test from build 2701 — not the diff"]);
  });
});

describe("knownNotes — several cases on one failure", () => {
  it("emits the flake line before the regression line", () => {
    const store = storeWith({
      [`regression:${TEST}`]: kase({ kind: "regression", state: "confirmed", evidence: [evidence(2701, "assertion")] }),
      [`flake:${TEST}`]: kase({ kind: "flake", state: "confirmed", evidence: [evidence(2704, "timeout")] }),
    });
    expect(linesFor(store, LOGGD).map((line) => line.split(" ")[0])).toEqual(["confirmed", "main"]);
  });
});

describe("knownNotes — title shapes", () => {
  it("resolves a jest-style title through identify's single-test-file branch", () => {
    const store = storeWith({
      [`flake:${FILE} > DiaryTab media mode > applies a TV-only genre`]: kase({
        kind: "flake",
        state: "confirmed",
        evidence: [evidence(2701, "timeout")],
        cost72h: { redBuilds: 2, mainReds: 0, dequeues: 0 },
      }),
    });
    const title = "● DiaryTab media mode › applies a TV-only genre";
    expect(linesFor(store, LOGGD, title)).toEqual(["confirmed flake (timeout, 2 reds/72h)"]);
  });

  it("knows nothing about a title no case matches", () => {
    expect(knownNotes(emptyStore(), [{ title: TITLE, files: [FILE] }], LOGGD)).toEqual({
      byTestId: {},
      incidents: [],
    });
  });
});

describe("knownNotes — infra incidents", () => {
  const infra = (over: Partial<Case> = {}): Case => kase({ kind: "infra", state: "confirmed", ...over });

  it("names the signature, the rule, the cost and the filed issue", () => {
    const notes = knownNotes(
      storeWith({
        "infra:bootstrap:agent-lost": infra({
          rule: "failed before the runner started",
          cost72h: { redBuilds: 4, mainReds: 1, dequeues: 0 },
          issue: 2001,
          pr: 2002,
        }),
      }),
      [],
      LOGGD,
    );
    expect(notes.incidents).toEqual([
      "bootstrap:agent-lost — failed before the runner started (4 red builds/72h), loggd #2001, fix PR #2002 open",
    ]);
  });

  it("drops the rule clause and the count when there is neither", () => {
    const notes = knownNotes(storeWith({ "infra:scheduled-wait": infra({ rule: null }) }), [], LOGGD);
    expect(notes.incidents).toEqual(["scheduled-wait"]);
  });

  it("lists INFRA_LIMIT of them and counts the rest", () => {
    const cases: Record<string, Case> = {};
    for (let n = 0; n < INFRA_LIMIT + 2; n += 1) cases[`infra:check:vercel:red ${n}`] = infra();
    const notes = knownNotes(storeWith(cases), [], LOGGD);
    expect(notes.incidents).toHaveLength(INFRA_LIMIT + 1);
    expect(notes.incidents.at(-1)).toBe("… 2 more infra incidents in the store");
  });

  it("says 'incident' in the singular when exactly one is held back", () => {
    const cases: Record<string, Case> = {};
    for (let n = 0; n < INFRA_LIMIT + 1; n += 1) cases[`infra:check:vercel:red ${n}`] = infra();
    expect(knownNotes(storeWith(cases), [], LOGGD).incidents.at(-1)).toBe("… 1 more infra incident in the store");
  });

  it("names a state that is not plain confirmed, so nobody reads filed as unattended", () => {
    const notes = knownNotes(storeWith({ "infra:bootstrap:hook": infra({ state: "fixing", issue: 9 }) }), [], LOGGD);
    expect(notes.incidents).toEqual(["bootstrap:hook, fixing, loggd #9"]);
  });

  it("does not list a fixed infra case as open", () => {
    const notes = knownNotes(
      storeWith({ "infra:bootstrap:hook": infra({ state: "fixed", issue: 9, pr: 10 }) }),
      [],
      LOGGD,
    );
    expect(notes.incidents).toEqual([]);
  });

  it("gives its lines to the costliest incidents, not to whichever the scan wrote first", () => {
    const notes = knownNotes(
      storeWith({
        "infra:zebra": infra({ cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 } }),
        "infra:apple": infra({ cost72h: { redBuilds: 40, mainReds: 0, dequeues: 0 } }),
        "infra:mango": infra({ cost72h: { redBuilds: 7, mainReds: 0, dequeues: 0 } }),
        "infra:kiwi": infra({ cost72h: { redBuilds: 2, mainReds: 0, dequeues: 0 } }),
      }),
      [],
      LOGGD,
    );
    expect(notes.incidents.map((line) => line.split(" ")[0])).toEqual(["apple", "mango", "kiwi", "…"]);
  });

  it("ranks by the weight the gate uses, so a main red outweighs a bigger raw count", () => {
    const notes = knownNotes(
      storeWith({
        "infra:raw": infra({ cost72h: { redBuilds: 4, mainReds: 0, dequeues: 0 } }),
        "infra:main": infra({ cost72h: { redBuilds: 2, mainReds: 2, dequeues: 0 } }),
      }),
      [],
      LOGGD,
    );
    expect(notes.incidents.map((line) => line.split(" ")[0])).toEqual(["main", "raw"]);
  });

  it("ranks the zero-cost families by their evidence, not by the scan's order", () => {
    // `classify.ts` hard-zeroes cost72h for scheduled-wait and every
    // infra:check case, so weight alone cannot separate them.
    const notes = knownNotes(
      storeWith({
        "infra:check:vercel:thin": infra({ evidence: [evidence(1, "bootstrap")] }),
        "infra:check:vercel:wide": infra({
          evidence: [evidence(1, "bootstrap"), evidence(2, "bootstrap"), evidence(3, "bootstrap")],
        }),
      }),
      [],
      LOGGD,
    );
    expect(notes.incidents.map((line) => line.split(" ")[0])).toEqual(["check:vercel:wide", "check:vercel:thin"]);
  });

  it("ignores a retired infra case and every case keyed by an issue", () => {
    const notes = knownNotes(
      storeWith({
        "infra:bootstrap:hook": infra({ state: "retired" }),
        "parked:1234": kase({ kind: "parked", state: "confirmed", issue: 1234 }),
      }),
      [],
      LOGGD,
    );
    expect(notes.incidents).toEqual([]);
  });
});
