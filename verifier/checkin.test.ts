// @vitest-environment node
/**
 * The session's check-in CLI (felipearos/ralph#565): what `show` prints of
 * the evidence the gate stored, and what `decide` records — `decideVerdict`'s
 * verdict over that evidence, "inconclusive" for a blind check-in, the lease
 * dropped, idempotent on a second run — against a real temp watch store.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { VerifierRules } from "../project-config";
import { subprocessSuite } from "../test-timeouts";
import { parseAcceptance, run, type CheckinDeps } from "./checkin";
import type { GatheredHealth, GatheredTraffic } from "./sentry";
import type { DeployedPr, SentryIssue } from "./verdict";
import { openWatches, readStore, recordEvidence, STORE_RELATIVE_PATH, withStore, type Lease, type Watch } from "./watches";

subprocessSuite("runs verifier/checkin.ts through bun, and git init for its store");

const HOME = join(__dirname, "..");
const CLI = join(HOME, "verifier", "checkin.ts");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;
const FIXTURE = join(HOME, "fixtures", "loggd", ".ralph");

const HOUR = 3_600_000;
const DEPLOYED_AT = "2026-10-01T12:00:00.000Z";
const NOW = new Date(Date.parse(DEPLOYED_AT) + 30 * HOUR);
const PR = 12;
const PR_FILES = ["app/page.tsx", "lib/thing.ts"];

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

const rules = (overrides: Partial<VerifierRules> = {}): VerifierRules => ({
  productionUrl: "https://loggd.app",
  deploy: { source: "vercel", project: "prj_loggd", team: null },
  sentry: { org: "loggd", project: "web" },
  enabled: true,
  windowHours: 24,
  checkIns: [1, 6, 24],
  trafficFloor: false,
  revert: { rateFactor: 5, minEvents: 10, minUsers: 2 },
  follow: { loopPrs: true, humanPrs: true },
  mode: "observe",
  language: "en",
  mergeCommand: null,
  ...overrides,
});

const cleanHealth = (): GatheredHealth => ({ reachable: true, issues: [] });
const someTraffic = (hits = 5): GatheredTraffic => ({ reachable: true, hits });

const regression = (): SentryIssue => ({
  id: "S-1",
  title: "TypeError: thing is undefined",
  link: "https://sentry.io/issues/1",
  firstSeen: new Date(Date.parse(DEPLOYED_AT) + 10 * 60_000).toISOString(),
  preDeployRate: 0,
  postDeployRate: 4,
  frameFiles: ["lib/thing.ts"],
  routes: [],
  events: 20,
  distinctUsers: 3,
});

/** A store with one watch on PR #12 (check-ins 1, 6, 24h, observe), and its path. */
async function watchStore(dir = tempDir("ralph-verifier-checkin-"), mode: Watch["mode"] = "observe"): Promise<string> {
  const path = join(dir, "verifier-watches.json");
  await withStore(path, (store) => {
    openWatches(store, [{
      pr: PR, ticket: 184, ticketRef: "#184", mergeCommit: "m12", mergedAt: "2026-10-01T11:50:00.000Z",
      deployId: "dpl_1", deployedAt: DEPLOYED_AT, deployUrl: null, mode,
    }], [1, 6, 24], new Date(DEPLOYED_AT));
  });
  return path;
}

async function hand(
  path: string,
  offset: number,
  health: GatheredHealth = cleanHealth(),
  traffic: GatheredTraffic = someTraffic(),
  pr: DeployedPr = { number: PR, files: PR_FILES, routes: ["/"] },
): Promise<void> {
  await withStore(path, (store) => recordEvidence(store, PR, offset, {
    gatheredAt: new Date(Date.parse(DEPLOYED_AT) + offset * HOUR).toISOString(),
    health,
    traffic,
    pr,
    otherPrs: [{ number: 13, files: ["docs/readme.md"], routes: [] }],
  }, new Date(Date.parse(DEPLOYED_AT) + offset * HOUR)));
}

const caseOf = (offset: number): string => `verifier check-in +${offset}h of PR #${PR} (#184), deploy dpl_1`;

const deps = (storePath: string, overrides: Partial<CheckinDeps> = {}): CheckinDeps => ({
  storePath, rules: rules(), env: {}, now: () => NOW, ...overrides,
});

const decide = (path: string, offset: number, extra: string[] = [], d: Partial<CheckinDeps> = {}) =>
  run(["decide", caseOf(offset), ...extra], deps(path, d));

const watchOf = (path: string) => readStore(path).watches[String(PR)]!;

/** An acceptance file holding `value` as JSON, and the `--acceptance` arguments that pass it. */
const acceptance = (value: unknown): string[] => {
  const file = join(tempDir("ralph-verifier-acceptance-"), "acceptance.json");
  writeFileSync(file, JSON.stringify(value));
  return ["--acceptance", file];
};

const passing = (): string[] => acceptance([{ criterion: "logs in", result: "passed", evidence: "shots/login.png" }]);

describe("decide on a clean window (AC3)", () => {
  it("is pending at +1h and +6h, and verified at +24h, observed only", async () => {
    const path = await watchStore();
    for (const offset of [1, 6]) {
      await hand(path, offset);
      const ran = await decide(path, offset, offset === 1 ? passing() : []);
      expect(ran.code).toBe(0);
      expect(ran.stdout).toContain(`PR #${PR} +${offset}h → pending`);
      expect(watchOf(path).verdict).toBeNull();
    }
    await hand(path, 24);
    const ran = await decide(path, 24);
    expect(ran.code).toBe(0);
    const watch = watchOf(path);
    expect(watch.verdict?.verdict).toBe("verified");
    expect(watch.verdict?.act).toBe(false);
    expect(ran.stdout).toContain("watch ended verified");
  });

  it("with the traffic floor on, zero hits at the last check-in is unexercised and hits verify", async () => {
    const quiet = await watchStore();
    await hand(quiet, 24, cleanHealth(), someTraffic(0));
    // Earlier check-ins are undecided; the CLI decides the one it is named, as the gate hands them over in order.
    expect((await decide(quiet, 24, [], { rules: rules({ trafficFloor: true }) })).code).toBe(0);
    expect(watchOf(quiet).verdict?.verdict).toBe("unexercised");

    const busy = await watchStore();
    await hand(busy, 24, cleanHealth(), someTraffic(7));
    await decide(busy, 24, passing(), { rules: rules({ trafficFloor: true }) });
    expect(watchOf(busy).verdict?.verdict).toBe("verified");
  });
});

describe("decide on a clear regression in observe mode (AC4)", () => {
  it("records revert as what would have been, and performs nothing", async () => {
    const path = await watchStore();
    await hand(path, 1, { reachable: true, issues: [regression()] });
    const ran = await decide(path, 1);
    expect(ran.code).toBe(0);
    const decision = watchOf(path).checkIns[0]!.result!.decision!;
    expect(decision).toMatchObject({ verdict: "revert", act: false, wouldHaveBeen: "revert" });
    expect(watchOf(path).verdict?.verdict).toBe("revert");
    expect(ran.stdout).toContain("observe: nothing performed");
    expect(ran.stdout).toContain("would have been revert");
    expect(ran.stdout).toContain("watch ended revert");
  });

  it("cannot reach the tracker: the module does not import it", () => {
    expect(readFileSync(CLI, "utf8")).not.toMatch(/from "\.\.\/tracker/);
  });
});

describe("decide in report mode and in act mode", () => {
  it("decides a report-mode watch's clear regression as a ticket it acts on", async () => {
    const path = await watchStore(undefined, "report");
    await hand(path, 1, { reachable: true, issues: [regression()] });
    const ran = await decide(path, 1);
    expect(ran.code).toBe(0);
    expect(watchOf(path).checkIns[0]!.result!.decision).toMatchObject({ verdict: "ticket", act: true, wouldHaveBeen: "revert" });
    expect(watchOf(path).verdict?.verdict).toBe("ticket");
    expect(watchOf(path).mode).toBe("report");
    expect(ran.stdout).toContain("the gate writes it to the tracker on its next poll");
  });

  it("claims no tracker write for a report-mode check-in that leaves the watch open", async () => {
    const path = await watchStore(undefined, "report");
    await hand(path, 1);
    const ran = await decide(path, 1, passing());
    expect(ran.stdout).toContain(`PR #${PR} +1h → pending (report: more check-ins due, nothing written yet)`);
    expect(ran.stdout).not.toContain("the gate writes it");
  });

  it("decides an act-mode watch as act: a clear regression is a revert it acts on", async () => {
    const path = await watchStore(undefined, "act");
    await hand(path, 1, { reachable: true, issues: [regression()] });
    await decide(path, 1);
    const decision = watchOf(path).checkIns[0]!.result!.decision!;
    expect(decision).toMatchObject({ verdict: "revert", act: true });
    expect(decision.wouldHaveBeen).toBeUndefined();
    expect(watchOf(path).verdict?.verdict).toBe("revert");
    expect(watchOf(path).mode).toBe("act");
  });

  it("acts on an early inconclusive outside observe, with nothing it only would have been", async () => {
    const path = await watchStore(undefined, "act");
    await hand(path, 1, { reachable: false, issues: [], why: "Sentry answered 503" });
    await decide(path, 1);
    const decision = watchOf(path).checkIns[0]!.result!.decision!;
    expect(decision).toMatchObject({ verdict: "inconclusive", act: true });
    expect(decision.wouldHaveBeen).toBeUndefined();
  });
});

describe("decide on a PR with no route to measure traffic on", () => {
  const libOnly: DeployedPr = { number: PR, files: ["lib/thing.ts"], routes: [] };
  const noRoute: GatheredTraffic = { reachable: false, hits: 0, why: "no changed route to measure traffic on" };
  const floorOn = { rules: rules({ trafficFloor: true }) };

  it("still judges its Sentry issues with the floor on", async () => {
    const path = await watchStore();
    await hand(path, 1, { reachable: true, issues: [regression()] }, noRoute, libOnly);
    await decide(path, 1, [], floorOn);
    expect(watchOf(path).checkIns[0]!.result!.decision).toMatchObject({ verdict: "revert", act: false, wouldHaveBeen: "revert" });
  });

  it("is inconclusive, not verified, when clean at the last check-in with the floor on", async () => {
    const path = await watchStore();
    await hand(path, 24, cleanHealth(), noRoute, libOnly);
    await decide(path, 24, [], floorOn);
    expect(watchOf(path).verdict).toMatchObject({ verdict: "inconclusive", act: false });
    expect(watchOf(path).verdict?.reason).toContain("no changed route to measure traffic on, so the traffic floor could not be judged");
  });

  it("is verified when clean at the last check-in with the floor off", async () => {
    const path = await watchStore();
    await hand(path, 24, cleanHealth(), noRoute, libOnly);
    await decide(path, 24, passing());
    expect(watchOf(path).verdict?.verdict).toBe("verified");
  });
});

describe("decide with Sentry unreachable (AC5)", () => {
  const blind = (): GatheredHealth => ({ reachable: false, issues: [], why: "Sentry answered 503" });

  it("records an early check-in inconclusive and keeps the watch for the next", async () => {
    const path = await watchStore();
    await hand(path, 1, blind());
    const ran = await decide(path, 1);
    expect(ran.code).toBe(0);
    const watch = watchOf(path);
    expect(watch.checkIns[0]!.result!.decision!.verdict).toBe("inconclusive");
    expect(watch.checkIns[0]!.result!.decision!.reason).toContain("Sentry answered 503");
    expect(watch.verdict).toBeNull();
    expect(watch.checkIns[1]!.result).toBeNull();
    expect(Date.parse(watch.checkIns[1]!.dueAt)).toBeGreaterThan(Date.parse(DEPLOYED_AT) + HOUR);
  });

  it("ends the watch inconclusive at the last check-in, acting on nothing", async () => {
    const path = await watchStore();
    await hand(path, 24, blind());
    await decide(path, 24);
    expect(watchOf(path).verdict).toMatchObject({ verdict: "inconclusive", act: false });
  });
});

describe("decide's bookkeeping", () => {
  const lease = (): Lease => ({ run: "r1", loop: "sent", pid: 1, host: "h", expiresAt: "2099-01-01T00:00:00.000Z" });

  it("drops the decided check-in's lease and no other", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await withStore(path, (store) => {
      store.leases[`${PR}@1`] = lease();
      store.leases["99@1"] = lease();
    });
    await decide(path, 1);
    expect(Object.keys(readStore(path).leases)).toEqual(["99@1"]);
  });

  it("drops the lease too when a racing session decided the check-in first", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const theirs = { decidedAt: NOW.toISOString(), verdict: "pending", reason: "theirs", act: false, priority: "normal" };
    // `now` runs between the unlocked read and the lock: the racing session decides there.
    const race = (): Date => {
      const store = JSON.parse(readFileSync(path, "utf8"));
      store.watches[String(PR)].checkIns[0].result.decision = theirs;
      store.leases[`${PR}@1`] = lease();
      writeFileSync(path, JSON.stringify(store));
      return NOW;
    };
    const ran = await decide(path, 1, [], { now: race });
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("theirs");
    expect(readStore(path).leases).toEqual({});
  });

  it("changes nothing on a second run", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const first = await decide(path, 1);
    const before = readFileSync(path, "utf8");
    const second = await decide(path, 1, [], { now: () => new Date(NOW.getTime() + HOUR) });
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("decide's errors", () => {
  it("exits 3 with no evidence handed over", async () => {
    const path = await watchStore();
    const ran = await decide(path, 1);
    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain(`no evidence recorded for ${PR}@1: the gate has not handed it over`);
  });

  it("exits 3 and records nothing once the verifier is disabled in config, while `show` still reads (#789)", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const before = readFileSync(path, "utf8");
    const off = { rules: rules({ enabled: false }) };
    const ran = await decide(path, 1, passing(), off);
    expect(ran.code).toBe(3);
    expect(ran.stderr).toBe(`verifier-checkin: nothing to decide for ${PR}@1: the verifier is disabled in config ('verifier.enabled' is false)\n`);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect((await run(["show", caseOf(1)], deps(path, off))).code).toBe(0);
  });

  it("exits 2 on a case it cannot read, or none", async () => {
    const path = await watchStore();
    const bad = await run(["decide", "fix the login page"], deps(path));
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("verifier check-in +<hours>h of PR #<n>");
    expect((await run(["decide"], deps(path))).code).toBe(2);
  });

  it("reads the case from RALPH_INTAKE_CASE", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const ran = await run(["decide"], deps(path, { env: { RALPH_INTAKE_CASE: caseOf(1) } }));
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain(`PR #${PR} +1h → pending`);
  });

  it("exits 4 on an invalid acceptance file, for the session to fix and run again", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const file = join(tempDir("ralph-verifier-acceptance-"), "acceptance.json");
    writeFileSync(file, JSON.stringify([{ criterion: "logs in", result: "maybe" }]));
    const ran = await decide(path, 1, ["--acceptance", file]);
    expect(ran.code).toBe(4);
    expect(ran.stderr).toContain("'result'");
    expect(watchOf(path).checkIns[0]!.result!.decision).toBeNull();
  });

  it("files a failed criterion as a ticket, observed only", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const file = join(tempDir("ralph-verifier-acceptance-"), "acceptance.json");
    writeFileSync(file, JSON.stringify([{ criterion: "logs in", result: "failed", detail: "500 on submit", evidence: "HTTP 500" }]));
    const ran = await decide(path, 1, ["--acceptance", file]);
    expect(ran.code).toBe(0);
    expect(watchOf(path).verdict).toMatchObject({ verdict: "ticket", act: false });
  });

  it("exits 2 with no verifier rules", async () => {
    const path = await watchStore();
    await hand(path, 1);
    expect((await decide(path, 1, [], { rules: null })).code).toBe(2);
  });
});

describe("the acceptance check (#566)", () => {
  it("stores each criterion's evidence on the check-in that ran it", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const results = [
      { criterion: "logs in", result: "passed", evidence: "shots/login.png" },
      { criterion: "exports CSV", result: "not-verifiable", detail: "no data on the test account", evidence: "HTTP 204" },
    ];
    expect((await decide(path, 1, acceptance(results))).code).toBe(0);
    const result = watchOf(path).checkIns[0]!.result!;
    expect(result.acceptance).toEqual(results);
    expect(result.acceptanceInconclusive).toBeUndefined();
    expect(result.decision?.verdict).toBe("pending");
  });

  it("exits 4 on evidence that is missing or not a string, or an inconclusive with no reason", async () => {
    const path = await watchStore();
    await hand(path, 1);
    const bad = await decide(path, 1, acceptance([{ criterion: "logs in", result: "passed", evidence: 3 }]));
    expect(bad.code).toBe(4);
    expect(bad.stderr).toContain("'evidence' is not a string");
    const bare = await decide(path, 1, acceptance([{ criterion: "logs in", result: "passed" }]));
    expect(bare.code).toBe(4);
    expect(bare.stderr).toContain("'passed' with no 'evidence'");
    // Only "not-verifiable" may come without evidence.
    expect(parseAcceptance(JSON.stringify([{ criterion: "emails a receipt", result: "not-verifiable", detail: "sends real email" }]))).toEqual({
      results: [{ criterion: "emails a receipt", result: "not-verifiable", detail: "sends real email" }],
    });
    expect((await decide(path, 1, acceptance({ inconclusive: " " }))).code).toBe(4);
    expect(watchOf(path).checkIns[0]!.result!.decision).toBeNull();
  });

  it("records an inconclusive check, never as a failed criterion, and ends the watch inconclusive", async () => {
    const path = await watchStore();
    await hand(path, 1);
    expect((await decide(path, 1, acceptance({ inconclusive: "no test-account credential" }))).code).toBe(0);
    const first = watchOf(path).checkIns[0]!.result!;
    expect(first.acceptanceInconclusive).toBe("no test-account credential");
    expect(first.acceptance).toBeUndefined();
    expect(first.decision?.verdict).toBe("pending");
    for (const offset of [6, 24]) {
      await hand(path, offset);
      expect((await decide(path, offset)).code).toBe(0);
    }
    expect(watchOf(path).verdict).toMatchObject({ verdict: "inconclusive", act: false });
    expect(watchOf(path).verdict?.reason).toContain("the acceptance check was inconclusive: no test-account credential");
  });

  it("refuses a second --acceptance with exit 4 and writes nothing", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await decide(path, 1, passing());
    await hand(path, 6);
    const before = readFileSync(path, "utf8");
    const ran = await decide(path, 6, passing());
    expect(ran.code).toBe(4);
    expect(ran.stderr).toContain("already recorded at +1h; later check-ins do not repeat it");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("judges a later check-in with the stored results: a stored not-verifiable still verifies", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await decide(path, 1, acceptance([{ criterion: "exports CSV", result: "not-verifiable" }]));
    await hand(path, 6);
    await decide(path, 6);
    await hand(path, 24);
    expect((await decide(path, 24)).code).toBe(0);
    const watch = watchOf(path);
    expect(watch.verdict?.verdict).toBe("verified");
    expect(watch.checkIns[1]!.result!.acceptance).toBeUndefined();
    expect(watch.checkIns[2]!.result!.acceptance).toBeUndefined();
  });

  it("judges a later check-in with a stored failed criterion", async () => {
    const path = await watchStore();
    await hand(path, 1, { reachable: false, issues: [], why: "Sentry answered 503" });
    await decide(path, 1, acceptance([{ criterion: "logs in", result: "failed", evidence: "shots/login.png" }]));
    // Blind at +1h, so recorded inconclusive; the stored failure still files a ticket at +6h.
    await hand(path, 6);
    await decide(path, 6);
    expect(watchOf(path).verdict?.verdict).toBe("ticket");
  });

  it("downgrades a final verified to inconclusive when it never ran", async () => {
    const path = await watchStore();
    await hand(path, 24);
    expect((await decide(path, 24)).code).toBe(0);
    expect(watchOf(path).verdict).toMatchObject({ verdict: "inconclusive", act: false });
    expect(watchOf(path).verdict?.reason).toContain("the acceptance check never ran");
  });

  it("leaves an early check-in without it pending, still due at the next", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await decide(path, 1);
    expect(watchOf(path).checkIns[0]!.result!.decision?.verdict).toBe("pending");
    await hand(path, 6);
    const shown = await run(["show", caseOf(6)], deps(path));
    expect(shown.stdout).toContain("acceptance: due at this check-in");
    expect(shown.stdout).toContain("--acceptance");
  });

  it("show prints the recorded check per criterion, and acceptanceDue false at a later check-in", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await decide(path, 1, acceptance([
      { criterion: "logs in", result: "passed", evidence: "shots/login.png" },
      { criterion: "exports CSV", result: "not-verifiable" },
      { criterion: "saves draft", result: "passed", evidence: "shots/draft.png" },
    ]));
    await hand(path, 6);
    const shown = await run(["show", caseOf(6)], deps(path));
    expect(shown.stdout).toContain("acceptance: recorded at +1h — 2 passed, 1 not-verifiable");
    expect(shown.stdout).toContain("  - passed: logs in (evidence: shots/login.png)");
    expect(shown.stdout).toContain("  - not-verifiable: exports CSV");
    const json = await run(["show", caseOf(6), "--json"], deps(path));
    expect(JSON.parse(json.stdout).acceptanceDue).toBe(false);
  });

  it("show prints an inconclusive check with its reason", async () => {
    const path = await watchStore();
    await hand(path, 1);
    await decide(path, 1, acceptance({ inconclusive: "sign-in failed" }));
    await hand(path, 6);
    const shown = await run(["show", caseOf(6)], deps(path));
    expect(shown.stdout).toContain("acceptance: inconclusive at +1h — sign-in failed");
  });
});

describe("show", () => {
  it("prints the issues and the traffic, and --json parses", async () => {
    const path = await watchStore();
    await hand(path, 1, { reachable: true, issues: [regression()] }, someTraffic(9));
    const ran = await run(["show", caseOf(1)], deps(path));
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("TypeError: thing is undefined");
    expect(ran.stdout).toContain("traffic: reachable, 9 hits");
    expect(ran.stdout).toContain("decided: not yet");
    const json = await run(["show", caseOf(1), "--json"], deps(path));
    expect(JSON.parse(json.stdout)).toMatchObject({ watch: { pr: PR }, checkIn: { offsetHours: 1 }, acceptanceDue: true });
  });

  it("exits 3 with no evidence", async () => {
    const path = await watchStore();
    expect((await run(["show", caseOf(1)], deps(path))).code).toBe(3);
  });
});

describe("the CLI", () => {
  it("decides the case in RALPH_INTAKE_CASE from the project's config and git store", async () => {
    const project = tempDir("ralph-verifier-checkin-project-");
    cpSync(FIXTURE, join(project, ".ralph"), { recursive: true });
    const config = JSON.parse(readFileSync(join(FIXTURE, "config.json"), "utf8"));
    writeFileSync(join(project, ".ralph", "config.json"), JSON.stringify({
      ...config,
      loops: [...config.loops, { name: "sent", role: "verifier" }],
      verifier: { productionUrl: "https://loggd.app", deploy: { source: "vercel", project: "prj_loggd" }, sentry: { org: "loggd", project: "web" } },
    }));
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    const path = join(project, ".git", STORE_RELATIVE_PATH);
    await withStore(path, (store) => {
      openWatches(store, [{
        pr: PR, ticket: 184, ticketRef: "#184", mergeCommit: "m12", mergedAt: "2026-10-01T11:50:00.000Z",
        deployId: "dpl_1", deployedAt: DEPLOYED_AT, deployUrl: null, mode: "observe",
      }], [1, 6, 24], new Date(DEPLOYED_AT));
    });
    await hand(path, 1);

    const ran = spawnSync(BUN, [CLI, "decide"], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, RALPH_PROJECT: project, RALPH_INTAKE_CASE: caseOf(1) },
    });
    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toMatch(new RegExp(`^verifier-checkin: PR #${PR} \\+1h → `));
    expect(watchOf(path).checkIns[0]!.result!.decision).not.toBeNull();
  });
});
