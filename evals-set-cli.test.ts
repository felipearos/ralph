import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BacktestConfig, BacktestSample, BacktestTicket, BacktestTickets, CheckSpec, PrSource } from "./backtest";
import { readRecorded, type LedgerEntry } from "./backtest-ledger";
import type { CheckOutcome } from "./backtest-score";
import { writeProjectConfig } from "./dashboard/fixtures";
import type { NoiseFloor } from "./eval-noise-floor";
import { experimentsRoot } from "./eval-runs";
import type { MergedPr, SuggestSignals } from "./evals-suggest";
import {
  attachCheck, calibrateCase, caseFromTicket, readSet, runEvalsSet, serializeCase, writeCase, writeCases, addCase, addNewCases, editCase, keepCase, retireCase, type EvalCase, type EvalsSetDeps, type WriteRequest,
} from "./evals-set";
import type { GitRunner } from "./publish-journal";
import { fixtureGitEnv } from "./test-git-env";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the evals-set CLI over git and spawns it under flock with bun");

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
  const root = scratchDir("evals-set-cli-");
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

const REPO = "Org/App";
const ticket = (pr: number): BacktestTicket => ({
  kind: "coder", oaKey: `GH-${pr - 1}`, intakeKey: null, movedAt: "2026-10-28T01:00:00Z", repo: REPO,
  humanPrs: [{ number: pr, url: `https://example.invalid/${pr}`, createdAt: "2026-10-28T01:00:00Z", mergedAt: "2026-10-28T02:00:00Z", headRefName: "fix", firstCommit: "f1", headRefOid: "h1" }],
  mergeBase: "base1", startedAt: "2026-10-28T01:00:00Z", ticketRef: `#${pr - 1}`, comments: { kept: 0, dropped: 0 },
  frozen: { title: "Fix it", body: "It is broken", comments: [] }, reference: "person",
});
const originCommits = (origin: string) => Number(must(["-C", origin, "rev-list", "--count", "main"]));

/** A ledger line with only what the import reads filled in; the rest of the shape is the backtest's business. */
const entry = (ticketKey: string, prs: number[], intakeKey: string | null = null): LedgerEntry => ({
  v: 1, run: "run-1", recordedAt: "2026-10-30T00:00:00Z", ticket: ticketKey, intakeKey, repo: REPO, title: "Fix it",
  prs: prs.map((number) => ({ number, url: `https://example.invalid/${number}` })),
  human: { openToMergeSeconds: null, rounds: null, gates: "", review: null }, agents: [], judge: null,
} as unknown as LedgerEntry);

/** Commit a ledger to the scratch origin, where `readRecorded` reads it. */
function commitLedger(home: string, entries: LedgerEntry[]): void {
  mkdirSync(join(home, "backtests", "proj"), { recursive: true });
  writeFileSync(join(home, "backtests", "proj", "ledger.jsonl"), entries.map((line) => `${JSON.stringify(line)}\n`).join(""));
  must(["-C", home, "add", "."]);
  must(["-C", home, "commit", "--quiet", "-m", "ledger"]);
  must(["-C", home, "push", "--quiet", "origin", "main"]);
}

/** Fake gh and a fake ticket source: the sample, the changed files and the ledger's tickets; real git for the store. */
type Verified = { base: CheckOutcome; reference: CheckOutcome; notes: string[] };
function setup(options: {
  files?: string[]; sample?: (config: BacktestConfig) => Promise<BacktestSample>; ledgerTickets?: () => Promise<BacktestTickets>; verified?: Verified; signals?: Partial<SuggestSignals>;
  noiseFloors?: () => { floors: NoiseFloor[]; staleShare: number }; saturationRuns?: () => number;
} = {}) {
  const h = harness();
  const verifications: { id: string; spec: CheckSpec; options: { projectPath: string; source?: string; timeoutMs?: number } }[] = [];
  const writes: WriteRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sampled: BacktestConfig[] = [];
  const reads: [string, string | null][] = [];
  let opened = 0;
  const fakeSample = async (config: BacktestConfig) => {
    sampled.push(config);
    if (options.sample) return options.sample(config);
    const pr = (config.source as PrSource).prs[0]!;
    return { tickets: [ticket(pr)], skipped: [], notes: [], arms: [] } as unknown as BacktestSample;
  };
  const deps: EvalsSetDeps = {
    home: h.home, git, projectId: () => "proj",
    sample: fakeSample,
    ledgerTickets: async () => {
      opened += 1;
      if (options.ledgerTickets) return options.ledgerTickets();
      return {
        read: async (oaKey, intakeKey) => {
          reads.push([oaKey, intakeKey]);
          return { ok: true, ref: oaKey, title: "Fix it", body: "It is broken", comments: [] };
        },
      };
    },
    // As buildPrSample: a `#<n>` ticket is GitHub's, any other ref goes to `read`.
    ledgerSample: async (config, read) => {
      const ref = (config.source as PrSource).ticket;
      if (ref !== null && !/^#\d+$/.test(ref)) {
        const fetched = await read(ref);
        if (!fetched.ok) throw new Error(`eval: cannot read ticket ${ref}: ${fetched.reason}`);
      }
      return fakeSample(config);
    },
    changedFiles: async () => options.files ?? [],
    verifyCheck: async (c: EvalCase, spec, verifyOptions) => {
      verifications.push({ id: c.id, spec, options: verifyOptions });
      return options.verified ?? { base: { result: "fail" }, reference: { result: "pass" }, notes: [] };
    },
    write: (request: WriteRequest) => {
      writes.push(request);
      const base = { projectId: request.projectId, home: h.home, worktree: h.worktree, git };
      if (request.kind === "add") return writeCase({ ...base, message: `add ${request.case.id}`, change: (current) => addCase(current, request.case) });
      if (request.kind === "import") return writeCases({ ...base, message: `import ${request.cases.length}`, change: (current) => addNewCases(current, request.cases) });
      if (request.kind === "edit") return writeCase({ ...base, message: `edit ${request.id}`, change: (current) => editCase(current, request.id, request.edit) });
      if (request.kind === "check") return writeCase({ ...base, message: `check ${request.id}`, change: (current) => attachCheck(current, request.id, request.check) });
      if (request.kind === "calibrate") return writeCase({ ...base, message: `calibrate ${request.id}`, change: (current) => calibrateCase(current, request.id, request.verdict) });
      if (request.kind === "keep") return writeCase({ ...base, message: `keep ${request.id}`, change: (current) => keepCase(current, request.id, "2026-11-19T00:00:00.000Z") });
      return writeCase({ ...base, message: `retire ${request.id}`, change: (current) => retireCase(current, request.id) });
    },
    ledger: (id) => readRecorded(id, h.home, git),
    // Every source readable and empty unless the test says otherwise.
    suggestSignals: async () => ({
      repo: REPO, pulls: { ok: true, value: [] }, loops: ["nova"], doctors: [], weights: {}, projectId: null, closesAreTickets: true,
      blocked: { ok: true, value: [] }, parked: { ok: true, value: [] }, journal: { ok: true, value: [] }, speed: { ok: true, value: [] },
      ...options.signals,
    }),
    noiseFloors: () => (options.noiseFloors ? options.noiseFloors() : { floors: [], staleShare: 0.2 }),
    saturationRuns: () => (options.saturationRuns ? options.saturationRuns() : 3),
    now: () => "2026-11-18T00:00:00.000Z", user: () => "tester",
    out: (line) => out.push(line), err: (line) => err.push(line),
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    const status = await runEvalsSet([...argv, "--project", h.root], deps);
    return { status, json: out.length > 0 ? JSON.parse(out.join("\n")) : undefined, err: err.join("\n") };
  };
  return { h, run, sampled, reads, opened: () => opened, verifications, writes };
}

/** A finished eval run under the project that ran the given PRs of REPO, as experiments.ts leaves it. */
function fixtureRun(project: string, name: string, startedAt: string, repo: string, prs: number[]): void {
  const dir = join(experimentsRoot(project), name);
  mkdirSync(dir, { recursive: true });
  const arms = [{ name: "opus", lineup: "live", overlay: null }];
  const config = {
    project, clerk: "", sample: { cap: 1, since: null, repos: null }, source: { kind: "pr", repo, prs, ticket: null },
    lineup: null, arms, caps: { trialMinutes: 60, batchMinutes: 360 }, rates: null, sources: {},
    scoring: { testGlobs: [], testCommand: "x {file}", setup: null, review: false, judge: null },
  };
  const sampled = { ...ticket(prs[0]!), repo, humanPrs: prs.map((pr) => ({ ...ticket(pr).humanPrs[0]! })), oaKey: "GH-1" };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, id: name, startedAt, config, sample: { tickets: [sampled], skipped: [], notes: [], arms }, rows: {} }));
  const row = {
    ticket: "GH-1", arm: "opus", lineup: "live", outcome: "green-pr", detail: "DONE", gates: [], weakening: [], reviewRounds: 0, reviewThreads: 0,
    wallSeconds: 60, tokens: null, cost: { usd: null, source: "unknown" }, artifacts: "GH-1/opus", models: [],
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify({ id: name, startedAt, finishedAt: startedAt, arms, skipped: [], notes: [], stoppedBy: null, rows: [row] }));
}

/** The project config with `relayEvalPatches` set, or left out. */
function relayConfig(project: string, relay: boolean | undefined): void {
  writeProjectConfig(project);
  const path = join(project, ".ralph", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (relay !== undefined) config.relayEvalPatches = relay;
  writeFileSync(path, JSON.stringify(config));
}

const ADD = ["add", "--repo", REPO, "--pr", "12", "--reason", "a clean bugfix", "--tag", "ui"];

describe("evals-set CLI", () => {
  it("adds a case, then lists and shows it at the written version", async () => {
    const { h, run, sampled } = setup({ files: ["src/a.test.ts"] });
    const added = await run(...ADD);
    expect(added.status).toBe(0);
    expect(added.json.case).toMatchObject({ id: "org-app-12", reason: "a clean bugfix", tags: ["ui"], addedBy: "tester", heldOut: ["src/a.test.ts"], status: "active" });
    expect(sampled[0]!.source).toEqual({ kind: "pr", repo: REPO, prs: [12], ticket: null });
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(added.json.sha);

    const listed = await run("list");
    expect(listed.status).toBe(0);
    expect(listed.json.version).toBe(added.json.sha);
    expect(listed.json.cases.map((c: { id: string }) => c.id)).toEqual(["org-app-12"]);

    const shown = await run("show", "org-app-12");
    expect(shown.json).toEqual({ version: added.json.sha, case: added.json.case });
    const missing = await run("show", "nope");
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("no case nope");
  });

  it("refuses an unmerged PR with no commit", async () => {
    const { h, run } = setup({ sample: async () => { throw new Error(`eval: ${REPO}#12 is not merged; only merged work is a reference`); } });
    const before = originCommits(h.origin);
    const added = await run(...ADD);
    expect(added.status).toBe(1);
    expect(added.err).toContain("is not merged");
    expect(originCommits(h.origin)).toBe(before);
  });

  it("refuses a PR already in the set before building a sample", async () => {
    const { h, run, sampled } = setup();
    expect((await run(...ADD)).status).toBe(0);
    const before = originCommits(h.origin);
    sampled.length = 0;
    const again = await run("add", "--repo", REPO, "--pr", "40", "--pr", "12", "--reason", "again");
    expect(again.status).toBe(1);
    expect(again.err).toContain(`${REPO}#12 is already in case org-app-12`);
    expect(sampled).toEqual([]);
    expect(originCommits(h.origin)).toBe(before);
  });

  it("retires a case and keeps its file", async () => {
    const { h, run } = setup();
    expect((await run(...ADD)).status).toBe(0);
    const retired = await run("retire", "org-app-12");
    expect(retired.status).toBe(0);
    expect(retired.json.case.status).toBe("retired");
    const listed = await run("list", "--status", "retired");
    expect(listed.json.cases.map((c: { id: string }) => c.id)).toEqual(["org-app-12"]);
    expect((await run("list", "--status", "active")).json.cases).toEqual([]);
    expect(must(["-C", h.origin, "ls-tree", "-r", "--name-only", "main", "--", "evals"])).toBe("evals/proj/org-app-12.json");
  });

  it("keeps a case: active, keptAt stored, one commit; refuses an unknown or retired case (#860)", async () => {
    const { h, run, writes } = setup();
    expect((await run(...ADD)).status).toBe(0);
    const before = originCommits(h.origin);
    const kept = await run("keep", "org-app-12");
    expect(kept.status).toBe(0);
    expect(writes.at(-1)).toEqual({ projectId: "proj", kind: "keep", id: "org-app-12" });
    expect(kept.json.case).toMatchObject({ id: "org-app-12", status: "active", keptAt: "2026-11-19T00:00:00.000Z" });
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(kept.json.sha);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(readSet("proj", h.home, git).cases[0]).toMatchObject({ status: "active", keptAt: "2026-11-19T00:00:00.000Z" });

    const missing = await run("keep", "nope");
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("no case nope");
    expect((await run("retire", "org-app-12")).status).toBe(0);
    const retired = await run("keep", "org-app-12");
    expect(retired.status).toBe(1);
    expect(retired.err).toContain("org-app-12 is retired");
    expect(readSet("proj", h.home, git).cases[0]!.status).toBe("retired");
    expect((await run("keep")).status).toBe(64);
    expect((await run("keep", "a", "b")).status).toBe(64);
  });

  it("edits a case's tags and notes in one commit each", async () => {
    const { h, run } = setup();
    expect((await run(...ADD, "--notes", "old notes")).status).toBe(0);
    const before = originCommits(h.origin);
    const edited = await run("edit", "org-app-12", "--tag", " api", "--tag", "db", "--tag", "api", "--tag", "  ");
    expect(edited.status).toBe(0);
    expect(edited.json.case).toMatchObject({ id: "org-app-12", tags: ["api", "db"], notes: "old notes", reason: "a clean bugfix" });
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(edited.json.sha);
    expect(readSet("proj", h.home, git).cases[0]).toMatchObject({ tags: ["api", "db"], notes: "old notes" });

    const cleared = await run("edit", "org-app-12", "--no-tags", "--notes", "");
    expect(cleared.status).toBe(0);
    expect(cleared.json.case).toMatchObject({ tags: [], notes: "" });
    expect(originCommits(h.origin)).toBe(before + 2);

    const same = await run("edit", "org-app-12", "--notes", "");
    expect(same.status).toBe(1);
    expect(same.err).toContain("nothing to commit");
    const missing = await run("edit", "nope", "--notes", "x");
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("no case nope");
    expect(originCommits(h.origin)).toBe(before + 2);
  });

  it("exits 64 on an edit that changes nothing or mixes --tag with --no-tags", async () => {
    const { run } = setup();
    expect((await run("edit", "org-app-12")).status).toBe(64);
    expect((await run("edit", "org-app-12", "--tag", "a", "--no-tags")).status).toBe(64);
    expect((await run("edit", "--notes", "x")).status).toBe(64);
  });

  it("views the set as the dashboard's projection, with the newest run that held each case", async () => {
    const { h, run } = setup({ files: ["src/a.test.ts"] });
    expect((await run(...ADD, "--notes", "the fix is in a.ts")).status).toBe(0);
    expect((await run("check", "--case", "org-app-12", "--command", "bun test")).status).toBe(0);
    const second = await run("add", "--repo", REPO, "--pr", "30", "--reason", "another");
    expect(second.status).toBe(0);
    fixtureRun(h.root, "eval-old", "2026-11-01T00:00:00Z", "org/app", [12]);
    fixtureRun(h.root, "eval-new", "2026-11-10T00:00:00Z", "ORG/APP", [12]);
    fixtureRun(h.root, "eval-other", "2026-11-12T00:00:00Z", REPO, [12, 31]);
    // A run directory that cannot be read is skipped, not fatal.
    mkdirSync(join(experimentsRoot(h.root), "eval-broken"), { recursive: true });
    writeFileSync(join(experimentsRoot(h.root), "eval-broken", "state.json"), "{ not json");

    const off = await run("view");
    expect(off.status).toBe(0);
    expect(off.json).toEqual({
      version: second.json.sha, details: false, noiseFloor: { state: "missing", floor: null, drift: null, staleShare: 0.2 },
      cases: [
        { id: "org-app-12", repo: REPO, prs: [12], title: "Fix it", tags: ["ui"], graders: ["held-out tests", "check", "gates"], status: "active", addedAt: "2026-11-18T00:00:00.000Z", addedBy: "tester", lastRun: { run: "eval-new", startedAt: "2026-11-10T00:00:00Z" }, saturation: { saturated: false, passes: 0, window: 3 }, calibrations: 0 },
        { id: "org-app-30", repo: REPO, prs: [30], title: "Fix it", tags: [], graders: ["held-out tests", "gates"], status: "active", addedAt: "2026-11-18T00:00:00.000Z", addedBy: "tester", lastRun: null, saturation: { saturated: false, passes: 0, window: 3 }, calibrations: 0 },
      ],
      calibrationSuggestions: [],
    });
    const text = JSON.stringify(off.json);
    for (const leak of ["src/a.test.ts", "bun test", "It is broken", "base1", "the fix is in a.ts", "a clean bugfix", '"reference":', '"heldOut":', '"check":']) expect(text).not.toContain(leak);

    relayConfig(h.root, false);
    expect((await run("view")).json.details).toBe(false);
    relayConfig(h.root, true);
    const on = await run("view");
    expect(on.json.details).toBe(true);
    expect(on.json.cases[0]).toMatchObject({ reason: "a clean bugfix", notes: "the fix is in a.ts" });
    for (const leak of ["src/a.test.ts", "bun test", "It is broken", "base1"]) expect(JSON.stringify(on.json)).not.toContain(leak);
  });

  it("views the set with the latest injected noise floor's status: fresh, stale or missing (#859)", async () => {
    const floor = (measuredAt: string, cases: string[]): NoiseFloor => ({
      v: 1, version: "v0", measuredAt, runId: `floor-${measuredAt}`, arms: ["live-1", "live-2"], cases, spread: { objective: 0, judge: 0.5 }, perCase: [],
    });
    let floors: NoiseFloor[] = [];
    const { run } = setup({ noiseFloors: () => ({ floors, staleShare: 0.2 }) });
    expect((await run(...ADD)).status).toBe(0);
    expect((await run("view")).json.noiseFloor).toEqual({ state: "missing", floor: null, drift: null, staleShare: 0.2 });
    // The latest floor counts, whatever order the store reads them in.
    floors = [floor("2026-11-19T00:00:00Z", ["org-app-12"]), floor("2026-11-01T00:00:00Z", ["gone"])];
    expect((await run("view")).json.noiseFloor).toMatchObject({ state: "fresh", floor: { runId: "floor-2026-11-19T00:00:00Z" }, drift: { added: 0, retired: 0 } });
    floors = [floor("2026-11-19T00:00:00Z", ["gone"])];
    expect((await run("view")).json.noiseFloor).toMatchObject({ state: "stale", drift: { added: 1, retired: 1 } });
  });

  it("views the set with no floor when the floor store cannot be read (#859)", async () => {
    const { run } = setup({ noiseFloors: () => { throw new Error("unreadable"); } });
    expect((await run(...ADD)).status).toBe(0);
    const view = await run("view");
    expect(view.status).toBe(0);
    expect(view.json.noiseFloor).toEqual({ state: "missing", floor: null, drift: null, staleShare: 0.2 });
  });

  it("views saturation over the configured window, the default when it cannot be read, and null for a retired case (#860)", async () => {
    let runs: () => number = () => 5;
    const { run } = setup({ saturationRuns: () => runs() });
    expect((await run(...ADD)).status).toBe(0);
    expect((await run("view")).json.cases[0].saturation).toEqual({ saturated: false, passes: 0, window: 5 });
    runs = () => { throw new Error("broken config"); };
    const broken = await run("view");
    expect(broken.status).toBe(0);
    expect(broken.json.cases[0].saturation).toEqual({ saturated: false, passes: 0, window: 3 });
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      runs = () => bad;
      const view = await run("view");
      expect(view.status).toBe(0);
      expect(view.json.cases[0].saturation).toEqual({ saturated: false, passes: 0, window: 3 });
    }
    expect((await run("retire", "org-app-12")).status).toBe(0);
    const retired = await run("view");
    expect(retired.json.cases[0].saturation).toBeNull();
    expect(retired.json.cases[0].status).toBe("retired");
  });

  it("holds out the test files the PRs changed when no --held-out is given", async () => {
    const { run } = setup({ files: ["src/a.ts", "src/a.test.ts", "e2e/x.spec.ts"] });
    const added = await run(...ADD);
    expect(added.json.case.heldOut).toEqual(["e2e/x.spec.ts", "src/a.test.ts"]);
  });

  it("exits 64 on bad usage", async () => {
    const { run } = setup();
    expect((await run("frobnicate")).status).toBe(64);
    expect((await run("add", "--repo", REPO, "--reason", "x")).status).toBe(64);
    expect((await run("list", "--status", "paused")).status).toBe(64);
    // A check enters only through `check`, which verifies it.
    expect((await run(...ADD, "--check", "bun test")).status).toBe(64);
  });
});

describe("evals-set calibrate (#876)", () => {
  const CALIBRATE = ["calibrate", "--case", "org-app-12", "--arm", "opus", "--arm", "codex", "--axis", "scope", "--prefer", "codex", "--reason", "opus rewrote the router"];

  it("hands the write the parsed verdict, by and at from deps, and lands one commit", async () => {
    const { h, run, writes } = setup();
    expect((await run(...ADD)).status).toBe(0);
    writes.length = 0;
    const before = originCommits(h.origin);
    const result = await run(...CALIBRATE);
    expect(result.status).toBe(0);
    const verdict = { arms: ["opus", "codex"], axis: "scope", preferred: "codex", reason: "opus rewrote the router", by: "tester", at: "2026-11-18T00:00:00.000Z" };
    expect(writes).toEqual([{ projectId: "proj", kind: "calibrate", id: "org-app-12", verdict }]);
    expect(result.json.case.calibration).toEqual([verdict]);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(readSet("proj", h.home, git).cases[0]!.calibration).toEqual([verdict]);

    const byAna = await run(...CALIBRATE, "--by", "ana");
    expect(byAna.status).toBe(0);
    expect((writes.at(-1) as { verdict: { by: string } }).verdict.by).toBe("ana");
    expect((await run("view")).json.cases[0].calibrations).toBe(2);
  });

  it("refuses a bad axis, one --arm, a --prefer that is not an arm and an unknown case, without writing", async () => {
    const { run, writes } = setup();
    expect((await run(...ADD)).status).toBe(0);
    writes.length = 0;
    const axis = await run("calibrate", "--case", "org-app-12", "--arm", "opus", "--arm", "codex", "--axis", "speed", "--prefer", "codex", "--reason", "x");
    expect(axis.status).toBe(1);
    expect(axis.err).toContain("verdict.axis must be one of correctness, scope, tests, maintainability, review");
    const oneArm = await run("calibrate", "--case", "org-app-12", "--arm", "opus", "--axis", "scope", "--prefer", "opus", "--reason", "x");
    expect(oneArm.status).toBe(64);
    expect(oneArm.err).toContain("calibrate needs exactly two --arm");
    const prefer = await run("calibrate", "--case", "org-app-12", "--arm", "opus", "--arm", "codex", "--axis", "scope", "--prefer", "sonnet", "--reason", "x");
    expect(prefer.status).toBe(1);
    expect(prefer.err).toContain("verdict.preferred must be one of the arms");
    const same = await run("calibrate", "--case", "org-app-12", "--arm", "opus", "--arm", "opus", "--axis", "scope", "--prefer", "opus", "--reason", "x");
    expect(same.status).toBe(1);
    expect(same.err).toContain("verdict.arms must be two distinct non-empty arm names");
    expect(writes).toEqual([]);
    // An unknown case is refused by the write, with the reason.
    const missing = await run("calibrate", "--case", "nope-1", "--arm", "opus", "--arm", "codex", "--axis", "scope", "--prefer", "opus", "--reason", "x");
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("no case nope-1 in the set");
    expect((await run("calibrate", "--arm", "opus", "--arm", "codex", "--axis", "scope", "--prefer", "opus", "--reason", "x")).status).toBe(64);
  });
});

describe("evals-set check", () => {
  const added = async (options: Parameters<typeof setup>[0] = {}) => {
    const fixture = setup(options);
    expect((await fixture.run(...ADD)).status).toBe(0);
    fixture.writes.length = 0;
    return fixture;
  };

  it("stores an accepted check with both outcomes, and never prints its text", async () => {
    const { h, run, verifications, writes } = await added();
    const before = originCommits(h.origin);
    const result = await run("check", "--case", "org-app-12", "--command", "bun test probe", "--timeout", "30", "--by", "ana");
    expect(result.status, result.err).toBe(0);
    expect(verifications).toEqual([{ id: "org-app-12", spec: { command: "bun test probe" }, options: { projectPath: h.root, timeoutMs: 30_000 } }]);
    const check = { command: "bun test probe", base: "fail", reference: "pass", acceptedAt: "2026-11-18T00:00:00.000Z", acceptedBy: "ana" };
    expect(writes).toEqual([{ projectId: "proj", kind: "check", id: "org-app-12", check }]);
    expect(result.json).toEqual({ sha: must(["-C", h.origin, "rev-parse", "main"]), case: "org-app-12", base: "fail", reference: "pass" });
    expect(JSON.stringify(result.json)).not.toContain("probe");
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(readSet("proj", h.home, git).cases[0]!.check).toEqual(check);
  });

  it("refuses a check that passes on the base, and writes nothing", async () => {
    const { run, writes } = await added({ verified: { base: { result: "pass" }, reference: { result: "pass" }, notes: [] } });
    const result = await run("check", "--case", "org-app-12", "--test", "src/a.test.ts");
    expect(result.status).toBe(1);
    expect(writes).toEqual([]);
    expect(result.err.split("\n").at(-1)).toBe("evals-set: refused: the check passes on the base (base1); it must fail there");
    expect(result.json).toEqual({ sha: null, case: "org-app-12", base: { result: "pass" }, reference: { result: "pass" } });
  });

  it("refuses a check that fails on the reference", async () => {
    const { run, writes } = await added({ verified: { base: { result: "fail" }, reference: { result: "fail" }, notes: [] } });
    const result = await run("check", "--case", "org-app-12", "--test", "src/a.test.ts");
    expect(result.status).toBe(1);
    expect(writes).toEqual([]);
    expect(result.err.split("\n").at(-1)).toBe("evals-set: refused: the check fails on the reference (h1); it must pass there");
  });

  it("refuses a check that cannot run, naming the base first", async () => {
    const { run, writes } = await added({ verified: { base: { result: "error", why: "command not found" }, reference: { result: "error", why: "timed out" }, notes: [] } });
    const result = await run("check", "--case", "org-app-12", "--command", "nope");
    expect(result.status).toBe(1);
    expect(writes).toEqual([]);
    expect(result.err.split("\n").at(-1)).toBe("evals-set: refused: the check cannot run on the base: command not found");
    expect(result.json.base).toEqual({ result: "error", why: "command not found" });
  });

  it("refuses a retired case before verifying: no run grades its check", async () => {
    const { run, verifications, writes } = await added();
    expect((await run("retire", "org-app-12")).status).toBe(0);
    const writesBefore = writes.length;
    const result = await run("check", "--case", "org-app-12", "--command", "x");
    expect(result.status).toBe(1);
    expect(result.err).toBe("evals-set: refused: org-app-12 is retired; no run grades its check");
    expect(verifications).toEqual([]);
    expect(writes.length).toBe(writesBefore);
  });

  it("refuses an unknown case before verifying", async () => {
    const { run, verifications } = await added();
    const result = await run("check", "--case", "nope-1", "--command", "x");
    expect(result.status).toBe(1);
    expect(result.err).toBe("evals-set: no case nope-1 in the set");
    expect(verifications).toEqual([]);
  });

  it("exits 64 without exactly one of --test or --command, or a bad --timeout or test path", async () => {
    const { run, verifications } = setup();
    expect((await run("check", "--case", "org-app-12", "--test", "a.test.ts", "--command", "x")).status).toBe(64);
    expect((await run("check", "--case", "org-app-12")).status).toBe(64);
    expect((await run("check", "--command", "x")).status).toBe(64);
    expect((await run("check", "--case", "org-app-12", "--command", "x", "--timeout", "0")).status).toBe(64);
    expect((await run("check", "--case", "org-app-12", "--command", "x", "--timeout", "1.5")).status).toBe(64);
    expect((await run("check", "--case", "org-app-12", "--test", "../a.test.ts")).status).toBe(1);
    expect(verifications).toEqual([]);
  });
});

const merged = (number: number, extra: Partial<MergedPr> = {}): MergedPr => ({
  number, title: `PR ${number}`, url: `https://github.com/${REPO}/pull/${number}`, mergedAt: `2026-11-${String(number % 28 + 1).padStart(2, "0")}T00:00:00Z`,
  body: "", headRefName: `nova/${number}-fix`, reviews: 0, closes: [], ...extra,
});

describe("evals-set suggest", () => {
  it("never suggests a PR the set holds, retired or not", async () => {
    // PR 12 is ADD's case; it struggled as loudly as PR 30, which is listed.
    const struggled = { reviews: 6, closes: [11] };
    const { run } = setup({
      signals: {
        pulls: { ok: true, value: [merged(12, struggled), merged(30, { ...struggled, closes: [29] })] },
        blocked: { ok: true, value: [{ ticket: 11, loop: "nova" }, { ticket: 29, loop: "nova" }] },
      },
    });
    expect((await run(...ADD)).status).toBe(0);
    expect((await run("retire", "org-app-12")).status).toBe(0);
    const suggested = await run("suggest");
    expect(suggested.status).toBe(0);
    expect(suggested.json.suggestions.map((s: { pr: number }) => s.pr)).toEqual([30]);
    expect(suggested.json.version).toBe((await run("list")).json.version);
  });

  it("lists a struggled PR with its reasons in order, before a calmer one", async () => {
    const { run } = setup({
      signals: {
        pulls: { ok: true, value: [merged(40, { reviews: 3, closes: [39] }), merged(41, { reviews: 5, closes: [38] }), merged(42)] },
        blocked: { ok: true, value: [{ ticket: 38, loop: "nova" }] },
      },
    });
    const suggested = await run("suggest");
    expect(suggested.status).toBe(0);
    expect(suggested.json.missing).toEqual([]);
    expect(suggested.json.suggestions.map((s: { pr: number }) => s.pr)).toEqual([41, 40]);
    expect(suggested.json.suggestions[0].reasons.map((r: { signal: string }) => r.signal)).toEqual(["blocked", "reviewRounds"]);
    expect(suggested.json.suggestions[0].reasons[0].text).toBe("blocked by nova on #38");
  });

  it("names an unreadable source in missing and still answers", async () => {
    const { run } = setup({
      signals: { pulls: { ok: true, value: [merged(40, { reviews: 4 })] }, blocked: { ok: false, why: "tracker down" } },
    });
    const suggested = await run("suggest");
    expect(suggested.status).toBe(0);
    expect(suggested.json.missing).toEqual([{ source: "tracker", why: "tracker down" }]);
    expect(suggested.json.suggestions.map((s: { pr: number }) => s.pr)).toEqual([40]);
  });

  it("answers no suggestions and a missing pulls source when the project has no GitHub origin", async () => {
    const { run } = setup({ signals: { repo: null, pulls: { ok: false, why: "the project has no GitHub origin" } } });
    const suggested = await run("suggest");
    expect(suggested.status).toBe(0);
    expect(suggested.json).toEqual({ version: null, suggestions: [], missing: [{ source: "pulls", why: "the project has no GitHub origin" }] });
  });

  it("keeps --limit suggestions and exits 64 on a bad --limit", async () => {
    const { run } = setup({ signals: { pulls: { ok: true, value: [merged(40, { reviews: 4 }), merged(41, { reviews: 5 })] } } });
    expect((await run("suggest", "--limit", "1")).json.suggestions.map((s: { pr: number }) => s.pr)).toEqual([41]);
    for (const bad of ["0", "-1", "two", "1.5"]) expect((await run("suggest", "--limit", bad)).status).toBe(64);
    expect((await run("suggest", "extra")).status).toBe(64);
  });
});

describe("evals-set import-backtest", () => {
  const LEDGER = [entry("GH-11", [12]), entry("OA-7", [30, 31], "OAI-70"), entry("OA-8", [])];

  it("imports each ledger ticket as one case in one commit, and a second run imports nothing", async () => {
    const { h, run, sampled, reads, opened } = setup({ files: ["src/a.test.ts"] });
    commitLedger(h.home, LEDGER);
    const ledgerBefore = must(["-C", h.origin, "show", "main:backtests/proj/ledger.jsonl"]);
    const before = originCommits(h.origin);

    const first = await run("import-backtest", "--by", "importer");
    expect(first.status).toBe(0);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "rev-parse", "main"])).toBe(first.json.sha);
    expect(first.json).toMatchObject({ imported: ["org-app-12", "org-app-30"], already: [], skipped: [{ ticket: "OA-8", reason: "the ledger entry names no PR" }] });
    expect(first.err).toContain("evals-set: skipped OA-8: the ledger entry names no PR");
    expect(sampled.map((config) => config.source)).toEqual([
      { kind: "pr", repo: REPO, prs: [12], ticket: "#11" },
      { kind: "pr", repo: REPO, prs: [30, 31], ticket: "OA-7" },
    ]);
    // The OA ticket is read where the backtest read it, with its intake key; the GH one is not.
    expect(opened()).toBe(1);
    expect(reads).toEqual([["OA-7", "OAI-70"]]);
    const set = readSet("proj", h.home, git);
    expect(set.cases.map((c) => [c.id, c.tags, c.addedBy, c.heldOut])).toEqual([
      ["org-app-12", ["clerk-backtest"], "importer", ["src/a.test.ts"]],
      ["org-app-30", ["clerk-backtest"], "importer", ["src/a.test.ts"]],
    ]);
    expect(set.cases[0]!.reason).toBe("clerk-vs-human backtest: GH-11 (ledger run run-1, recorded 2026-10-30T00:00:00Z)");

    sampled.length = 0;
    const second = await run("import-backtest");
    expect(second.status).toBe(0);
    expect(second.json).toMatchObject({ sha: null, imported: [], already: [{ ticket: "GH-11", case: "org-app-12" }, { ticket: "OA-7", case: "org-app-30" }] });
    expect(second.err).toContain("evals-set: nothing new to import; 2 already in the set, 1 skipped");
    expect(sampled).toEqual([]);
    // Nothing left to read, so the ticket source is not opened again.
    expect(opened()).toBe(1);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "show", "main:backtests/proj/ledger.jsonl"])).toBe(ledgerBefore);
  });

  it("skips an entry whose sample throws, with its reason, and imports the rest", async () => {
    const { h, run } = setup({
      sample: async (config) => {
        const pr = (config.source as PrSource).prs[0]!;
        if (pr === 12) throw new Error(`eval: ${REPO}#12 is not merged; only merged work is a reference`);
        return { tickets: [ticket(pr)], skipped: [], notes: [], arms: [] } as unknown as BacktestSample;
      },
    });
    commitLedger(h.home, LEDGER.slice(0, 2));
    const before = originCommits(h.origin);
    const result = await run("import-backtest");
    expect(result.status).toBe(0);
    expect(result.json.imported).toEqual(["org-app-30"]);
    expect(result.json.skipped).toEqual([{ ticket: "GH-11", reason: expect.stringContaining("is not merged") }]);
    expect(result.err).toContain("evals-set: skipped GH-11:");
    expect(originCommits(h.origin)).toBe(before + 1);
  });

  it("never opens the ticket source when every entry is a GitHub issue", async () => {
    const { h, run, opened } = setup();
    commitLedger(h.home, [entry("GH-11", [12]), entry("GH-29", [30])]);
    const result = await run("import-backtest");
    expect(result.status).toBe(0);
    expect(result.json.imported).toEqual(["org-app-12", "org-app-30"]);
    expect(opened()).toBe(0);
  });

  it("fails with no commit when the ticket source cannot be opened", async () => {
    const { h, run, sampled } = setup({ ledgerTickets: async () => { throw new Error("backtest: no keyed tracker and no clerk block at /nope; pass the project's checkout as --project"); } });
    commitLedger(h.home, LEDGER);
    const before = originCommits(h.origin);
    const result = await run("import-backtest");
    expect(result.status).toBe(1);
    expect(result.err).toContain("no keyed tracker and no clerk block");
    expect(sampled).toEqual([]);
    expect(originCommits(h.origin)).toBe(before);
  });

  it("fails with no commit when every entry is skipped", async () => {
    const { h, run } = setup({ sample: async () => { throw new Error("eval: the PR is not merged"); } });
    commitLedger(h.home, LEDGER);
    const before = originCommits(h.origin);
    const result = await run("import-backtest");
    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({ sha: null, imported: [], already: [] });
    expect(result.json.skipped.map((s: { ticket: string }) => s.ticket)).toEqual(["GH-11", "OA-7", "OA-8"]);
    expect(result.err).toContain("nothing new to import; 0 already in the set, 3 skipped");
    expect(originCommits(h.origin)).toBe(before);
  });

  it("fails rather than importing nothing when the ledger cannot be read", async () => {
    const { h, run } = setup();
    must(["-C", h.home, "remote", "set-url", "origin", join(h.root, "gone.git")]);
    const result = await run("import-backtest");
    expect(result.status).toBe(1);
    expect(result.err).toContain("cannot read the backtest ledger");
  });

  it("fails naming the project when it has no ledger, rather than printing an empty seed", async () => {
    const { h, run } = setup();
    const before = originCommits(h.origin);
    const result = await run("import-backtest");
    expect(result.status).toBe(1);
    expect(result.err).toContain("no backtest ledger entries for proj");
    expect(originCommits(h.origin)).toBe(before);
  });
});

const hasFlock = spawnSync("flock", ["--version"]).status === 0;

describe("the locked write", () => {
  it.skipIf(!hasFlock)("lands two concurrent CLI writers through flock as two commits", async () => {
    const h = harness();
    const before = originCommits(h.origin);
    const curation = { heldOut: [], tags: [], reason: "r", notes: "", addedAt: "2026-11-18T00:00:00Z", addedBy: "tester" };
    const files = [12, 30].map((pr) => {
      const file = join(h.root, `case-${pr}.json`);
      writeFileSync(file, serializeCase(caseFromTicket(ticket(pr), curation)));
      return file;
    });
    const childEnv = {
      ...env, RALPH_JOURNAL_HOME: h.home, RALPH_JOURNAL_LOCK: join(h.root, "journal.lock"), RALPH_JOURNAL_WORKTREE: h.worktree,
    } as NodeJS.ProcessEnv;
    delete childEnv.RALPH_JOURNAL_LOCKED;
    const cli = join(import.meta.dirname, "evals-set.ts");
    const runOne = (file: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath.endsWith("bun") ? process.execPath : "bun", [cli, "_write", "--project-id", "proj", "--add", file], { env: childEnv });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
    const results = await Promise.all(files.map(runOne));
    for (const result of results) expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(originCommits(h.origin)).toBe(before + 2);
    expect(readSet("proj", h.home, git).cases.map((c) => c.id)).toEqual(["org-app-12", "org-app-30"]);
  });

  it.skipIf(!hasFlock)("edits through the internal write with the edit commit message", async () => {
    const h = harness();
    const curation = { heldOut: [], tags: ["ui"], reason: "r", notes: "n", addedAt: "2026-11-18T00:00:00Z", addedBy: "tester" };
    writeCase({ projectId: "proj", home: h.home, worktree: h.worktree, git, message: "add", change: (current) => addCase(current, caseFromTicket(ticket(12), curation)) });
    const before = originCommits(h.origin);
    const file = join(h.root, "edit.json");
    writeFileSync(file, JSON.stringify({ id: "org-app-12", tags: ["api"] }));
    const childEnv = { ...env, RALPH_JOURNAL_HOME: h.home, RALPH_JOURNAL_LOCK: join(h.root, "journal.lock"), RALPH_JOURNAL_WORKTREE: h.worktree } as NodeJS.ProcessEnv;
    delete childEnv.RALPH_JOURNAL_LOCKED;
    const cli = join(import.meta.dirname, "evals-set.ts");
    const result = spawnSync(process.execPath.endsWith("bun") ? process.execPath : "bun", [cli, "_write", "--project-id", "proj", "--edit", file], { encoding: "utf8", env: childEnv });
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout).case).toMatchObject({ tags: ["api"], notes: "n" });
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "log", "-1", "--format=%s", "main"])).toBe("chore(evals): edit org-app-12 in proj");
  });

  it.skipIf(!hasFlock)("attaches a check through the internal write, and refuses an unverified one", async () => {
    const h = harness();
    const curation = { heldOut: [], tags: [], reason: "r", notes: "", addedAt: "2026-11-18T00:00:00Z", addedBy: "tester" };
    writeCase({ projectId: "proj", home: h.home, worktree: h.worktree, git, message: "add", change: (current) => addCase(current, caseFromTicket(ticket(12), curation)) });
    const before = originCommits(h.origin);
    const check = { test: "src/a.test.ts", base: "fail", reference: "pass", acceptedAt: "2026-11-19T00:00:00Z", acceptedBy: "ana" };
    const childEnv = { ...env, RALPH_JOURNAL_HOME: h.home, RALPH_JOURNAL_LOCK: join(h.root, "journal.lock"), RALPH_JOURNAL_WORKTREE: h.worktree } as NodeJS.ProcessEnv;
    delete childEnv.RALPH_JOURNAL_LOCKED;
    const cli = join(import.meta.dirname, "evals-set.ts");
    const write = (body: unknown) => {
      const file = join(h.root, "check.json");
      writeFileSync(file, JSON.stringify(body));
      return spawnSync(process.execPath.endsWith("bun") ? process.execPath : "bun", [cli, "_write", "--project-id", "proj", "--check", file], { encoding: "utf8", env: childEnv });
    };
    const refused = write({ id: "org-app-12", check: { ...check, base: "pass" } });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("check.base must be fail");
    expect(originCommits(h.origin)).toBe(before);
    const result = write({ id: "org-app-12", check });
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout).case.check).toEqual(check);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "log", "-1", "--format=%s", "main"])).toBe("chore(evals): attach a check to org-app-12 in proj");
  });

  it.skipIf(!hasFlock)("calibrates through the internal write, and refuses a malformed verdict (#876)", async () => {
    const h = harness();
    const curation = { heldOut: [], tags: [], reason: "r", notes: "", addedAt: "2026-11-18T00:00:00Z", addedBy: "tester" };
    writeCase({ projectId: "proj", home: h.home, worktree: h.worktree, git, message: "add", change: (current) => addCase(current, caseFromTicket(ticket(12), curation)) });
    const before = originCommits(h.origin);
    const verdict = { arms: ["opus", "codex"], axis: "tests", preferred: "opus", reason: "codex skipped the edge case", by: "ana", at: "2026-11-19T00:00:00Z" };
    const childEnv = { ...env, RALPH_JOURNAL_HOME: h.home, RALPH_JOURNAL_LOCK: join(h.root, "journal.lock"), RALPH_JOURNAL_WORKTREE: h.worktree } as NodeJS.ProcessEnv;
    delete childEnv.RALPH_JOURNAL_LOCKED;
    const cli = join(import.meta.dirname, "evals-set.ts");
    const write = (body: unknown) => {
      const file = join(h.root, "calibrate.json");
      writeFileSync(file, JSON.stringify(body));
      return spawnSync(process.execPath.endsWith("bun") ? process.execPath : "bun", [cli, "_write", "--project-id", "proj", "--calibrate", file], { encoding: "utf8", env: childEnv });
    };
    const refused = write({ id: "org-app-12", verdict: { ...verdict, preferred: "sonnet" } });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("verdict.preferred must be one of the arms");
    expect(originCommits(h.origin)).toBe(before);
    const result = write({ id: "org-app-12", verdict });
    expect(result, result.stderr).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout).case.calibration).toEqual([verdict]);
    expect(originCommits(h.origin)).toBe(before + 1);
    expect(must(["-C", h.origin, "log", "-1", "--format=%s", "main"])).toBe("chore(evals): calibrate org-app-12 in proj");
  });
});
