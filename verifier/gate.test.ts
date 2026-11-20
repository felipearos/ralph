// @vitest-environment node
/**
 * The verifier's gate contract (felipearos/ralph#561): the lines `ralph.sh`
 * reads, the `--once` verdict, and the blocking wait that honours the control
 * inbox and a supervisor that is gone, against loggd's fixture with a
 * verifier rostered beside its loops. And the watches it opens
 * (felipearos/ralph#563): one per qualifying merged PR whose production
 * deploy landed, once, with no write to the tracker. And the check-ins it
 * hands over (felipearos/ralph#565): leased to one gate, with the evidence it
 * gathered stored on the check-in before the case is answered.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeInboxCommand } from "../control-inbox";
import { parseProjectConfig, verifierRules, type VerifierMode, type VerifierRules } from "../project-config";
import type { PushInput } from "../push-notification";
import { subprocessSuite } from "../test-timeouts";
import { createFakeTracker, type FakeIssue } from "../tracker/fake";
import { run as runCheckin } from "./checkin";
import type { Fetch } from "./credentials";
import { vercelLandedDeploy, type Gh, type LandedDeploy } from "./deploys";
import type { ActDeps } from "./act";
import { CONTROL_PENDING_LINE, DISABLED_WHY, parseCase, poll, verdictLine, waitingLine, type PollDeps } from "./gate";
import type { Git } from "./revert";
import type { GatheredHealth, GatheredTraffic } from "./sentry";
import type { SentryIssue } from "./verdict";
import { openWatches, readStore, STORE_RELATIVE_PATH, withStore, type Holder } from "./watches";

subprocessSuite("runs verifier/gate.ts through bun, git and a bash gh shim");

const HOME = join(__dirname, "..");
const GATE = join(HOME, "verifier", "gate.ts");
const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;
const FIXTURE = join(HOME, "fixtures", "loggd", ".ralph");

const VERIFIER = {
  productionUrl: "https://loggd.app",
  deploy: { source: "vercel", project: "prj_loggd" },
  sentry: { org: "loggd", project: "web" },
};

/** Loggd's fixture config with a verifier on the roster and its block. */
function watchedConfig(): Record<string, unknown> {
  const config = JSON.parse(readFileSync(join(FIXTURE, "config.json"), "utf8"));
  return { ...config, loops: [...config.loops, { name: "sent", role: "verifier" }], verifier: VERIFIER };
}

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const gitIn = (cwd: string, ...args: string[]): void => {
  const out = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
};

/**
 * A temp worktree carrying loggd's `.ralph/`, its config replaced by
 * `config`. The config is also pushed to a bare origin beside it, because the
 * gate reads its rules from `origin/main` every poll (#788).
 */
function watchedProject(config: Record<string, unknown> = watchedConfig()): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-verifier-gate-"));
  roots.push(root, `${root}-origin.git`);
  gitIn(tmpdir(), "init", "-q", "--bare", "-b", "main", `${root}-origin.git`);
  gitIn(tmpdir(), "init", "-q", "-b", "main", root);
  gitIn(root, "remote", "add", "origin", `${root}-origin.git`);
  cpSync(FIXTURE, join(root, ".ralph"), { recursive: true });
  writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(config));
  gitIn(root, "add", "-A", ".ralph");
  gitIn(root, "commit", "-q", "-m", "rules");
  gitIn(root, "push", "-q", "origin", "HEAD:main");
  return root;
}

// The host's own Vercel and Sentry tokens, if it has them, must not reach a test gate.
const gateEnv = (project: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  RALPH_PROJECT: project,
  RALPH_LOOP_NAME: "sent",
  // The fixture's branch, whatever loop this suite runs under.
  RALPH_BASE_BRANCH: "main",
  RALPH_VERIFIER_VERCEL_TOKEN: "",
  RALPH_VERIFIER_SENTRY_TOKEN: "",
  ...extra,
});

const RULES = verifierRules(parseProjectConfig(JSON.stringify(watchedConfig())))!;

describe("the lines the supervisor reads", () => {
  // `ralph.sh`'s two patterns, verbatim.
  const CASE_LINE = /^[A-Za-z0-9_.-]+: work available — (.*)$/;
  const CONTROL_LINE = /^[A-Za-z0-9_.-]+: control command waiting/;

  it("never read as a case when there is none", () => {
    const line = verdictLine({ work: false, why: "nothing merged" });
    expect(line).toBe("verifier-gate: nothing to do — nothing merged");
    expect(CASE_LINE.test(line)).toBe(false);
  });

  it("carry a case the supervisor can read off them", () => {
    expect(CASE_LINE.exec(verdictLine({ work: true, why: "1 check-in due" }))?.[1]).toBe("1 check-in due");
  });

  it("hand back to the control checkpoint in the shape ralph.sh matches", () => {
    expect(CONTROL_LINE.test(CONTROL_PENDING_LINE)).toBe(true);
    expect(CASE_LINE.test(CONTROL_PENDING_LINE)).toBe(false);
  });

  it("prove an idle verifier is alive rather than dead", () => {
    const now = Date.parse("2026-10-29T10:00:00Z");
    const line = waitingLine(
      { work: false, why: "nothing merged" },
      { poll: 3, waitingSince: new Date(now - 900_000), now: new Date(now), waitSeconds: 300 },
    );
    expect(line).toBe("verifier-gate: nothing merged at 2026-10-29T10:00:00Z — waiting 300s (poll 3, idle 15m)");
    expect(CASE_LINE.test(line)).toBe(false);
  });
});

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-29T10:00:00Z");

interface MergedRow {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  mergeCommit: { oid: string };
  mergedAt: string;
  labels: { name: string }[];
  closingIssuesReferences: { number: number }[];
}

const merged = (number: number, ticket: number, sha: string, mergedAt: number, over: Partial<MergedRow> = {}): MergedRow => ({
  number,
  title: `feat: change ${number} (#${ticket})`,
  body: `Closes #${ticket}`,
  headRefName: `felipe/${ticket}`,
  mergeCommit: { oid: sha },
  mergedAt: new Date(mergedAt).toISOString(),
  labels: [],
  closingIssuesReferences: [{ number: ticket }],
  ...over,
});

/** A stateful in-memory GitHub: merged PRs, their changed files, and which commits contain which. */
function hub() {
  const state = {
    prs: [] as MergedRow[],
    files: new Map<number, string[]>(),
    contains: new Map<string, string>(),
    calls: [] as string[][],
    listFails: false,
    viewFails: false,
    /** PRs whose files cannot be read, beside `viewFails` for all of them. */
    viewFailsFor: new Set<number>(),
    /** Act mode (#568): PRs on a `verifier/revert-<n>` branch, as `pr list --head` lists them. */
    revertPrs: [] as { number: number; state: string; url: string }[],
    /** What each `pr create` body file held when gh ran. */
    createdBodies: [] as string[],
    nextPr: 900,
    /** How an opened revert PR's state, checks and mergeability read. */
    status: { state: "OPEN", rollup: [] as unknown[], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  };
  const gh: Gh = async (args) => {
    state.calls.push(args);
    const json = args.includes("--json") ? args[args.indexOf("--json") + 1] : undefined;
    if (args[0] === "pr" && args[1] === "list" && args.includes("--head")) {
      return { ok: true, stdout: JSON.stringify(state.revertPrs), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && json === "title,body") {
      const row = state.prs.find((pr) => pr.number === Number(args[2]));
      return { ok: true, stdout: JSON.stringify({ title: row?.title ?? "", body: row?.body ?? "" }), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && json?.includes("mergeStateStatus")) {
      const { state: prState, rollup, mergeable, mergeStateStatus } = state.status;
      const answer = { state: prState, mergedAt: null, labels: [], headRefOid: "r1", statusCheckRollup: rollup, mergeable, mergeStateStatus };
      return { ok: true, stdout: JSON.stringify(answer), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "create") {
      state.createdBodies.push(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8"));
      const number = state.nextPr++;
      const url = `https://github.com/felipearos/loggd/pull/${number}`;
      state.revertPrs.unshift({ number, state: "OPEN", url });
      return { ok: true, stdout: `${url}\n`, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "merge") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") {
      if (state.listFails) return { ok: false, stdout: "", stderr: "HTTP 502: Bad Gateway" };
      return { ok: true, stdout: JSON.stringify(state.prs), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("files")) {
      if (state.viewFails || state.viewFailsFor.has(Number(args[2]))) return { ok: false, stdout: "", stderr: "HTTP 404: Not Found\nmore detail" };
      const files = state.files.get(Number(args[2])) ?? [];
      return { ok: true, stdout: files.map((f) => `${f}\n`).join(""), stderr: "" };
    }
    const compare = args[0] === "api" ? /compare\/(.+)\.\.\.(.+)$/.exec(args[1] ?? "") : null;
    if (compare !== null) {
      const status = state.contains.get(`${compare[1]}...${compare[2]}`) ?? "diverged";
      return { ok: true, stdout: `${status}\n`, stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { state, gh };
}

/** A fake Vercel answering with whatever deploy list (or failure) the test holds. */
function vercel() {
  const state = { deployments: [] as unknown[], status: 200, throws: false };
  const fetcher: Fetch = async () => {
    if (state.throws) throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify({ deployments: state.deployments }), { status: state.status });
  };
  return { state, fetcher };
}

const deployment = (uid: string, sha: string, at: number) => ({ uid, url: `${uid}.vercel.app`, created: at, ready: at, meta: { githubCommitSha: sha } });

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-verifier-store-"));
  roots.push(dir);
  return join(dir, "verifier-watches.json");
}

/** A fake Sentry recording what it was asked, answering the health it holds. */
function sentry() {
  const state = {
    calls: [] as { deployedAt: string; now: Date; routes: string[] }[],
    health: { reachable: true, issues: [] } as GatheredHealth,
    traffic: { reachable: true, hits: 42 } as GatheredTraffic,
  };
  const reader: PollDeps["sentry"] = {
    read: async (q) => {
      state.calls.push(q);
      return { health: state.health, traffic: state.traffic };
    },
  };
  return { state, reader };
}

const HOLDER: Holder = { run: "run-1", loop: "sent", pid: 4242, host: "test-host" };

function deps(gh: Gh, fetcher: Fetch, clock: { now: number }, storePath = storeDir(), over: Partial<PollDeps> = {}): PollDeps {
  const deploy = RULES.deploy as Extract<PollDeps["rules"]["deploy"], { source: "vercel" }>;
  return {
    rules: RULES,
    gh,
    landed: { read: vercelLandedDeploy(deploy, "tok", fetcher, async (a, d) => {
      if (a === d) return true;
      const ran = await gh(["api", `repos/{owner}/{repo}/compare/${a}...${d}`, "--jq", ".status"]);
      const status = ran.stdout.trim();
      return status === "identical" || status === "ahead";
    }) },
    storePath,
    now: () => new Date(clock.now),
    baseBranch: "main",
    tracker: { kind: "github" },
    roster: [{ name: "ralph", role: "coder" }],
    holder: HOLDER,
    alive: () => true,
    sentry: sentry().reader,
    reporter: { tracker: null, why: "no tracker in this test" },
    repoSlug: "felipearos/loggd",
    ...over,
  };
}

describe("the gate opening watches", () => {
  it("opens exactly one watch for a merged PR whose deploy landed, check-ins from the deploy", async () => {
    const { state, gh } = hub();
    const v = vercel();
    state.prs = [merged(12, 184, "m12", T0)];
    v.state.deployments = [deployment("dpl_1", "m12", T0 + 10 * 60_000)];
    const d = deps(gh, v.fetcher, { now: T0 + HOUR });
    const verdict = await poll(d);
    expect(verdict).toEqual({
      work: false,
      why: "opened 1 watch: PR #12 (#184) check-ins 2026-10-29T11:10:00Z, 2026-10-29T16:10:00Z, 2026-10-30T10:10:00Z; "
        + "next check-in +1h of PR #12 at 2026-10-29T11:10:00Z",
    });
    const watches = readStore(d.storePath).watches;
    expect(Object.keys(watches)).toEqual(["12"]);
    expect(watches["12"]).toMatchObject({
      pr: 12, ticket: 184, ticketRef: "#184", mergeCommit: "m12", deployId: "dpl_1", deployUrl: "dpl_1.vercel.app",
      deployedAt: "2026-10-29T10:10:00.000Z", mode: "observe", round: 1, lineage: [],
    });
    expect(watches["12"]!.checkIns.map((c) => c.offsetHours)).toEqual([1, 6, 24]);
  });

  it("waits for the deploy, then opens via a later commit's deploy that contains the merge", async () => {
    const { state, gh } = hub();
    const v = vercel();
    const clock = { now: T0 + HOUR };
    state.prs = [merged(15, 190, "m15", T0)];
    const d = deps(gh, v.fetcher, clock);
    expect(await poll(d)).toEqual({ work: false, why: "1 merged PR awaits its production deploy (#15)" });
    expect(readStore(d.storePath).watches).toEqual({});

    v.state.deployments = [deployment("dpl_2", "later", T0 + 2 * HOUR)];
    state.contains.set("m15...later", "ahead");
    // Before its first check-in is due, which would be handed over instead.
    clock.now = T0 + 2.5 * HOUR;
    expect((await poll(d)).why).toMatch(/^opened 1 watch: PR #15 \(#190\) check-ins 2026-10-29T13:00:00Z/);
    expect(readStore(d.storePath).watches["15"]?.deployId).toBe("dpl_2");
  });

  it("never opens a second watch for the same PR", async () => {
    const { state, gh } = hub();
    const v = vercel();
    state.prs = [merged(12, 184, "m12", T0)];
    v.state.deployments = [deployment("dpl_1", "m12", T0 + 60_000)];
    const d = deps(gh, v.fetcher, { now: T0 + HOUR });
    await poll(d);
    const first = readStore(d.storePath).watches["12"];
    const again = await poll(d);
    expect(again).toEqual({
      work: false,
      why: "every qualifying PR merged in the last 24h is already watched; next check-in +1h of PR #12 at 2026-10-29T11:01:00Z",
    });
    expect(readStore(d.storePath).watches).toEqual({ "12": first });
  });

  it("names the skipped PRs when nothing qualifies", async () => {
    const { state, gh } = hub();
    state.prs = [
      merged(20, 1, "a", T0, { title: "chore(ralph): journal loggd #1" }),
      merged(21, 2, "b", T0, { body: "no ticket", closingIssuesReferences: [] }),
      merged(22, 3, "c", T0 - 48 * HOUR),
    ];
    expect(await poll(deps(gh, vercel().fetcher, { now: T0 + HOUR }))).toEqual({
      work: false,
      why: "nothing merged in the last 24h qualifies (2 skipped: PR #20 is a journal or learnings commit; PR #21 closes no tracker ticket)",
    });
  });

  it("opens nothing on a Vercel 500 or a thrown fetch, and says why", async () => {
    const { state, gh } = hub();
    const v = vercel();
    state.prs = [merged(12, 184, "m12", T0)];
    v.state.status = 500;
    const d = deps(gh, v.fetcher, { now: T0 + HOUR });
    const failed = await poll(d);
    expect(failed.work).toBe(false);
    expect(failed.why).toBe("deploy source unavailable for PR #12: Vercel answered 500 listing deployments of prj_loggd");
    v.state.throws = true;
    expect((await poll(d)).why).toContain("Vercel could not be reached: connect ECONNREFUSED");
    expect(readStore(d.storePath).watches).toEqual({});
  });

  it("still opens the PRs whose deploy can be read when another's cannot", async () => {
    const { state, gh } = hub();
    state.prs = [merged(12, 184, "m12", T0), merged(13, 185, "m13", T0)];
    const landed = async (sha: string): Promise<LandedDeploy> =>
      sha === "m12" ? { kind: "landed", id: "d", url: null, deployedAt: new Date(T0 + HOUR / 2).toISOString() } : { kind: "unavailable", why: "boom" };
    const d = { ...deps(gh, vercel().fetcher, { now: T0 + HOUR }), landed: { read: landed } };
    expect((await poll(d)).why).toMatch(/^opened 1 watch: PR #12 .*; deploy source unavailable for PR #13: boom; next check-in \+1h of PR #12 at 2026-10-29T11:30:00Z$/);
  });

  it("is idle with the reason when gh, the store or the source fails, and never throws", async () => {
    const { state, gh } = hub();
    state.listFails = true;
    expect(await poll(deps(gh, vercel().fetcher, { now: T0 }))).toEqual({ work: false, why: "gh pr list failed: HTTP 502: Bad Gateway" });

    const ok = hub();
    ok.state.prs = [merged(12, 184, "m12", T0)];
    const v = vercel();
    v.state.deployments = [deployment("dpl_1", "m12", T0)];
    const storePath = storeDir();
    writeFileSync(storePath, "{not json");
    const unreadable = await poll(deps(ok.gh, v.fetcher, { now: T0 + HOUR }, storePath));
    expect(unreadable.work).toBe(false);
    expect(unreadable.why).toMatch(/^could not open watches: the verifier watch store .* is unreadable/);
    expect(readFileSync(storePath, "utf8")).toBe("{not json");

    const none = { ...deps(gh, v.fetcher, { now: T0 }), landed: { read: null, why: "no token" } };
    expect(await poll(none)).toEqual({ work: false, why: "no token" });
    const throwing = { ...deps(ok.gh, v.fetcher, { now: T0 }), now: () => { throw new Error("clock"); } };
    expect(await poll(throwing)).toEqual({ work: false, why: "the poll failed: clock" });
  });

  it("only reads GitHub: the tracker gets no writes", async () => {
    const { state, gh } = hub();
    const v = vercel();
    state.prs = [merged(12, 184, "m12", T0), merged(13, 185, "m13", T0)];
    v.state.deployments = [deployment("dpl_1", "later", T0 + 60_000)];
    state.contains.set("m12...later", "ahead");
    state.contains.set("m13...later", "identical");
    const d = deps(gh, v.fetcher, { now: T0 + HOUR });
    await poll(d);
    await poll(d);
    expect(Object.keys(readStore(d.storePath).watches).sort()).toEqual(["12", "13"]);
    for (const call of state.calls) {
      const read = (call[0] === "pr" && (call[1] === "list" || call[1] === "view")) || (call[0] === "api" && /\/compare\//.test(call[1] ?? "") && !call.includes("-X"));
      expect(read, call.join(" ")).toBe(true);
    }
  });
});

describe("the gate handing over due check-ins", () => {
  /** PR #12 merged and deployed at T0, so its +1h check-in is due at T0+1h. */
  function landedAtT0(over: Partial<PollDeps> = {}, storePath = storeDir()) {
    const h = hub();
    const v = vercel();
    const s = sentry();
    h.state.prs = [merged(12, 184, "m12", T0)];
    h.state.files.set(12, ["app/settings/page.tsx", "lib/x.ts"]);
    v.state.deployments = [deployment("dpl_1", "m12", T0)];
    const clock = { now: T0 + HOUR };
    const d = deps(h.gh, v.fetcher, clock, storePath, { sentry: s.reader, ...over });
    return { h, v, s, clock, d };
  }

  const CASE = "verifier check-in +1h of PR #12 (#184), deploy dpl_1";

  it("leases a due check-in, stores its evidence, and hands over the case in the poll that opened its watch", async () => {
    const { s, d } = landedAtT0();
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    expect(parseCase(CASE)).toEqual({ pr: 12, offsetHours: 1 });
    const store = readStore(d.storePath);
    expect(store.leases["12@1"]).toMatchObject({ run: "run-1", loop: "sent", pid: 4242, host: "test-host" });
    expect(store.watches["12"]!.checkIns[0]!.result).toEqual({
      handedOverAt: new Date(T0 + HOUR).toISOString(),
      decision: null,
      evidence: {
        gatheredAt: new Date(T0 + HOUR).toISOString(),
        health: { reachable: true, issues: [] },
        traffic: { reachable: true, hits: 42 },
        pr: { number: 12, files: ["app/settings/page.tsx", "lib/x.ts"], routes: ["/settings"] },
        otherPrs: [],
      },
    });
    expect(s.state.calls).toEqual([{ deployedAt: new Date(T0).toISOString(), now: new Date(T0 + HOUR), routes: ["/settings"] }]);
  });

  it("parses fractional offsets and refuses any other text", () => {
    expect(parseCase("verifier check-in +0.5h of PR #7 (OA-410), deploy dpl_x")).toEqual({ pr: 7, offsetHours: 0.5 });
    expect(parseCase("1 check-in due")).toBeNull();
  });

  it("is idle before the first check-in is due, naming when it is, with no lease and no Sentry read", async () => {
    const { s, clock, d } = landedAtT0();
    clock.now = T0 + HOUR / 2;
    const verdict = await poll(d);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toMatch(/^opened 1 watch: .*; next check-in \+1h of PR #12 at 2026-10-29T11:00:00Z$/);
    expect(s.state.calls).toEqual([]);
    expect(readStore(d.storePath).leases).toEqual({});
  });

  it("hands one check-in to exactly one of two racing gates", async () => {
    const { d } = landedAtT0();
    // The watch is opened first, so the race is on the check-in alone.
    const opener = { ...d, holder: { ...HOLDER, run: "run-0" }, now: () => new Date(T0 + HOUR / 2) };
    await poll(opener);
    const a = { ...d, holder: { ...HOLDER, run: "run-a" } };
    const b = { ...d, holder: { ...HOLDER, run: "run-b" } };
    const [va, vb] = await Promise.all([poll(a), poll(b)]);
    expect([va.work, vb.work].filter(Boolean)).toHaveLength(1);
    const winner = va.work ? "run-a" : "run-b";
    expect(readStore(d.storePath).leases["12@1"]?.run).toBe(winner);
    const loser = va.work ? vb : va;
    expect(loser.why).toContain("1 due check-in held by another verifier");
  });

  it("skips a check-in another live holder has, and takes it once that lease expired", async () => {
    const { s, clock, d } = landedAtT0();
    clock.now = T0 + HOUR / 2;
    await poll(d);
    await withStore(d.storePath, (store) => {
      store.leases["12@1"] = { run: "other", loop: "sent2", pid: 1, host: "test-host", expiresAt: new Date(T0 + HOUR + 60_000).toISOString() };
    });
    clock.now = T0 + HOUR;
    const held = await poll(d);
    expect(held.work).toBe(false);
    expect(held.why).toContain("1 due check-in held by another verifier");
    expect(s.state.calls).toEqual([]);
    expect(readStore(d.storePath).leases["12@1"]?.run).toBe("other");

    clock.now = T0 + HOUR + 60_000;
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    expect(readStore(d.storePath).leases["12@1"]?.run).toBe("run-1");
  });

  it("hands over with the unreachable evidence when Sentry cannot be read", async () => {
    const { s, d } = landedAtT0();
    s.state.health = { reachable: false, issues: [], why: "no Sentry token to read with" };
    s.state.traffic = { reachable: false, hits: 0, why: "no Sentry token to read with" };
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    const evidence = readStore(d.storePath).watches["12"]!.checkIns[0]!.result!.evidence;
    expect(evidence.health).toEqual({ reachable: false, issues: [], why: "no Sentry token to read with" });
    expect(evidence.traffic).toEqual({ reachable: false, hits: 0, why: "no Sentry token to read with" });
  });

  it("releases the lease and records nothing when the PR's files cannot be read", async () => {
    const { h, s, d } = landedAtT0();
    h.state.viewFails = true;
    expect(await poll(d)).toEqual({ work: false, why: "could not read PR #12's changed files: HTTP 404: Not Found" });
    const store = readStore(d.storePath);
    expect(store.watches["12"]!.checkIns[0]!.result).toBeNull();
    expect(store.leases).toEqual({});
    expect(s.state.calls).toEqual([]);
  });

  it("names the other PRs that shipped in the same deploy, with their files", async () => {
    const { h, v, d } = landedAtT0();
    h.state.prs.push(merged(13, 185, "m13", T0));
    h.state.files.set(13, ["src/app/(marketing)/pricing/page.tsx"]);
    v.state.deployments = [deployment("dpl_1", "later", T0)];
    h.state.contains.set("m12...later", "ahead");
    h.state.contains.set("m13...later", "ahead");
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    expect(readStore(d.storePath).watches["12"]!.checkIns[0]!.result!.evidence.otherPrs).toEqual([
      { number: 13, files: ["src/app/(marketing)/pricing/page.tsx"], routes: ["/pricing"] },
    ]);
  });

  it("counts an unwatched PR merged before the deploy as shipped with it, and not one merged after", async () => {
    const { h, d } = landedAtT0();
    // No ticket, so the verifier never watches them; they shipped (or not) all the same.
    const untracked = { body: "chore", title: "chore: tidy", closingIssuesReferences: [] };
    h.state.prs.push(merged(20, 0, "m20", T0 - 10 * 60_000, untracked));
    h.state.prs.push(merged(21, 0, "m21", T0 + 10 * 60_000, untracked));
    h.state.files.set(20, ["lib/x.ts"]);
    h.state.files.set(21, ["lib/x.ts"]);
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    const store = readStore(d.storePath);
    expect(Object.keys(store.watches)).toEqual(["12"]);
    expect(store.watches["12"]!.checkIns[0]!.result!.evidence.otherPrs).toEqual([{ number: 20, files: ["lib/x.ts"], routes: [] }]);
  });

  it("cannot attribute a check-in when the merged PRs cannot be listed for it", async () => {
    const { h, d } = landedAtT0();
    await poll({ ...d, now: () => new Date(T0 + HOUR / 2) });
    h.state.listFails = true;
    const verdict = await poll(d);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toBe("could not list the PRs merged before PR #12's deploy: gh pr list failed: HTTP 502: Bad Gateway");
    expect(readStore(d.storePath).leases).toEqual({});
  });

  it("dates the lease from when it is taken, not from the poll's start", async () => {
    const { h, clock, d } = landedAtT0();
    // Opening watches lists merged PRs first; let that take ten minutes.
    const slow: Gh = async (args) => {
      if (args[0] === "pr" && args[1] === "list" && clock.now === T0 + HOUR) clock.now += 10 * 60_000;
      return h.gh(args);
    };
    expect(await poll({ ...d, gh: slow })).toEqual({ work: true, why: CASE });
    expect(readStore(d.storePath).leases["12@1"]?.expiresAt).toBe(new Date(T0 + HOUR + 10 * 60_000 + 120_000).toISOString());
  });

  it("moves on to the next due check-in when one cannot be handed over", async () => {
    const { h, d } = landedAtT0();
    // An older watch, out of the merge window and so in no other PR's
    // deploy-mates: its check-in is due first, and its files cannot be read.
    await withStore(d.storePath, (store) => openWatches(store, [{
      pr: 14, ticket: 186, ticketRef: "#186", mergeCommit: "m14", mergedAt: new Date(T0 - 30 * HOUR).toISOString(),
      deployId: "dpl_0", deployedAt: new Date(T0 - 30 * HOUR).toISOString(), deployUrl: null, mode: "observe",
    }], RULES.checkIns, new Date(T0 - 30 * HOUR)));
    h.state.viewFailsFor.add(14);
    expect(await poll(d)).toEqual({ work: true, why: CASE });
    const store = readStore(d.storePath);
    expect(store.watches["14"]!.checkIns[0]!.result).toBeNull();
    expect(Object.keys(store.leases)).toEqual(["12@1"]);
  });

  it("fails with the first reason and the count when every due check-in fails", async () => {
    const { h, v, d } = landedAtT0();
    h.state.prs.push(merged(14, 186, "m14", T0));
    v.state.deployments = [deployment("dpl_1", "m12", T0), deployment("dpl_2", "m14", T0)];
    h.state.viewFails = true;
    expect(await poll(d)).toEqual({
      work: false,
      why: "could not read PR #12's changed files: HTTP 404: Not Found (2 due check-ins could not be handed over)",
    });
    expect(readStore(d.storePath).leases).toEqual({});
  });
});

describe("report mode", () => {
  const ACCEPTED = [{ criterion: "the settings page loads", result: "passed", evidence: "shots/settings.png" }];
  const GAP = [{ criterion: "saving a setting persists it", result: "failed", detail: "gone on reload", evidence: "shots/saved.png" }];
  const regression = (): SentryIssue => ({
    id: "S-1",
    title: "TypeError: thing is undefined",
    link: "https://sentry.io/issues/1",
    firstSeen: new Date(T0 + 10 * 60_000).toISOString(),
    preDeployRate: 0,
    postDeployRate: 4,
    frameFiles: ["lib/thing.ts"],
    routes: [],
    events: 20,
    distinctUsers: 3,
  });

  /**
   * PR #12 closing #184, deployed at T0 with one check-in at +1h, so its first
   * check-in is also its last and one decision ends the watch.
   */
  function scenario(
    mode: VerifierMode,
    issues: (Partial<FakeIssue> & { number: number })[] = [{ number: 184 }],
    act: (h: ReturnType<typeof hub>) => PollDeps["act"] = () => null,
  ) {
    const h = hub();
    const v = vercel();
    const s = sentry();
    const tracker = createFakeTracker({ issues });
    const pushes: PushInput[] = [];
    h.state.prs = [merged(12, 184, "m12", T0)];
    h.state.files.set(12, ["app/settings/page.tsx", "lib/thing.ts"]);
    v.state.deployments = [deployment("dpl_1", "m12", T0)];
    const clock = { now: T0 + HOUR };
    const rules: VerifierRules = { ...RULES, mode, checkIns: [1] };
    const d = deps(h.gh, v.fetcher, clock, storeDir(), {
      rules,
      sentry: s.reader,
      reporter: { tracker, push: (input) => void pushes.push(input) },
      act: act(h),
    });
    /** The session's `decide` on the case a poll handed over, in-process, as the check-in does it. */
    const decide = async (caseLine: string, acceptance?: unknown): Promise<void> => {
      const extra: string[] = [];
      if (acceptance !== undefined) {
        const file = join(mkdtempSync(join(tmpdir(), "ralph-verifier-acceptance-")), "acceptance.json");
        roots.push(join(file, ".."));
        writeFileSync(file, JSON.stringify(acceptance));
        extra.push("--acceptance", file);
      }
      const ran = await runCheckin(["decide", caseLine, ...extra], { storePath: d.storePath, rules, env: {}, now: () => new Date(clock.now) });
      expect(ran.code, ran.stderr).toBe(0);
    };
    const watch = (pr: number) => readStore(d.storePath).watches[String(pr)]!;
    const created = () => tracker.writes.filter((w) => w.startsWith("create"));
    return { h, v, s, tracker, pushes, clock, d, decide, watch, created };
  }

  /** The first poll: opens PR #12's watch and hands over its only check-in. */
  async function handedOver(sc: ReturnType<typeof scenario>): Promise<string> {
    const verdict = await poll(sc.d);
    expect(verdict.work, verdict.why).toBe(true);
    return verdict.why;
  }

  it("announces a watch the poll it opens, and settles a verified one on the next poll", async () => {
    const sc = scenario("report");
    const caseLine = await handedOver(sc);
    const ticket = sc.tracker.issues.get(184)!;
    expect(ticket.labels).toEqual(["following"]);
    expect(ticket.comments).toHaveLength(1);
    expect(sc.watch(12).reported.announcedAt).toBe(new Date(T0 + HOUR).toISOString());

    await sc.decide(caseLine, ACCEPTED);
    expect(sc.watch(12).verdict?.verdict).toBe("verified");
    sc.clock.now = T0 + 2 * HOUR;
    const settled = await poll(sc.d);
    expect(settled.why).toContain("reported PR #12: label+ #184 verified, comment #184, label- #184 following");
    expect(ticket.labels).toEqual(["verified"]);
    expect(ticket.comments).toHaveLength(2);
    expect(sc.watch(12).reported.settledAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
    // Settled: a later poll writes nothing more.
    const writes = sc.tracker.writes.length;
    await poll(sc.d);
    expect(sc.tracker.writes).toHaveLength(writes);
    expect(sc.pushes).toEqual([]);
  });

  it("switched off (#789), reads and writes nothing, and settles the decided watch once switched back on", async () => {
    const sc = scenario("report");
    const caseLine = await handedOver(sc);
    await sc.decide(caseLine, ACCEPTED);
    const writes = sc.tracker.writes.length;
    const ghCalls = sc.h.state.calls.length;
    const sentryCalls = sc.s.state.calls.length;
    // A new merge lands while it is off: it must not be listed, let alone watched.
    sc.h.state.prs.push(merged(13, 190, "m13", T0 + HOUR));
    sc.v.state.deployments.push(deployment("dpl_2", "m13", T0 + HOUR));
    sc.clock.now = T0 + 2 * HOUR;

    const off = { ...sc.d, rules: { ...sc.d.rules, enabled: false } };
    const verdict = await poll(off);
    expect(verdict).toEqual({ work: false, why: DISABLED_WHY });
    expect(DISABLED_WHY).toMatch(/^disabled in config — /);
    expect(
      waitingLine(verdict, { poll: 2, waitingSince: new Date(T0 + HOUR), now: new Date(T0 + 2 * HOUR), waitSeconds: 300 }),
    ).toBe(`verifier-gate: ${DISABLED_WHY} at 2026-10-29T12:00:00Z — waiting 300s (poll 2, idle 1h00m)`);
    expect(sc.tracker.writes).toHaveLength(writes);
    expect(sc.pushes).toEqual([]);
    expect(sc.h.state.calls).toHaveLength(ghCalls);
    expect(sc.s.state.calls).toHaveLength(sentryCalls);
    expect(sc.watch(12).reported.settledAt ?? null).toBeNull();
    expect(Object.keys(readStore(sc.d.storePath).watches)).toEqual(["12"]);

    // Back on: the very next poll does what the off one held back.
    const on = await poll(sc.d);
    expect(on.why).toContain("reported PR #12: label+ #184 verified");
    expect(sc.watch(12).reported.settledAt).toBe(new Date(T0 + 2 * HOUR).toISOString());
  });

  it("files a fix ticket for an acceptance gap, and watches the fix as the chain's next round", async () => {
    const sc = scenario("report");
    await sc.decide(await handedOver(sc), GAP);
    expect(sc.watch(12).verdict?.verdict).toBe("ticket");
    sc.clock.now = T0 + 2 * HOUR;
    await poll(sc.d);
    const fix = sc.watch(12).reported.fixTicket!;
    const fixIssue = sc.tracker.issues.get(fix)!;
    expect(fixIssue.labels).toEqual(["ready-for-agent"]);
    expect(fixIssue.body).toContain("Root ticket: #184");
    expect(fixIssue.body).toContain("failure round 1");

    // The loops fix it: a merged PR closing the fix ticket opens round 2 of #184's chain.
    sc.h.state.prs.push(merged(13, fix, "m13", T0 + 2 * HOUR));
    sc.h.state.files.set(13, ["app/settings/page.tsx"]);
    sc.v.state.deployments.push(deployment("dpl_2", "m13", T0 + 2 * HOUR));
    sc.clock.now = T0 + 3 * HOUR;
    const second = await poll(sc.d);
    expect(second.work, second.why).toBe(true);
    expect(sc.watch(13)).toMatchObject({ ticket: fix, root: 184, round: 2, lineage: [184] });
    await sc.decide(second.why, GAP);
    expect(sc.watch(13).verdict?.verdict).toBe("ticket");
    sc.clock.now = T0 + 4 * HOUR;
    await poll(sc.d);
    const nextFix = sc.tracker.issues.get(sc.watch(13).reported.fixTicket!)!;
    expect(nextFix.body).toContain("Root ticket: #184");
    expect(nextFix.body).toContain("failure round 2");
    expect(sc.created()).toHaveLength(2);
    expect(sc.pushes).toEqual([]);
  });

  it("files a would-be revert as an urgent ticket and one push, and opens no pull request", async () => {
    const sc = scenario("report");
    sc.s.state.health = { reachable: true, issues: [regression()] };
    await sc.decide(await handedOver(sc), ACCEPTED);
    expect(sc.watch(12).verdict).toMatchObject({ verdict: "ticket" });
    sc.clock.now = T0 + 2 * HOUR;
    await poll(sc.d);
    await poll(sc.d);
    const fix = sc.tracker.issues.get(sc.watch(12).reported.fixTicket!)!;
    expect(fix.labels).toEqual(["ready-for-agent", "priority:urgent"]);
    expect(sc.created()).toHaveLength(1);
    expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
    for (const call of sc.h.state.calls) {
      const read = (call[0] === "pr" && (call[1] === "list" || call[1] === "view")) || (call[0] === "api" && /\/compare\//.test(call[1] ?? "") && !call.includes("-X"));
      expect(read, call.join(" ")).toBe(true);
    }
  });

  const THIRD_ROUND = [
    { number: 100, title: "Root" },
    { number: 184, body: "Fix it\n\n<!-- verifier-fix verifierfix11 root=100 round=2 lineage=100,150 -->" },
  ];

  it("stops a chain at its third failure: needs-human on the root, a summary, no ticket, one push", async () => {
    const sc = scenario("report", THIRD_ROUND);
    await sc.decide(await handedOver(sc), GAP);
    expect(sc.watch(12)).toMatchObject({ root: 100, round: 3, lineage: [100, 150] });
    expect(sc.watch(12).verdict?.verdict).toBe("needs-human");
    sc.clock.now = T0 + 2 * HOUR;
    await poll(sc.d);
    const root = sc.tracker.issues.get(100)!;
    expect(root.labels).toEqual(["needs-human"]);
    expect(root.comments).toHaveLength(1);
    expect(root.comments[0]!.body).toContain("Round 3: #184, PR #12");
    expect(sc.created()).toEqual([]);
    expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
  });

  it("observe mode writes nothing to the tracker and sends no push, whatever the verdict", async () => {
    const outcomes: string[] = [];
    const cases: [typeof THIRD_ROUND | { number: number }[], SentryIssue[], unknown][] = [
      [[{ number: 184 }], [], ACCEPTED],
      [[{ number: 184 }], [], GAP],
      [[{ number: 184 }], [regression()], ACCEPTED],
      [THIRD_ROUND, [], GAP],
    ];
    for (const [issues, seen, acceptance] of cases) {
      const sc = scenario("observe", issues);
      sc.s.state.health = { reachable: true, issues: seen };
      await sc.decide(await handedOver(sc), acceptance);
      sc.clock.now = T0 + 2 * HOUR;
      await poll(sc.d);
      outcomes.push(sc.watch(12).verdict!.verdict);
      expect(sc.tracker.writes).toEqual([]);
      expect(sc.pushes).toEqual([]);
      expect(sc.watch(12).reported).toEqual({});
    }
    expect(outcomes).toEqual(["verified", "ticket", "revert", "needs-human"]);
  });

  it("retries a tracker write that failed on the next poll, and lands it once", async () => {
    const sc = scenario("report");
    // Before the check-in is due, so the idle line carries the report's note.
    sc.clock.now = T0 + HOUR / 2;
    sc.tracker.failNext("comment", new Error("tracker down"));
    const failed = await poll(sc.d);
    expect(failed.why).toContain("report for PR #12 failed: announce: tracker down");
    expect(sc.watch(12).reported).toEqual({});
    const retried = await poll(sc.d);
    expect(retried.why).toContain("reported PR #12:");
    expect(sc.tracker.issues.get(184)!.comments).toHaveLength(1);
    expect(sc.watch(12).reported.announcedAt).toBeDefined();
  });

  it("holds a report-mode watch back while there is no tracker, and says so for one already open", async () => {
    const sc = scenario("report");
    sc.clock.now = T0 + HOUR / 2;
    const d = { ...sc.d, reporter: { tracker: null, why: "Linear is not connected" } as const };
    expect((await poll(d)).why).toContain("ticket unreadable, watch not opened yet for PR #12: tracker unavailable: Linear is not connected");
    expect(readStore(d.storePath).watches).toEqual({});

    await withStore(d.storePath, (store) => openWatches(store, [{
      pr: 12, ticket: 184, ticketRef: "#184", mergeCommit: "m12", mergedAt: new Date(T0).toISOString(),
      deployId: "dpl_1", deployedAt: new Date(T0).toISOString(), deployUrl: null, mode: "report",
    }], [1], new Date(T0)));
    expect((await poll(d)).why).toContain("tracker unavailable, nothing reported for PR #12: Linear is not connected");
  });

  it("leaves a report-mode PR unopened while its ticket cannot be read, rather than lose its chain", async () => {
    const sc = scenario("report", THIRD_ROUND);
    sc.clock.now = T0 + HOUR / 2;
    sc.tracker.failNext("issue", new Error("HTTP 502"));
    expect((await poll(sc.d)).why).toContain("ticket unreadable, watch not opened yet for PR #12: HTTP 502");
    expect(readStore(sc.d.storePath).watches).toEqual({});
    await poll(sc.d);
    expect(sc.watch(12)).toMatchObject({ root: 100, round: 3 });
  });

  it("opens an observe-mode watch at round 1 when its ticket cannot be read, or there is no tracker", async () => {
    const sc = scenario("observe", THIRD_ROUND);
    sc.clock.now = T0 + HOUR / 2;
    sc.tracker.failNext("issue", new Error("HTTP 502"));
    expect((await poll(sc.d)).why).toMatch(/^opened 1 watch: PR #12/);
    expect(sc.watch(12)).toMatchObject({ root: null, round: 1 });

    const none = scenario("observe", THIRD_ROUND);
    none.clock.now = T0 + HOUR / 2;
    await poll({ ...none.d, reporter: { tracker: null, why: "Linear is not connected" } });
    expect(none.watch(12)).toMatchObject({ root: null, round: 1 });
  });

  it("bounds a tracker call that never answers: the poll returns with a note", async () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => {});
    const hungRead = scenario("report");
    hungRead.clock.now = T0 + HOUR / 2;
    hungRead.tracker.issue = never;
    const read = await poll({ ...hungRead.d, trackerTimeoutMs: 20 });
    expect(read.why).toContain("ticket unreadable, watch not opened yet for PR #12: reading ticket 184 took longer than");

    const hungWrite = scenario("report");
    hungWrite.clock.now = T0 + HOUR / 2;
    // The comment write, not the comments read: `chainOf` reads comments before the watch opens.
    hungWrite.tracker.comment = never;
    const write = await poll({ ...hungWrite.d, trackerTimeoutMs: 20 });
    expect(write.why).toContain("report for PR #12 failed: the tracker writes took longer than");
    // The lease is released: the next poll may retry.
    expect(readStore(hungWrite.d.storePath).leases).toEqual({});
  });

  it("leaves a watch whose report another live verifier holds to that verifier", async () => {
    const sc = scenario("report");
    sc.clock.now = T0 + HOUR / 2;
    await withStore(sc.d.storePath, (store) => {
      store.leases["report@12"] = { run: "run-2", loop: "sent2", pid: 999, host: "test-host", expiresAt: new Date(T0 + 2 * HOUR).toISOString() };
    });
    await poll(sc.d);
    expect(sc.watch(12).reported).toEqual({});
    expect(sc.tracker.writes).toEqual([]);
    expect(readStore(sc.d.storePath).leases["report@12"]).toMatchObject({ run: "run-2" });
  });

  describe("act mode", () => {
    const LATER = "fedcba9876543210fedcba9876543210fedcba98";
    /** Answers `pushRevert`'s git steps in order; `conflict` fails the revert on one file. */
    function fakeGit(conflict = false): { git: Git; calls: string[][] } {
      const calls: string[][] = [];
      const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
      const git: Git = async (args) => {
        calls.push(args);
        switch (args[0]) {
          case "rev-list":
            return ok("m12 p1\n");
          case "revert":
            if (args[1] === "--abort") return ok();
            return conflict ? { ok: false, stdout: "", stderr: "CONFLICT (content): Merge conflict in lib/thing.ts" } : ok();
          case "diff":
            // `diff --cached --quiet` exits 1 when the revert staged something.
            if (args[1] === "--cached") return { ok: false, stdout: "", stderr: "" };
            return ok(conflict ? "lib/thing.ts\n" : "");
          case "log":
            return ok(`${LATER}\tfix: rename thing\n`);
          case "rev-parse":
            return ok("0123456789012345678901234567890123456789\n");
          default:
            return ok();
        }
      };
      return { git, calls };
    }

    /** PR #12 closed #184 when it merged; a regression after its deploy decides a revert. */
    async function actScenario(over: Partial<ActDeps> = {}, conflict = false) {
      const g = fakeGit(conflict);
      const sc = scenario("act", [{ number: 184, state: "closed", closedAt: new Date(T0).toISOString() }], (h) => ({
        gh: h.gh,
        git: g.git,
        repoRoot: "/nonexistent/loggd",
        baseBranch: "main",
        merge: "human",
        mergeCommand: null,
        requiredChecks: ["ci"],
        ...over,
      }));
      sc.s.state.health = { reachable: true, issues: [regression()] };
      return { ...sc, git: g };
    }
    async function decidedRevert(sc: Awaited<ReturnType<typeof actScenario>>): Promise<void> {
      await sc.decide(await handedOver(sc), ACCEPTED);
      expect(sc.watch(12).verdict).toMatchObject({ verdict: "revert", act: true });
      sc.clock.now = T0 + 2 * HOUR;
    }
    const creates = (calls: string[][]) => calls.filter((c) => c[0] === "pr" && c[1] === "create");
    const merges = (calls: string[][]) => calls.filter((c) => c[0] === "pr" && c[1] === "merge");

    it("opens one revert PR with the evidence, and reopens the root with it once the revert merged", async () => {
      const sc = await actScenario();
      await decidedRevert(sc);
      await poll(sc.d);
      await poll(sc.d);
      expect(creates(sc.h.state.calls)).toHaveLength(1);
      const body = sc.h.state.createdBodies[0]!;
      expect(body).toContain("TypeError: thing is undefined");
      expect(body).toContain("<!-- verifier revert pr=12 -->");
      expect(body).toContain("Reopens #184");
      // Not yet: the base still holds the broken change until the revert lands.
      expect(sc.tracker.issues.get(184)!.state).toBe("closed");
      expect(sc.watch(12).reported.settledAt).toBeUndefined();

      sc.h.state.status.state = "MERGED";
      sc.clock.now = T0 + 3 * HOUR;
      await poll(sc.d);
      const root = sc.tracker.issues.get(184)!;
      expect(root.state).toBe("open");
      expect(root.labels).toContain("ready-for-agent");
      expect(root.comments.some((c) => c.body.includes("<!-- verifier-reverted pr=12 root=184 round=1 lineage=184 -->") && c.body.includes("TypeError: thing is undefined"))).toBe(true);
      expect(sc.watch(12).reported).toMatchObject({ revertPr: 900, revertMerge: "merged", settledAt: new Date(T0 + 3 * HOUR).toISOString() });
    });

    it("keeps the round cap across a revert: the next PR closing the reopened root is watched at round 2", async () => {
      const sc = await actScenario();
      await decidedRevert(sc);
      await poll(sc.d);
      sc.h.state.status.state = "MERGED";
      sc.clock.now = T0 + 3 * HOUR;
      await poll(sc.d);
      expect(sc.tracker.issues.get(184)!.state).toBe("open");

      // The coders fix forward: a merged PR closing #184 again.
      sc.h.state.prs.push(merged(13, 184, "m13", T0 + 3 * HOUR));
      sc.h.state.files.set(13, ["lib/thing.ts"]);
      sc.v.state.deployments.push(deployment("dpl_2", "m13", T0 + 3 * HOUR));
      sc.clock.now = T0 + 4 * HOUR;
      const opened = await poll(sc.d);
      expect(opened.work, opened.why).toBe(true);
      expect(sc.watch(13)).toMatchObject({ ticket: 184, root: 184, round: 2, lineage: [184] });
    });

    it("only proposes the revert where a person merges: one alert, and no merge command ever", async () => {
      const sc = await actScenario({ merge: "human", mergeCommand: ["pr", "merge", "{pr}", "--squash"] });
      await decidedRevert(sc);
      for (let i = 0; i < 3; i++) await poll(sc.d);
      expect(creates(sc.h.state.calls)).toHaveLength(1);
      expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
      expect(merges(sc.h.state.calls)).toEqual([]);
      expect(sc.watch(12).reported.revertMerge).toBe("proposed");
      expect(sc.tracker.issues.get(184)!.state).toBe("closed");

      // A person merges it later: the root is reopened, still with no merge command run.
      sc.h.state.status.state = "MERGED";
      await poll(sc.d);
      expect(sc.tracker.issues.get(184)!.state).toBe("open");
      expect(sc.watch(12).reported).toMatchObject({ revertMerge: "merged" });
      expect(merges(sc.h.state.calls)).toEqual([]);
      expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
    });

    it("never reverts a revert: an urgent ticket and an alert instead", async () => {
      const sc = await actScenario();
      sc.h.state.prs[0]!.title = 'Revert "feat: change 7 (#150)"';
      await decidedRevert(sc);
      await poll(sc.d);
      expect(creates(sc.h.state.calls)).toEqual([]);
      expect(sc.git.calls).toEqual([]);
      const fix = sc.tracker.issues.get(sc.watch(12).reported.fixTicket!)!;
      expect(fix.labels).toContain("priority:urgent");
      expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
    });

    it("never reverts a PR twice: an existing revert PR makes a ticket naming it", async () => {
      const sc = await actScenario();
      sc.h.state.revertPrs = [{ number: 777, state: "OPEN", url: "https://github.com/felipearos/loggd/pull/777" }];
      await decidedRevert(sc);
      await poll(sc.d);
      expect(creates(sc.h.state.calls)).toEqual([]);
      const fix = sc.tracker.issues.get(sc.watch(12).reported.fixTicket!)!;
      expect(fix.labels).toContain("priority:urgent");
      expect(fix.body).toContain("https://github.com/felipearos/loggd/pull/777");
    });

    it("files an urgent ticket naming the commit in the way when the revert conflicts", async () => {
      const sc = await actScenario({}, true);
      await decidedRevert(sc);
      await poll(sc.d);
      expect(sc.git.calls.some((c) => c[0] === "push")).toBe(false);
      expect(creates(sc.h.state.calls)).toEqual([]);
      const fix = sc.tracker.issues.get(sc.watch(12).reported.fixTicket!)!;
      expect(fix.labels).toContain("priority:urgent");
      expect(fix.body).toContain(`${LATER.slice(0, 7)} fix: rename thing`);
      expect(fix.body).toContain("lib/thing.ts");
      expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
      expect(sc.tracker.issues.get(184)!.state).toBe("closed");
    });

    it("merges by the project's command once the revert PR is green and mergeable", async () => {
      const sc = await actScenario({ merge: "loop", mergeCommand: ["pr", "merge", "{pr}", "--squash"] });
      sc.h.state.status.rollup = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null }];
      await decidedRevert(sc);
      await poll(sc.d);
      expect(creates(sc.h.state.calls)).toHaveLength(1);
      expect(merges(sc.h.state.calls)).toEqual([]);
      expect(sc.watch(12).reported.settledAt).toBeUndefined();

      sc.h.state.status.rollup = [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }];
      sc.clock.now = T0 + 3 * HOUR;
      await poll(sc.d);
      await poll(sc.d);
      expect(merges(sc.h.state.calls)).toEqual([["pr", "merge", "900", "--squash"]]);
      expect(sc.watch(12).reported).toMatchObject({ revertMerge: "requested" });
      // Requested is not landed: the watch reads the PR's fate until it merges.
      expect(sc.watch(12).reported.settledAt).toBeUndefined();
      sc.h.state.status.state = "MERGED";
      await poll(sc.d);
      expect(merges(sc.h.state.calls)).toHaveLength(1);
      expect(sc.watch(12).reported).toMatchObject({ revertMerge: "merged" });
      expect(sc.watch(12).reported.settledAt).toBeDefined();
      expect(sc.tracker.issues.get(184)!.state).toBe("open");
    });

    it("without act deps writes report mode's would-be revert and opens no pull request", async () => {
      const sc = scenario("act");
      sc.s.state.health = { reachable: true, issues: [regression()] };
      await sc.decide(await handedOver(sc), ACCEPTED);
      sc.clock.now = T0 + 2 * HOUR;
      await poll(sc.d);
      expect(creates(sc.h.state.calls)).toEqual([]);
      const fix = sc.tracker.issues.get(sc.watch(12).reported.fixTicket!)!;
      expect(fix.labels).toEqual(["ready-for-agent", "priority:urgent"]);
      expect(sc.pushes.map((p) => p.kind)).toEqual(["verifier-alert"]);
    });
  });
});

/** A ticket as `gh issue view --json` answers it, with no fix-ticket chain in its body. */
const ISSUE_JSON = {
  number: 184, title: "A ticket", body: "", state: "OPEN", labels: [], assignees: [], author: null,
  url: "https://github.com/felipearos/loggd/issues/184", closedAt: null, stateReason: null, comments: [],
};

describe("the gate CLI", () => {
  it("exits 1 on --once with the reason, which names the missing Vercel token", () => {
    const project = watchedProject();
    const run = spawnSync(BUN, [GATE, "--once"], { cwd: project, encoding: "utf8", env: gateEnv(project) });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toBe(
      "verifier-gate: nothing to do — no Vercel token — RALPH_VERIFIER_VERCEL_TOKEN is not set, so no deploy can be confirmed",
    );
  });

  it("opens a watch on --once against a gh shim and a local Vercel, in the project's git dir", async () => {
    const project = watchedProject();
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    const now = Date.now();
    const pr = merged(41, 184, "m41", now - HOUR);
    const bin = mkdtempSync(join(tmpdir(), "ralph-verifier-bin-"));
    roots.push(bin);
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pr.json"), JSON.stringify([pr]));
    writeFileSync(join(bin, "issue.json"), JSON.stringify(ISSUE_JSON));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'case "$1" in',
        `  pr) cat ${JSON.stringify(join(bin, "pr.json"))} ;;`,
        // The gate reads the ticket for a fix-ticket chain; this one starts none.
        `  issue) cat ${JSON.stringify(join(bin, "issue.json"))} ;;`,
        '  api) case "$2" in *compare/m41...later*) echo ahead ;; *) echo identical ;; esac ;;',
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);

    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ deployments: [deployment("dpl_cli", "later", now - 30 * 60_000)] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const child = spawn(BUN, [GATE, "--once"], {
        cwd: project,
        env: gateEnv(project, {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RALPH_VERIFIER_VERCEL_TOKEN: "test",
          RALPH_VERIFIER_VERCEL_API: `http://127.0.0.1:${port}`,
          RALPH_BASE_BRANCH: "main",
          GIT_DIR: join(project, ".git"),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(err).toBe("");
      expect(code).toBe(1);
      expect(out.trim()).toMatch(/^verifier-gate: nothing to do — opened 1 watch: PR #41 \(#184\) check-ins /);
    } finally {
      server.close();
    }
    const storePath = join(project, ".git", STORE_RELATIVE_PATH);
    expect(existsSync(storePath)).toBe(true);
    expect(readStore(storePath).watches["41"]?.deployId).toBe("dpl_cli");
  });

  /** A github-deployments project, a gh shim serving `deployments` as given, and the gate's --once run. */
  async function githubDeploymentsOnce(deployments: string): Promise<{ project: string; code: number | null; out: string; err: string }> {
    const { verifier, ...rest } = watchedConfig();
    const project = watchedProject({ ...rest, verifier: { ...(verifier as typeof VERIFIER), deploy: { source: "github-deployments" } } });
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    const now = Date.now();
    const bin = mkdtempSync(join(tmpdir(), "ralph-verifier-bin-"));
    roots.push(bin);
    writeFileSync(join(bin, "pr.json"), JSON.stringify([merged(41, 184, "m41", now - HOUR)]));
    writeFileSync(join(bin, "issue.json"), JSON.stringify(ISSUE_JSON));
    writeFileSync(
      join(bin, "statuses.json"),
      JSON.stringify([{ state: "success", created_at: new Date(now - 25 * 60_000).toISOString(), environment_url: "https://loggd.app" }]),
    );
    writeFileSync(
      join(bin, "deployments.json"),
      JSON.stringify([{ id: 9001, sha: "later", environment: "production", created_at: new Date(now - 30 * 60_000).toISOString() }]),
    );
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'case "$1" in',
        `  pr) cat ${JSON.stringify(join(bin, "pr.json"))} ;;`,
        `  issue) cat ${JSON.stringify(join(bin, "issue.json"))} ;;`,
        // The statuses path also contains "deployments", so it is matched first.
        '  api) case "$2" in',
        `    *deployments/9001/statuses*) cat ${JSON.stringify(join(bin, "statuses.json"))} ;;`,
        `    *deployments?*) ${deployments.replace("{list}", JSON.stringify(join(bin, "deployments.json")))} ;;`,
        "    *compare/m41...later*) echo ahead ;;",
        "    *) echo identical ;;",
        "  esac ;;",
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);
    const child = spawn(BUN, [GATE, "--once"], {
      cwd: project,
      env: gateEnv(project, { PATH: `${bin}:${process.env.PATH ?? ""}`, RALPH_BASE_BRANCH: "main", GIT_DIR: join(project, ".git") }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { project, code, out, err };
  }

  it("opens a watch on --once from a GitHub production deployment, with no Vercel token", async () => {
    const { project, code, out, err } = await githubDeploymentsOnce("cat {list}");
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out.trim()).toMatch(/^verifier-gate: nothing to do — opened 1 watch: PR #41 \(#184\) check-ins /);
    expect(readStore(join(project, ".git", STORE_RELATIVE_PATH)).watches["41"]?.deployId).toBe("9001");
  });

  it("idles with the reason, opening no watch, when GitHub's deployments list fails", async () => {
    const { project, code, out, err } = await githubDeploymentsOnce('echo "HTTP 502: Bad Gateway" >&2; exit 1');
    expect(err).toBe("");
    expect(code).toBe(1);
    expect(out).toContain("deploy source unavailable for PR #41");
    expect(out).toContain("GitHub deployments could not be listed: HTTP 502: Bad Gateway");
    const storePath = join(project, ".git", STORE_RELATIVE_PATH);
    expect(existsSync(storePath) ? readStore(storePath).watches["41"] : undefined).toBeUndefined();
  });

  it("hands over a due check-in on --once, with the evidence read from a local Sentry", async () => {
    const project = watchedProject();
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    const now = Date.now();
    const pr = merged(51, 186, "m51", now - 3 * HOUR);
    const bin = mkdtempSync(join(tmpdir(), "ralph-verifier-bin-"));
    roots.push(bin);
    // The host's ui-shots credential must never be read by a test gate.
    const config = mkdtempSync(join(tmpdir(), "ralph-verifier-xdg-"));
    roots.push(config);
    writeFileSync(join(bin, "pr.json"), JSON.stringify([pr]));
    writeFileSync(join(bin, "issue.json"), JSON.stringify(ISSUE_JSON));
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'case "$1 $2" in',
        "  'pr view') echo app/settings/page.tsx ;;",
        `  'pr list') cat ${JSON.stringify(join(bin, "pr.json"))} ;;`,
        `  'issue view') cat ${JSON.stringify(join(bin, "issue.json"))} ;;`,
        '  api*) echo identical ;;',
        '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "gh"), 0o755);

    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ deployments: [deployment("dpl_due", "m51", now - 2 * HOUR)] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    // A local Sentry: one issue first seen after the deploy, with its counts and latest event.
    const issueFirstSeen = new Date(now - HOUR).toISOString();
    const sentryServer = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      res.setHeader("content-type", "application/json");
      if (path === "/api/0/projects/loggd/web/issues/") {
        res.end(JSON.stringify([{ id: "7", title: "TypeError: settings", firstSeen: issueFirstSeen }]));
      } else if (path === "/api/0/organizations/loggd/events/") {
        res.end(JSON.stringify({ data: [{ "count()": 4, "count_unique(user)": 2 }] }));
      } else if (path === "/api/0/issues/7/events/latest/") {
        res.end(JSON.stringify({ transaction: "/settings", entries: [] }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => sentryServer.listen(0, "127.0.0.1", resolve));
    const sentryPort = (sentryServer.address() as AddressInfo).port;
    try {
      const child = spawn(BUN, [GATE, "--once"], {
        cwd: project,
        env: gateEnv(project, {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RALPH_VERIFIER_VERCEL_TOKEN: "test",
          RALPH_VERIFIER_VERCEL_API: `http://127.0.0.1:${port}`,
          RALPH_VERIFIER_SENTRY_TOKEN: "test",
          RALPH_VERIFIER_SENTRY_API: `http://127.0.0.1:${sentryPort}`,
          RALPH_BASE_BRANCH: "main",
          RALPH_RUN_ID: "cli-run",
          XDG_CONFIG_HOME: config,
          GIT_DIR: join(project, ".git"),
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      expect(err).toBe("");
      expect(out.trim()).toBe("verifier-gate: work available — verifier check-in +1h of PR #51 (#186), deploy dpl_due");
      expect(code).toBe(0);
    } finally {
      server.close();
      sentryServer.close();
    }
    const store = readStore(join(project, ".git", STORE_RELATIVE_PATH));
    expect(store.leases["51@1"]).toMatchObject({ run: "cli-run", loop: "sent" });
    const evidence = store.watches["51"]!.checkIns[0]!.result!.evidence;
    expect(evidence.pr).toEqual({ number: 51, files: ["app/settings/page.tsx"], routes: ["/settings"] });
    expect(evidence.health.reachable).toBe(true);
    expect(evidence.health.issues).toMatchObject([{ id: "7", title: "TypeError: settings", firstSeen: issueFirstSeen, events: 4, routes: ["/settings"] }]);
    expect(evidence.traffic).toEqual({ reachable: true, hits: 4 });
  });

  it("is idle on --once before the first check-in is due, naming it, with no lease taken", async () => {
    const project = watchedProject();
    spawnSync("git", ["init", "-q", project], { encoding: "utf8" });
    const path = join(project, ".git", STORE_RELATIVE_PATH);
    const deployedAt = new Date(Date.now() - HOUR / 2);
    await withStore(path, (store) => openWatches(store, [{
      pr: 61, ticket: 187, ticketRef: "#187", mergeCommit: "m61", mergedAt: deployedAt.toISOString(),
      deployId: "dpl_61", deployedAt: deployedAt.toISOString(), deployUrl: null, mode: "observe",
    }], RULES.checkIns, deployedAt));
    const due = new Date(deployedAt.getTime() + HOUR).toISOString().replace(/\.\d+Z$/, "Z");
    // No Vercel token: nothing new opens, and no gh is asked; the seeded watch is all there is.
    const run = spawnSync(BUN, [GATE, "--once"], { cwd: project, encoding: "utf8", env: gateEnv(project, { GIT_DIR: join(project, ".git") }) });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toMatch(/^verifier-gate: nothing to do — /);
    expect(run.stdout.trim()).toContain(`next check-in +1h of PR #61 at ${due}`);
    expect(readStore(path).leases).toEqual({});
  });

  it("refuses to guess a production for a project with no verifier block, as a non-verdict exit", () => {
    // Off the roster too: the validator refuses a rostered verifier with no
    // block before the gate could, and the gate's own refusal is what is pinned.
    const { verifier, loops, ...rest } = watchedConfig();
    void verifier;
    const project = watchedProject({ ...rest, loops: (loops as unknown[]).slice(0, -1) });
    const run = spawnSync(BUN, [GATE, "--once"], { cwd: project, encoding: "utf8", env: gateEnv(project) });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no 'verifier' block");
  });

  it("stops when its supervisor is gone, rather than polling for nobody", () => {
    const dead = spawnSync("true");
    const project = watchedProject();
    const run = spawnSync(BUN, [GATE, "3600"], {
      cwd: project,
      encoding: "utf8",
      env: gateEnv(project, { RALPH_SUPERVISOR_PID: String(dead.pid), RALPH_CONTROL_POLL_SECONDS: "1" }),
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^verifier-gate: .* — waiting 3600s \(poll 1, idle 0s\)$/);
    expect(lines.at(-1)).toBe(`verifier-gate: supervisor ${dead.pid} is gone — stopping.`);
  });

  it("hands back to the supervisor when an operator command is waiting", async () => {
    const project = watchedProject();
    const child = spawn(BUN, [GATE, "3600"], {
      cwd: project,
      env: gateEnv(project, { RALPH_SUPERVISOR_PID: String(process.pid), RALPH_CONTROL_POLL_SECONDS: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    const waiting = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
        if (out.includes("waiting 3600s")) resolve();
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    try {
      // Raced against the exit, so a gate that dies before it waits fails here
      // rather than at the suite's timeout.
      await Promise.race([
        waiting,
        exited.then((code) => {
          throw new Error(`the gate exited ${code} before it waited: ${out}`);
        }),
      ]);
      writeInboxCommand(project, {
        version: 1,
        id: "stop-sent-1",
        command: "stop",
        loop: "sent",
        why: "operator",
        stop: "blocked",
        issuedAt: new Date().toISOString(),
      });
      expect(await exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
    expect(out.trim().split("\n").at(-1)).toBe(CONTROL_PENDING_LINE);
  });
});
