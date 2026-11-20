import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestTicket } from "./backtest";
import { floorStatus, type NoiseFloor } from "./eval-noise-floor";
import type { EvalCaseView, EvalRunSummary } from "./eval-runs";
import { DEFAULT_SATURATION_RUNS } from "./eval-saturation";
import {
  addCase, addNewCases, attachCheck, calibrateCase, calibrationSuggestions, caseFromTicket, caseId, editCase, gradedOf, keepCase, lockWaitSeconds, normaliseTags, parseCase, parseEditRequest, readSet, retireCase, serializeCase, setView, withoutGraded, writeCase, writeCases, type CalibrationVerdict, type EvalCase, type OperatorCheck,
} from "./evals-set";
import type { GitRunner } from "./publish-journal";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("writes and reads eval cases on a scratch origin through git");

const env = fixtureGitEnv({
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
const git: GitRunner = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", env });
  return { status: result.status ?? 124, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const must = (args: string[]): string => {
  const result = git(args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A bare origin and a harness clone of it, as the journal publisher sees them. */
function harness() {
  const root = scratchDir("evals-set-");
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  must(["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  must(["clone", "--quiet", origin, home]);
  must(["-C", home, "checkout", "--quiet", "-b", "main"]);
  writeFileSync(join(home, "README.md"), "harness\n");
  must(["-C", home, "add", "."]);
  must(["-C", home, "commit", "--quiet", "-m", "init"]);
  must(["-C", home, "push", "--quiet", "origin", "main"]);
  return { root, origin, home, worktree: join(root, "journal-wt") };
}

const ticket = (pr: number, repo = "Org/App.Web"): BacktestTicket => ({
  oaKey: `#${pr}`, intakeKey: null, movedAt: "2026-10-28T00:00:00Z", repo,
  humanPrs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f1", headRefOid: "h1" }],
  mergeBase: "base1", startedAt: "2026-10-28T01:00:00Z", ticketRef: `#${pr - 1}`, comments: { kept: 1, dropped: 2 },
  frozen: { title: "Fix it", body: "It is broken", comments: [{ author: "ana", createdAt: "2026-10-27T00:00:00Z", body: "still broken" }] },
});
const curation = { heldOut: ["src/a.test.ts"], tags: ["ui"], reason: "a clean bugfix", notes: "the fix is in a.ts", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe" };
const CHECK: OperatorCheck = { command: "bun test secret-probe", base: "fail", reference: "pass", acceptedAt: "2026-11-19T00:00:00Z", acceptedBy: "felipe" };
const make = (pr: number, repo?: string): EvalCase => ({ ...caseFromTicket(ticket(pr, repo), curation), check: { ...CHECK } });
const VERDICT: CalibrationVerdict = { arms: ["opus", "codex"], axis: "correctness", preferred: "opus", reason: "codex missed the null case", by: "felipe", at: "2026-11-19T00:00:00Z" };
const SECOND: CalibrationVerdict = { arms: ["opus", "codex"], axis: "scope", preferred: "codex", reason: "opus rewrote the router", by: "ana", at: "2026-11-19T01:00:00Z" };
const originCommits = (origin: string) => Number(must(["-C", origin, "rev-list", "--count", "main"]));

describe("the case shape", () => {
  it("names a case for its repo and first PR", () => {
    expect(caseId("Org/App.Web", 12)).toBe("org-app-web-12");
    expect(make(12).id).toBe("org-app-web-12");
    // A dot or underscore beside a dash must still give a kebab id parseCase accepts.
    expect(caseId("org/.github", 5)).toBe("org-github-5");
    expect(caseId("org/repo_", 5)).toBe("org-repo-5");
  });

  it("round-trips through serializeCase and parseCase", () => {
    const built = make(12);
    expect(built).toMatchObject({ v: 1, kind: "coder", status: "active", reference: "person", baseCommit: "base1", ticket: { ref: "#11", dropped: 2 } });
    expect(parseCase(JSON.parse(serializeCase(built)))).toEqual(built);
  });

  it("serializes keys in a stable order whatever order they came in", () => {
    const built = make(12);
    const shuffled = Object.fromEntries(Object.entries(built).reverse());
    expect(serializeCase(shuffled as unknown as EvalCase)).toBe(serializeCase(built));
    expect(Object.keys(JSON.parse(serializeCase(built)))[0]).toBe("v");
  });

  it("round-trips keptAt, leaves it absent on a case never kept, and refuses a bad one (#860)", () => {
    const built = make(12);
    expect("keptAt" in parseCase(JSON.parse(serializeCase(built)))).toBe(false);
    const kept = { ...built, keptAt: "2026-11-19T12:00:00.000Z" };
    expect(parseCase(JSON.parse(serializeCase(kept)))).toEqual(kept);
    // Placed by CASE_KEYS order, after status, whatever the input order.
    const keys = Object.keys(JSON.parse(serializeCase(kept)));
    expect(keys.indexOf("keptAt")).toBe(keys.indexOf("status") + 1);
    for (const keptAt of ["", "  ", 3, null]) {
      expect(() => parseCase({ ...built, keptAt }, "evals/p/x.json")).toThrow("evals case: evals/p/x.json: keptAt must be a non-empty string");
    }
  });

  it("refuses unknown keys by their dotted path, and a bad status", () => {
    const built = make(12);
    expect(() => parseCase({ ...built, mood: 1 })).toThrow("evals case: unknown key mood");
    const nested = JSON.parse(serializeCase(built));
    nested.ticket.comments[0].extra = true;
    expect(() => parseCase(nested)).toThrow("unknown key ticket.comments.0.extra");
    const pr = JSON.parse(serializeCase(built));
    pr.prs[0].diff = "...";
    expect(() => parseCase(pr, "evals/p/x.json")).toThrow("evals case: evals/p/x.json: unknown key prs.0.diff");
    expect(() => parseCase({ ...built, status: "paused" })).toThrow("status must be active, saturated or retired");
    expect(() => parseCase({ ...built, reason: "" })).toThrow("reason must be a non-empty string");
    const { baseCommit: _, ...missing } = built;
    expect(() => parseCase(missing)).toThrow("baseCommit must be a non-empty string");
    expect(() => parseCase({ ...built, heldOut: ["a", 2] })).toThrow("heldOut.1 must be a string");
  });

  it("withoutGraded drops heldOut, notes, check and calibration and nothing else", () => {
    const built = { ...make(12), calibration: [VERDICT] };
    const improver = withoutGraded(built);
    expect(Object.keys(improver).sort()).toEqual(Object.keys(built).filter((key) => !["heldOut", "notes", "check", "calibration"].includes(key)).sort());
    expect(JSON.stringify(improver)).not.toContain("codex missed the null case");
    expect(gradedOf(built)).toEqual({ heldOut: ["src/a.test.ts"], notes: "the fix is in a.ts", check: CHECK, calibration: [VERDICT] });
    expect(gradedOf(make(12))).not.toHaveProperty("calibration");
    expect(built.heldOut).toEqual(["src/a.test.ts"]);
  });

  it("accepts an operator check in its test and command forms", () => {
    const built = make(12);
    expect(parseCase(JSON.parse(serializeCase(built))).check).toEqual(CHECK);
    const { command: _, ...rest } = CHECK as OperatorCheck & { command: string };
    const test = { ...rest, test: "src/a.check.test.ts" };
    expect(parseCase({ ...built, check: test }).check).toEqual(test);
  });

  it("refuses a check that is free text, ambiguous, unverified or outside the repo", () => {
    const built = make(12);
    const { command: _, ...rest } = CHECK as OperatorCheck & { command: string };
    expect(() => parseCase({ ...built, check: "bun test" })).toThrow("check must be an object");
    expect(() => parseCase({ ...built, check: { ...CHECK, test: "a.test.ts" } })).toThrow("check must be exactly one of test or command");
    expect(() => parseCase({ ...built, check: rest })).toThrow("check must be exactly one of test or command");
    expect(() => parseCase({ ...built, check: { ...CHECK, mood: 1 } })).toThrow("unknown key check.mood");
    expect(() => parseCase({ ...built, check: { ...CHECK, base: "pass" } })).toThrow("check.base must be fail");
    expect(() => parseCase({ ...built, check: { ...CHECK, reference: "error" } })).toThrow("check.reference must be pass");
    expect(() => parseCase({ ...built, check: { ...CHECK, command: " " } })).toThrow("check.command must be a non-empty string");
    expect(() => parseCase({ ...built, check: { ...CHECK, acceptedBy: "" } })).toThrow("check.acceptedBy must be a non-empty string");
    expect(() => parseCase({ ...built, check: { ...rest, test: "/etc/a.test.ts" } })).toThrow("check.test must be a relative path with no .. segment");
    expect(() => parseCase({ ...built, check: { ...rest, test: "src/../../a.test.ts" } })).toThrow("check.test must be a relative path with no .. segment");
  });
});

describe("calibration verdicts (#876)", () => {
  it("round-trips a case with two verdicts, and reads an empty list as absent", () => {
    const built = { ...make(12), calibration: [VERDICT, SECOND] };
    const text = serializeCase(built);
    expect(parseCase(JSON.parse(text))).toEqual(built);
    expect(serializeCase(parseCase(JSON.parse(text)))).toBe(text);
    // calibration sits right after check in the stable key order.
    const keys = Object.keys(JSON.parse(text));
    expect(keys[keys.indexOf("check") + 1]).toBe("calibration");
    expect(parseCase({ ...make(12), calibration: [] })).not.toHaveProperty("calibration");
    expect(serializeCase({ ...make(12), calibration: [] })).toBe(serializeCase(make(12)));
  });

  it("refuses a malformed verdict naming its dotted path", () => {
    const built = make(12);
    const { reason: _, ...noReason } = VERDICT;
    expect(() => parseCase({ ...built, calibration: VERDICT })).toThrow("calibration must be a list of verdicts");
    expect(() => parseCase({ ...built, calibration: [{ ...VERDICT, mood: 1 }] })).toThrow("unknown key calibration[0].mood");
    expect(() => parseCase({ ...built, calibration: [VERDICT, { ...VERDICT, axis: "speed" }] })).toThrow("calibration[1].axis must be one of correctness, scope, tests, maintainability, review");
    expect(() => parseCase({ ...built, calibration: [{ ...VERDICT, preferred: "sonnet" }] })).toThrow("calibration[0].preferred must be one of the arms");
    expect(() => parseCase({ ...built, calibration: [{ ...VERDICT, arms: ["opus"] }] })).toThrow("calibration[0].arms must be two distinct non-empty arm names");
    expect(() => parseCase({ ...built, calibration: [{ ...VERDICT, arms: ["opus", "opus"] }] })).toThrow("calibration[0].arms must be two distinct non-empty arm names");
    expect(() => parseCase({ ...built, calibration: [{ ...VERDICT, reason: " " }] })).toThrow("calibration[0].reason must be a non-empty string");
    expect(() => parseCase({ ...built, calibration: [noReason] })).toThrow("calibration[0].reason must be a non-empty string");
    expect(() => parseCase({ ...built, calibration: ["opus"] })).toThrow("calibration[0] must be an object");
  });

  it("calibrateCase appends every verdict, even one by the same name on the same axis and pair, and refuses an unknown id", () => {
    const first = calibrateCase([make(12)], "org-app-web-12", VERDICT);
    expect(first.calibration).toEqual([VERDICT]);
    const second = calibrateCase([first], "org-app-web-12", SECOND);
    expect(second.calibration).toEqual([VERDICT, SECOND]);
    // The dashboard records every operator as "dashboard": an opposite verdict
    // on the same axis and pair is another person's, and must not replace the first.
    const opposite: CalibrationVerdict = { ...VERDICT, arms: ["codex", "opus"], preferred: "codex", reason: "opus broke the router", at: "2026-11-20T00:00:00Z" };
    expect(calibrateCase([second], "org-app-web-12", opposite).calibration).toEqual([VERDICT, SECOND, opposite]);
    // A retired case may still be calibrated.
    expect(calibrateCase([{ ...make(12), status: "retired" }], "org-app-web-12", VERDICT).calibration).toEqual([VERDICT]);
    expect(() => calibrateCase([make(12)], "nope", VERDICT)).toThrow("no case nope in the set");
  });

  const contestedCase = (key: string, contested: EvalCaseView["contested"], contestedRule: string | null = "inversion"): EvalCaseView =>
    ({ key, contested, contestedRule, repo: "Org/App.Web", prs: [Number(key.split("-").pop())], arms: [] }) as unknown as EvalCaseView;
  const setRun = (id: string, startedAt: string, cases: EvalCaseView[], kind = "set") => ({ id, startedAt, running: false, source: { kind }, cases }) as unknown as EvalRunSummary;
  const CONTESTED = [{ axis: "correctness" as const, arms: ["opus", "codex"] }];

  it("suggests the cases the newest set run holding them contested, uncalibrated first", () => {
    const calibrated = { ...make(30), calibration: [VERDICT] };
    const quiet = make(40);
    const retired = { ...make(50), status: "retired" as const };
    const offSet = make(60);
    const settled = make(70);
    const runs = [
      setRun("r1", "2026-11-01T00:00:00Z", [contestedCase("org-app-web-12", CONTESTED), contestedCase("org-app-web-70", CONTESTED)]),
      setRun("r2", "2026-11-05T00:00:00Z", [contestedCase("org-app-web-30", CONTESTED), contestedCase("org-app-web-40", []), contestedCase("org-app-web-50", CONTESTED), contestedCase("org-app-web-70", [])]),
      setRun("pr-run", "2026-11-09T00:00:00Z", [contestedCase("org-app-web-60", CONTESTED)], "pr"),
    ];
    const suggested = calibrationSuggestions([make(12), calibrated, quiet, retired, offSet, settled], runs);
    expect(suggested).toEqual([
      { id: "org-app-web-12", title: "Fix it", contested: CONTESTED, run: "r1", calibrations: 0 },
      { id: "org-app-web-30", title: "Fix it", contested: CONTESTED, run: "r2", calibrations: 1 },
    ]);
    // Within a group, the newest run first, then id.
    const tie = calibrationSuggestions([make(13), make(12), make(14)], [
      setRun("old", "2026-11-01T00:00:00Z", [contestedCase("org-app-web-14", CONTESTED)]),
      setRun("new", "2026-11-02T00:00:00Z", [contestedCase("org-app-web-13", CONTESTED), contestedCase("org-app-web-12", CONTESTED)]),
    ]);
    expect(tie.map((s) => s.id)).toEqual(["org-app-web-12", "org-app-web-13", "org-app-web-14"]);
  });

  it("looks past a newer set run that holds the case unjudged: it says nothing either way", () => {
    const suggested = calibrationSuggestions([make(12)], [
      setRun("judged", "2026-11-01T00:00:00Z", [contestedCase("org-app-web-12", CONTESTED)]),
      // Stopped, its judges unavailable, or mid-way through its repeats: no panel for the case.
      setRun("unjudged", "2026-11-05T00:00:00Z", [contestedCase("org-app-web-12", [], null)]),
    ]);
    expect(suggested.map((s) => [s.id, s.run])).toEqual([["org-app-web-12", "judged"]]);
  });

  it("setView counts verdicts on every row, and relays them only with details on", () => {
    const NO_FLOOR = floorStatus(null, [], 0.2);
    const cases = [{ ...make(12), calibration: [VERDICT, SECOND] }, make(30)];
    const runs = [setRun("r1", "2026-11-01T00:00:00Z", [contestedCase("org-app-web-12", CONTESTED)])];
    const off = setView({ version: "v1", cases }, runs, false, NO_FLOOR, DEFAULT_SATURATION_RUNS);
    expect(off.cases.map((c) => c.calibrations)).toEqual([2, 0]);
    for (const row of off.cases) expect(row).not.toHaveProperty("calibration");
    const text = JSON.stringify(off);
    for (const leak of ['"calibration":', "codex missed the null case", "opus rewrote the router"]) expect(text).not.toContain(leak);
    expect(off.calibrationSuggestions).toEqual([{ id: "org-app-web-12", title: "Fix it", contested: CONTESTED, run: "r1", calibrations: 2 }]);
    const on = setView({ version: "v1", cases }, runs, true, NO_FLOOR, DEFAULT_SATURATION_RUNS);
    expect(on.cases[0]!.calibration).toEqual([VERDICT, SECOND]);
    expect(on.cases[1]).not.toHaveProperty("calibration");
    expect(on.calibrationSuggestions).toEqual(off.calibrationSuggestions);
  });
});

describe("the change helpers", () => {
  it("addCase refuses a duplicate id and a PR another case holds", () => {
    const held = make(12);
    expect(() => addCase([held], make(12))).toThrow("a case org-app-web-12 is already in the set");
    const sharing = { ...make(20), prs: [...make(20).prs, ...held.prs] };
    expect(() => addCase([held], sharing)).toThrow("Org/App.Web#12 is already in case org-app-web-12");
    expect(addCase([held], make(12, "org/other")).id).toBe("org-other-12");
    // GitHub repo names are case-insensitive: the same PR typed in another case is still the same PR.
    const recased = { ...make(40, "org/app.web"), prs: [...make(40, "org/app.web").prs, ...held.prs] };
    expect(() => addCase([held], recased)).toThrow("is already in case org-app-web-12");
  });

  it("addNewCases drops ids and PRs already held, and duplicates within the batch, first wins", () => {
    const held = make(12);
    const sharing = { ...make(20), prs: [...make(20).prs, ...held.prs] };
    const recased = { ...make(40, "org/app.web"), prs: [...make(40, "org/app.web").prs, ...held.prs] };
    const twin = { ...make(51), prs: [...make(51).prs, ...make(50).prs] };
    const kept = addNewCases([held], [make(12), sharing, recased, make(12, "org/other"), make(50), twin, make(50)]);
    expect(kept.map((c) => c.id)).toEqual(["org-other-12", "org-app-web-50"]);
    expect(addNewCases([held], [])).toEqual([]);
  });

  it("retireCase refuses an unknown id", () => {
    expect(() => retireCase([make(12)], "nope")).toThrow("no case nope in the set");
    expect(retireCase([make(12)], "org-app-web-12").status).toBe("retired");
  });

  it("keepCase keeps a case active with keptAt, and refuses an unknown id or a retired case (#860)", () => {
    const held = make(12);
    expect(keepCase([held], "org-app-web-12", "2026-11-19T12:00:00.000Z")).toEqual({ ...held, status: "active", keptAt: "2026-11-19T12:00:00.000Z" });
    expect(keepCase([{ ...held, status: "saturated" }], "org-app-web-12", "2026-11-19T12:00:00.000Z").status).toBe("active");
    expect(() => keepCase([held], "nope", "2026-11-19T12:00:00.000Z")).toThrow("no case nope in the set");
    expect(() => keepCase([{ ...held, status: "retired" }], "org-app-web-12", "2026-11-19T12:00:00.000Z")).toThrow("org-app-web-12 is retired");
  });

  it("editCase replaces tags, notes or both, and nothing else", () => {
    const held = make(12);
    expect(editCase([held], "org-app-web-12", { tags: ["api", "db"] })).toEqual({ ...held, tags: ["api", "db"] });
    expect(editCase([held], "org-app-web-12", { notes: "" })).toEqual({ ...held, notes: "" });
    expect(editCase([held], "org-app-web-12", { tags: [], notes: "n" })).toEqual({ ...held, tags: [], notes: "n" });
    expect(() => editCase([held], "nope", { notes: "x" })).toThrow("no case nope in the set");
  });

  it("attachCheck sets a check, replaces one, and refuses an unknown id", () => {
    const bare = { ...make(12) };
    delete (bare as Partial<EvalCase>).check;
    expect(attachCheck([bare], "org-app-web-12", CHECK)).toEqual({ ...bare, check: CHECK });
    const replacement: OperatorCheck = { test: "src/b.test.ts", base: "fail", reference: "pass", acceptedAt: "2026-11-20T00:00:00Z", acceptedBy: "ana" };
    expect(attachCheck([make(12)], "org-app-web-12", replacement).check).toEqual(replacement);
    expect(() => attachCheck([bare], "nope", CHECK)).toThrow("no case nope in the set");
  });

  it("normaliseTags trims, drops blanks and duplicates, keeps order", () => {
    expect(normaliseTags([" ui", "db", "", "ui ", "  ", "api"])).toEqual(["ui", "db", "api"]);
  });

  it("parseEditRequest refuses unknown keys and an empty edit", () => {
    expect(parseEditRequest({ id: "a-1", tags: ["x"] }, "f")).toEqual({ id: "a-1", edit: { tags: ["x"] } });
    expect(parseEditRequest({ id: "a-1", notes: "" }, "f")).toEqual({ id: "a-1", edit: { notes: "" } });
    expect(() => parseEditRequest({ id: "a-1", reason: "x" }, "f")).toThrow("unknown key reason");
    expect(() => parseEditRequest({ id: "a-1" }, "f")).toThrow("an edit needs tags or notes");
    expect(() => parseEditRequest({ id: "a-1", tags: [1] }, "f")).toThrow("tags must be a list of strings");
  });
});

describe("the set view", () => {
  const run = (id: string, startedAt: string, cases: { repo: string; prs: number[] }[]) => ({ id, startedAt, cases, running: false, source: { kind: "set" } }) as unknown as EvalRunSummary;
  // Keys are matched quoted with their colon: the grader label "check" is allowed, a `check` field is not.
  const NO_FLOOR = floorStatus(null, [], 0.2);
  const LEAKS = ['"heldOut":', '"check":', '"reference":', '"body":', '"comments":', '"baseCommit":', '"ticket":', "src/a.test.ts", "secret-probe", "acceptedBy", "It is broken", "still broken", "base1"];

  it("derives graders, leaves out reason and notes when details is off, and never carries the grading or the ticket", () => {
    const bare = { ...make(30), heldOut: [], check: undefined };
    delete (bare as Partial<EvalCase>).check;
    const view = setView({ version: "v1", cases: [make(12), bare] }, [], false, NO_FLOOR, DEFAULT_SATURATION_RUNS);
    expect(view).toEqual({
      version: "v1", details: false, noiseFloor: NO_FLOOR,
      cases: [
        { id: "org-app-web-12", repo: "Org/App.Web", prs: [12], title: "Fix it", tags: ["ui"], graders: ["held-out tests", "check", "gates"], status: "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe", lastRun: null, saturation: { saturated: false, passes: 0, window: 3 }, calibrations: 0 },
        { id: "org-app-web-30", repo: "Org/App.Web", prs: [30], title: "Fix it", tags: ["ui"], graders: ["gates"], status: "active", addedAt: "2026-11-18T00:00:00Z", addedBy: "felipe", lastRun: null, saturation: { saturated: false, passes: 0, window: 3 }, calibrations: 0 },
      ],
      calibrationSuggestions: [],
    });
    const text = JSON.stringify(view);
    for (const leak of [...LEAKS, '"reason":', '"notes":', "a clean bugfix", "the fix is in a.ts"]) expect(text).not.toContain(leak);
  });

  it("carries reason and notes only when details is on, still without the grading", () => {
    const view = setView({ version: "v1", cases: [make(12)] }, [], true, NO_FLOOR, DEFAULT_SATURATION_RUNS);
    expect(view.cases[0]).toMatchObject({ reason: "a clean bugfix", notes: "the fix is in a.ts" });
    const text = JSON.stringify(view);
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });

  it("names the newest run holding the same repo and PR set", () => {
    const runs = [
      run("old", "2026-11-01T00:00:00Z", [{ repo: "org/app.web", prs: [12] }]),
      run("new", "2026-11-10T00:00:00Z", [{ repo: "ORG/APP.WEB", prs: [12] }]),
      run("newest-other", "2026-11-12T00:00:00Z", [{ repo: "Org/App.Web", prs: [12, 13] }, { repo: "org/other", prs: [12] }]),
    ];
    const view = setView({ version: "v1", cases: [make(12), make(30)] }, runs, false, NO_FLOOR, DEFAULT_SATURATION_RUNS);
    expect(view.cases.map((c) => c.lastRun)).toEqual([{ run: "new", startedAt: "2026-11-10T00:00:00Z" }, null]);
  });

  it("flags a case every arm passed in its last N set runs, never a retired one, and counts only runs after keptAt (#860)", () => {
    const graded = (key: string, objective: "pass" | "fail"): EvalCaseView => ({
      key, title: key, repo: "Org/App.Web", prs: [], reference: "person", ranking: null, judges: [], contested: [], contestedRule: null,
      grade: { grader: "tests", noEvidence: false },
      arms: ["a", "b"].map((arm) => ({
        arm, outcome: null, gates: null, heldOut: null, findings: null, rounds: null, wallSeconds: null, tokens: null, costUsd: null, axes: [], judge: null,
        objective: arm === "a" ? null : objective,
      })),
    }) as EvalCaseView;
    const setRun = (id: string, day: number, objective: "pass" | "fail") =>
      ({ id, startedAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`, running: false, source: { kind: "set" }, cases: [graded("org-app-web-12", objective), graded("org-app-web-30", objective)] }) as unknown as EvalRunSummary;
    const runs = [setRun("r1", 1, "fail"), setRun("r2", 2, "pass"), setRun("r3", 3, "pass"), setRun("r4", 4, "pass")];
    const retired = { ...make(30), status: "retired" as const };
    const view = setView({ version: "v1", cases: [make(12), retired] }, runs, false, NO_FLOOR, 3);
    expect(view.cases.map((c) => c.saturation)).toEqual([{ saturated: true, passes: 3, window: 3 }, null]);
    // A wider window reaches the failed run: not saturated.
    expect(setView({ version: "v1", cases: [make(12)] }, runs, false, NO_FLOOR, 4).cases[0]!.saturation).toEqual({ saturated: false, passes: 3, window: 4 });
    // Kept on day 2: only days 3 and 4 count, so the case is no longer saturated, and keptAt is not relayed.
    const kept = { ...make(12), keptAt: "2026-11-02T12:00:00.000Z" };
    const keptView = setView({ version: "v1", cases: [kept] }, runs, false, NO_FLOOR, 3);
    expect(keptView.cases[0]!.saturation).toEqual({ saturated: false, passes: 2, window: 3 });
    expect(JSON.stringify(keptView)).not.toContain("keptAt");
  });

  it("carries the noise floor status it is given, beside the cases (#859)", () => {
    const floor: NoiseFloor = {
      v: 1, version: "v0", measuredAt: "2026-11-19T10:00:00Z", runId: "eval-floor", arms: ["live-1", "live-2"],
      cases: ["org-app-web-12"], spread: { objective: 0.25, judge: 0.5 }, perCase: [],
    };
    const cases = [make(12)];
    const view = setView({ version: "v1", cases }, [], false, floorStatus(floor, cases, 0.2), DEFAULT_SATURATION_RUNS);
    expect(view.noiseFloor).toMatchObject({ state: "fresh", floor: { runId: "eval-floor", spread: { objective: 0.25, judge: 0.5 } }, staleShare: 0.2 });
    expect(setView({ version: "v1", cases }, [], false, NO_FLOOR, DEFAULT_SATURATION_RUNS).noiseFloor).toEqual({ state: "missing", floor: null, drift: null, staleShare: 0.2 });
  });
});

describe("the store", () => {
  it("reads an absent project as an empty, unversioned set", () => {
    const h = harness();
    expect(readSet("proj", h.home, git)).toEqual({ version: null, cases: [] });
  });

  it("writes one commit per case, reads it back at that version, and retires without removing the file", () => {
    const h = harness();
    const options = { projectId: "proj", home: h.home, worktree: h.worktree, git };
    const before = originCommits(h.origin);
    const written = writeCase({ ...options, message: "evals: add org-app-web-12", change: (current) => addCase(current, make(12)) });
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(written.sha);
    expect(readSet("proj", h.home, git)).toEqual({ version: written.sha, cases: [make(12)] });

    expect(() => writeCase({ ...options, message: "dup", change: (current) => addCase(current, make(12)) })).toThrow("already in the set");
    expect(originCommits(h.origin)).toBe(before + 1);

    const retired = writeCase({ ...options, message: "evals: retire org-app-web-12", change: (current) => retireCase(current, "org-app-web-12") });
    expect(originCommits(h.origin)).toBe(before + 2);
    const read = readSet("proj", h.home, git);
    expect(read.version).toBe(retired.sha);
    expect(read.cases.map((c) => [c.id, c.status])).toEqual([["org-app-web-12", "retired"]]);
    expect(must(["-C", h.origin, "ls-tree", "-r", "--name-only", "main", "--", "evals"])).toBe("evals/proj/org-app-web-12.json");
  });

  it("writes a calibration verdict as one commit and reads it back (#876)", () => {
    const h = harness();
    const options = { projectId: "proj", home: h.home, worktree: h.worktree, git };
    writeCase({ ...options, message: "evals: add org-app-web-12", change: (current) => addCase(current, make(12)) });
    const before = originCommits(h.origin);
    const written = writeCase({ ...options, message: "chore(evals): calibrate org-app-web-12 in proj", change: (current) => calibrateCase(current, "org-app-web-12", VERDICT) });
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(written.sha);
    expect(readSet("proj", h.home, git)).toEqual({ version: written.sha, cases: [{ ...make(12), calibration: [VERDICT] }] });
  });

  it("writes many cases as one commit, and an empty change commits nothing", () => {
    const h = harness();
    const options = { projectId: "proj", home: h.home, worktree: h.worktree, git };
    const before = originCommits(h.origin);
    const written = writeCases({ ...options, message: "evals: import", change: (current) => addNewCases(current, [make(12), make(30), make(40)]) });
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(written.sha);
    expect(written.cases.map((c) => c.id)).toEqual(["org-app-web-12", "org-app-web-30", "org-app-web-40"]);
    expect(readSet("proj", h.home, git)).toEqual({ version: written.sha, cases: [make(12), make(30), make(40)] });

    const named = writeCases({ ...options, message: (landed) => `evals: import ${landed.length}`, change: (current) => addNewCases(current, [make(12), make(50)]) });
    expect(named.cases.map((c) => c.id)).toEqual(["org-app-web-50"]);
    expect(must(["-C", h.origin, "log", "-1", "--format=%s", "main"])).toBe("evals: import 1");
    const before2 = originCommits(h.origin);
    const again = writeCases({ ...options, message: "evals: import again", change: (current) => addNewCases(current, [make(12), make(30)]) });
    expect(again).toEqual({ sha: null, cases: [] });
    expect(originCommits(h.origin)).toBe(before2);
  });

  it("throws naming the file when a case on main is malformed", () => {
    const h = harness();
    const bad = { ...JSON.parse(serializeCase(make(12))), extra: 1 };
    must(["-C", h.home, "checkout", "--quiet", "-b", "scratch"]);
    const dir = join(h.home, "evals", "proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "org-app-web-12.json"), JSON.stringify(bad));
    must(["-C", h.home, "add", "."]);
    must(["-C", h.home, "commit", "--quiet", "-m", "bad"]);
    must(["-C", h.home, "push", "--quiet", "origin", "HEAD:main"]);
    expect(() => readSet("proj", h.home, git)).toThrow("evals/proj/org-app-web-12.json: unknown key extra");
  });

  it("lands two concurrent writers, the loser re-deciding on the winner's tip", () => {
    const h = harness();
    const second = join(h.root, "second-wt");
    let raced = false;
    let seen: string[] = [];
    writeCase({
      projectId: "proj", home: h.home, worktree: h.worktree, git, message: "evals: add 12",
      change: (current) => { seen = current.map((c) => c.id); return addCase(current, make(12)); },
      beforePush: () => {
        if (raced) return;
        raced = true;
        writeCase({ projectId: "proj", home: h.home, worktree: second, git, message: "evals: add 30", change: (current) => addCase(current, make(30)) });
      },
    });
    expect(seen).toEqual(["org-app-web-30"]);
    expect(readSet("proj", h.home, git).cases.map((c) => c.id)).toEqual(["org-app-web-12", "org-app-web-30"]);
  });

  it("throws when the set cannot be fetched, rather than reading it as empty", () => {
    const h = harness();
    must(["-C", h.home, "remote", "set-url", "origin", join(h.root, "gone.git")]);
    expect(() => readSet("proj", h.home, git)).toThrow(/cannot read the eval set/);
  });
});

describe("lockWaitSeconds", () => {
  it("waits 300 s from a shell and what the dashboard asks for under RALPH_EVALS_SET_LOCK_WAIT", () => {
    expect(lockWaitSeconds({})).toBe(300);
    expect(lockWaitSeconds({ RALPH_EVALS_SET_LOCK_WAIT: "120" })).toBe(120);
    expect(lockWaitSeconds({ RALPH_EVALS_SET_LOCK_WAIT: "soon" })).toBe(300);
    expect(lockWaitSeconds({ RALPH_EVALS_SET_LOCK_WAIT: "0" })).toBe(300);
  });
});
