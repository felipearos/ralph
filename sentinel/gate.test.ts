// @vitest-environment node
/**
 * The sentinel's intake gate (felipearos/ralph#681): which reporter issues
 * qualify, that one is leased and handed over with its evidence stored, that
 * two racing gates hand one issue to one session, and that an unreachable
 * reporter or a missing token is a quiet poll with the reason, never a throw.
 * File mode (#682): drafts filed once, adoption by marker, the daily cap and
 * its one page, the templated fallback, and a failing tracker.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createLiveRules, MIN_FETCH_INTERVAL_MS, withLiveRules } from "../live-rules";
import { parseProjectConfig, sentinelRules, type SentinelRules } from "../project-config";
import type { PushInput } from "../push-notification";
import { secretRereadLine } from "../frontier-gate";
import { createFakeReporter } from "../reporter/fake";
import type { Reporter } from "../reporter/types";
import { NOW, hoursAgo, seedEvents, seedIssue, seedOf, type ReporterSeed, type SeedIssue } from "../reporter/contract";
import { sentryEmulator } from "../reporter/sentry-emulator";
import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { createFakeTracker, type FakeTracker } from "../tracker/fake";
import { SENTINEL_LABEL } from "./file";
import {
  caseText,
  disabledWhy,
  parseCase,
  poll,
  REGRESSION_GRACE_HOURS,
  SENTRY_API_ENV,
  SENTRY_TOKEN_ENV,
  waitingLine,
  type PollDeps,
  type Verdict,
} from "./gate";
import { readStore, recordCandidate, recordDraft, STORE_RELATIVE_PATH, withStore, type Holder } from "./store";

subprocessSuite("runs sentinel/gate.ts through bun and git");

const RULES: SentinelRules = {
  reporter: { kind: "sentry", org: "acme", project: "web", environment: null },
  enabled: true,
  lookbackHours: 24,
  minEvents: 10,
  minUsers: 3,
  maxPerDay: 5,
  mode: "observe",
  language: "en",
};

const HOLDER: Holder = { run: "run-1", loop: "rafa" };

const storeIn = (): string => join(scratchDir("sentinel-gate-"), "ralph", "sentinel-issues.json");

/** New inside the lookback (first seen 5h ago) with `events` events an hour ago. */
const fresh = (id: string, overrides: Partial<SeedIssue> = {}, events = 12): SeedIssue =>
  seedIssue(id, 1, { firstSeen: hoursAgo(5), events: seedEvents(events, 1), ...overrides });

function depsOf(seed: ReporterSeed, storePath = storeIn(), holder: Holder = HOLDER): PollDeps {
  return { rules: RULES, reporter: { read: createFakeReporter(seed) }, storePath, now: () => NOW, holder };
}

/** The same deps, but the evidence of issue `id` cannot be read: deleted, merged, or its latest event aged out. */
function withUnreadable(deps: PollDeps, id: string): PollDeps {
  const reporter = deps.reporter.read!;
  return {
    ...deps,
    reporter: {
      read: {
        ...reporter,
        listCandidates: (query) => reporter.listCandidates(query),
        readEvidence: async (issueId) => (issueId === id ? { reachable: false, why: "gone" } : reporter.readEvidence(issueId)),
      },
    },
  };
}

describe("sentinel/gate poll", () => {
  it("leases a new issue over the threshold and hands it over with its evidence stored", async () => {
    const deps = depsOf(seedOf([fresh("101", { title: "TypeError: x\nis undefined" })]));
    const verdict = await poll(deps);
    expect(verdict).toEqual({ work: true, why: "sentinel issue sentry:101 — TypeError: x is undefined" });
    const store = readStore(deps.storePath);
    const record = store.issues["sentry:101"]!;
    expect(record.attempts).toBe(1);
    expect(record.state).toBe("observed");
    expect(record.mode).toBe("observe");
    expect(record.evidence?.issueId).toBe("101");
    expect(store.leases["sentry:101"]).toMatchObject({ run: "run-1", loop: "rafa" });
  });

  it.each<[string, SeedIssue]>([
    ["under both thresholds", fresh("201", {}, 9)],
    ["resolved", fresh("202", { status: "resolved" })],
    ["ignored", fresh("203", { status: "ignored" })],
    ["muted", fresh("204", { status: "muted" })],
    ["old and not regressed", fresh("205", { firstSeen: hoursAgo(48) })],
  ])("leaves an issue %s alone", async (_, issue) => {
    const deps = depsOf(seedOf([issue]));
    const verdict = await poll(deps);
    expect(verdict).toEqual({ work: false, why: "1 candidate, none qualifies" });
    expect(readStore(deps.storePath).issues).toEqual({});
  });

  it("takes a regressed old issue, and one over the user threshold alone", async () => {
    const regressed = await poll(depsOf(seedOf([fresh("301", { firstSeen: hoursAgo(400), regressed: true })])));
    expect(regressed.work).toBe(true);
    expect(parseCase(regressed.why)).toBe("sentry:301");

    const users = await poll(depsOf(seedOf([fresh("302", { events: seedEvents(3, 1, ["a", "b", "c"]) })])));
    expect(users.work).toBe(true);
    expect(parseCase(users.why)).toBe("sentry:302");
  });

  it("takes the oldest of two qualifying issues", async () => {
    const deps = depsOf(seedOf([fresh("402", { firstSeen: hoursAgo(3) }), fresh("401", { firstSeen: hoursAgo(10) })]));
    const verdict = await poll(deps);
    expect(parseCase(verdict.why)).toBe("sentry:401");
    // The other one is recorded, but not handed over.
    expect(readStore(deps.storePath).issues["sentry:402"]?.attempts).toBe(0);
  });

  it("never hands over an issue already drafted", async () => {
    const issue = fresh("501");
    const deps = depsOf(seedOf([issue]));
    expect((await poll(deps)).work).toBe(true);
    await withStore(deps.storePath, (store) =>
      recordDraft(store, "sentry:501", { title: "t", body: "b", at: NOW.toISOString() }, "observe", NOW));
    const again = await poll(deps);
    expect(again.work).toBe(false);
    expect(again.why).toContain("1 already drafted");
  });

  it("never hands over an issue a third time once two sessions failed it", async () => {
    const deps = depsOf(seedOf([fresh("601")]));
    expect((await poll(deps)).work).toBe(true);
    // The same run and loop re-takes its own lease, as after a failed session.
    expect((await poll(deps)).work).toBe(true);
    const third = await poll(deps);
    expect(third.work).toBe(false);
    expect(readStore(deps.storePath).issues["sentry:601"]?.attempts).toBe(2);
  });

  it("hands one issue to exactly one of two racing gates", async () => {
    const storePath = storeIn();
    const seed = seedOf([fresh("701")]);
    const verdicts = await Promise.all([
      poll(depsOf(seed, storePath, { run: "run-a", loop: "alpha" })),
      poll(depsOf(seed, storePath, { run: "run-b", loop: "beta" })),
    ]);
    expect(verdicts.filter((verdict) => verdict.work)).toHaveLength(1);
    const idle = verdicts.find((verdict) => !verdict.work)!;
    expect(idle.why).toMatch(/1 qualifying issue, 1 held by (alpha|beta)/);
    expect(readStore(storePath).issues["sentry:701"]?.attempts).toBe(1);
  });

  it("is a quiet poll with the reason when the reporter is down", async () => {
    const deps = depsOf({ ...seedOf([fresh("801")]), outage: "sentry.io answered 503" });
    expect(await poll(deps)).toEqual({ work: false, why: "the error reporter could not be read: sentry.io answered 503" });
  });

  it("is a quiet poll with its reason when there is no reporter", async () => {
    const deps: PollDeps = { ...depsOf(seedOf([])), reporter: { read: null, why: "no Sentry token — RALPH_SENTINEL_SENTRY_TOKEN is not set" } };
    expect(await poll(deps)).toEqual({ work: false, why: "no Sentry token — RALPH_SENTINEL_SENTRY_TOKEN is not set" });
  });

  it("turns a store it cannot write into a quiet poll, never a throw", async () => {
    const deps = depsOf(seedOf([fresh("901")]), join(scratchDir("sentinel-gate-"), "x.json"));
    writeFileSync(deps.storePath, "not json");
    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toMatch(/^the poll failed: the sentinel issue store at .* is unreadable/);
  });

  it("releases an issue whose evidence cannot be read and hands over the next one", async () => {
    const deps = withUnreadable(depsOf(seedOf([fresh("1002", { firstSeen: hoursAgo(3) }), fresh("1001", { firstSeen: hoursAgo(10) })])), "1001");
    const verdict = await poll(deps);
    expect(verdict.work).toBe(true);
    expect(parseCase(verdict.why)).toBe("sentry:1002");
    const store = readStore(deps.storePath);
    expect(store.leases["sentry:1001"]).toBeUndefined();
    expect(store.leases["sentry:1002"]).toMatchObject({ run: "run-1", loop: "rafa" });
  });

  it("is a quiet poll naming the issue, with no lease left, when its evidence alone cannot be read", async () => {
    const deps = withUnreadable(depsOf(seedOf([fresh("1101")])), "1101");
    expect(await poll(deps)).toEqual({ work: false, why: "the evidence could not be read for sentry:1101 (gone)" });
    expect(readStore(deps.storePath).leases).toEqual({});
  });

  it("hands over an issue with a blank title as untitled, and the case still parses", async () => {
    const verdict = await poll(depsOf(seedOf([fresh("1201", { title: "   " })])));
    expect(verdict.work).toBe(true);
    expect(verdict.why).toMatch(/ — \(untitled\)$/);
    expect(parseCase(verdict.why)).toBe("sentry:1201");
  });
});

describe("sentinel/gate caseText", () => {
  it("round-trips through parseCase and rejects other text", async () => {
    const store = { version: 1 as const, issues: {}, leases: {}, days: {} };
    const candidate = {
      id: "42", title: `long ${"x".repeat(300)}`, culprit: "c", level: "error", status: "unresolved" as const,
      regressed: false, firstSeen: hoursAgo(2), lastSeen: hoursAgo(1), events: 1, users: 0, permalink: "p",
    };
    const text = caseText(recordCandidate(store, "sentry", candidate, "observe", NOW));
    expect(text.length).toBeLessThan(160);
    expect(text).not.toContain("\n");
    expect(parseCase(text)).toBe("sentry:42");
    expect(parseCase("verifier check-in +1h of PR #3 (x), deploy d")).toBeNull();
    expect(parseCase("sentinel issue sentry:42")).toBeNull();
    expect(parseCase("")).toBeNull();
  });
});

describe("the gate CLI", () => {
  const HOME = join(__dirname, "..");
  const GATE = join(HOME, "sentinel", "gate.ts");
  const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || process.execPath;
  const FIXTURE = join(HOME, "fixtures", "loggd", ".ralph");
  // The emulator answers Sentry's paths for `acme/web` only, so the block names that project.
  const SENTINEL = { reporter: { kind: "sentry", org: "acme", project: "web", environment: "production" } };
  const HOUR_MS = 3_600_000;

  const roots: string[] = [];
  afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

  /** Loggd's fixture config, with the sentinel rostered and its block unless `sentinel` is false. */
  function config(sentinel = true): Record<string, unknown> {
    // loggd rosters senti and carries a sentinel block since loggd#2909: for
    // "no sentinel block" drop both (a rostered sentinel without its block is
    // refused before the gate runs), and otherwise roster senti exactly once.
    const { sentinel: block, ...base } = JSON.parse(readFileSync(join(FIXTURE, "config.json"), "utf8"));
    void block;
    const loops = (base.loops as { role?: string }[]).filter((loop) => loop.role !== "sentinel");
    if (!sentinel) return { ...base, loops };
    return { ...base, loops: [...loops, { name: "senti", role: "sentinel" }], sentinel: SENTINEL };
  }

  const gitIn = (cwd: string, ...args: string[]): void => {
    const out = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  };

  /** Commit the worktree's config and push it to its origin's main, as a merged change would land. */
  const publish = (root: string): void => {
    gitIn(root, "add", "-A", ".ralph", ":!.ralph/logs");
    gitIn(root, "commit", "-q", "--allow-empty", "-m", "rules");
    gitIn(root, "push", "-q", "origin", "HEAD:main");
  };

  /**
   * A temp git worktree carrying loggd's `.ralph/`, its config replaced; never
   * this checkout's. Its config is pushed to a bare origin beside it, because
   * the gate reads its rules from `origin/main` every poll (#788).
   */
  function project(sentinel = true, edit: (config: Record<string, unknown>, root: string) => Record<string, unknown> = (same) => same): string {
    const root = mkdtempSync(join(tmpdir(), "ralph-sentinel-gate-"));
    roots.push(root, `${root}-origin.git`);
    gitIn(tmpdir(), "init", "-q", "--bare", "-b", "main", `${root}-origin.git`);
    gitIn(tmpdir(), "init", "-q", "-b", "main", root);
    gitIn(root, "remote", "add", "origin", `${root}-origin.git`);
    cpSync(FIXTURE, join(root, ".ralph"), { recursive: true });
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(edit(config(sentinel), root)));
    publish(root);
    return root;
  }

  /**
   * Built from nothing rather than from `process.env`, so a Sentry token or a
   * `RALPH_*` variable on the host never reaches the gate under test.
   */
  const gateEnv = (root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? root,
    RALPH_PROJECT: root,
    RALPH_LOOP_NAME: "senti",
    RALPH_RUN_ID: "run-cli",
    ...extra,
  });

  /** Seeded against the real clock: the gate computes its windows from it, and the emulator filters by them. */
  const ago = (hours: number): string => new Date(Date.now() - hours * HOUR_MS).toISOString();
  const issueWith = (id: string, title: string, events: number): SeedIssue =>
    seedIssue(id, 1, {
      title,
      firstSeen: ago(5),
      lastSeen: ago(1),
      events: Array.from({ length: events }, () => ({ at: ago(1), user: null })),
    });

  /** A local Sentry that hands every request to the emulator, and its API base. */
  async function sentry(seed: ReporterSeed): Promise<{ server: Server; base: string }> {
    const emulate = sentryEmulator(seed);
    const server = createServer((req, res) => {
      const port = (server.address() as AddressInfo).port;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
      void emulate(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method ?? "GET", headers })
        .then(async (response) => {
          res.statusCode = response.status;
          response.headers.forEach((value, name) => res.setHeader(name, value));
          res.end(await response.text());
        })
        .catch((error: unknown) => {
          res.statusCode = 500;
          res.end(String(error));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

  async function once(root: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
    const child = spawn(BUN, [GATE, "--once"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { code, out, err };
  }

  const storeOf = (root: string): string => join(root, ".git", STORE_RELATIVE_PATH);

  it("leases a qualifying issue on --once and stores its evidence in the project's git dir", async () => {
    const root = project();
    const { server, base } = await sentry(seedOf([issueWith("4512", "TypeError: x is undefined", 12)]));
    let run;
    try {
      run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base }));
    } finally {
      await close(server);
    }
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out.trim()).toBe("sentinel-gate: work available — sentinel issue sentry:4512 — TypeError: x is undefined");
    const store = readStore(storeOf(root));
    expect(store.issues["sentry:4512"]?.evidence?.issueId).toBe("4512");
    expect(store.leases["sentry:4512"]).toMatchObject({ run: "run-cli", loop: "senti" });
  });

  it("files a session's draft on the project's tracker on --once in file mode", async () => {
    // A local tracker: a tickets file on this host, so the gate files with no credential and no network.
    const root = project(true, (base, dir) => ({
      ...base,
      // ci-doctor runs on GitHub issues only, and config validation refuses it
      // (and its block) beside a local tracker.
      loops: (base.loops as unknown[]).filter((entry) => !(typeof entry === "object" && (entry as { role?: string }).role === "ci-doctor")),
      ciDoctor: undefined,
      tracker: { kind: "local", key: "SBX", file: join(dir, "tickets.json") },
      sentinel: { ...SENTINEL, mode: "file" },
    }));
    const { server, base } = await sentry(seedOf([issueWith("4520", "TypeError: cart is undefined", 12)]));
    const env = gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base });
    let handed;
    let drafted;
    let filed;
    try {
      handed = await once(root, env);
      const bodyFile = join(root, "draft.md");
      writeFileSync(bodyFile, "The cart is undefined on checkout.\n");
      const caseLine = handed.out.trim().replace(/^sentinel-gate: work available — /, "");
      drafted = spawnSync(BUN, [join(HOME, "sentinel", "issue.ts"), "draft", caseLine, "--title", "Checkout crashes", "--body-file", bodyFile], {
        cwd: root, env, encoding: "utf8",
      });
      filed = await once(root, env);
    } finally {
      await close(server);
    }
    expect(handed.err).toBe("");
    expect(handed.code).toBe(0);
    expect(drafted.status).toBe(0);
    expect(filed.err).toBe("");
    expect(filed.code).toBe(1);
    expect(filed.out.trim()).toContain("filed 1");

    const tickets = JSON.parse(readFileSync(join(root, "tickets.json"), "utf8")) as { issues: { title: string; body: string; labels: string[] }[] };
    expect(tickets.issues).toHaveLength(1);
    expect(tickets.issues[0]!.title).toBe("Checkout crashes");
    expect(tickets.issues[0]!.labels).toEqual(["ready-for-human"]);
    expect(tickets.issues[0]!.body).toContain("<!-- ralph-sentinel: sentry:4520 -->");
    const record = readStore(storeOf(root)).issues["sentry:4520"]!;
    expect(record.candidate.permalink).not.toBe("");
    expect(tickets.issues[0]!.body).toContain(record.candidate.permalink);
    expect(record).toMatchObject({ state: "filed", ticket: "SBX-1" });
  });

  it("comments once on --once when a filed ticket's issue doubled, and not again the same day (#683 AC1)", async () => {
    const root = project(true, (base, dir) => ({
      ...base,
      loops: (base.loops as unknown[]).filter((entry) => !(typeof entry === "object" && (entry as { role?: string }).role === "ci-doctor")),
      ciDoctor: undefined,
      tracker: { kind: "local", key: "SBX", file: join(dir, "tickets.json") },
      sentinel: { ...SENTINEL, mode: "file" },
    }));
    // One Sentry per count: the emulator's seed is fixed, so each growth step is a new server.
    const withCount = async <T>(events: number, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> => {
      const { server, base } = await sentry(seedOf([issueWith("4530", "TypeError: cart is undefined", events)]));
      try {
        return await run(gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base }));
      } finally {
        await close(server);
      }
    };
    const comments = (): unknown[] =>
      (JSON.parse(readFileSync(join(root, "tickets.json"), "utf8")) as { issues: { comments?: unknown[] }[] }).issues[0]!.comments ?? [];

    await withCount(12, async (env) => {
      const handed = await once(root, env);
      expect(handed.err).toBe("");
      expect(handed.code).toBe(0);
      const bodyFile = join(root, "draft.md");
      writeFileSync(bodyFile, "The cart is undefined on checkout.\n");
      const caseLine = handed.out.trim().replace(/^sentinel-gate: work available — /, "");
      const drafted = spawnSync(BUN, [join(HOME, "sentinel", "issue.ts"), "draft", caseLine, "--title", "Checkout crashes", "--body-file", bodyFile], {
        cwd: root, env, encoding: "utf8",
      });
      expect(drafted.status).toBe(0);
      expect((await once(root, env)).out).toContain("filed 1");
    });
    expect(readStore(storeOf(root)).issues["sentry:4530"]?.recurrence?.baseline).toBe(12);

    const under = await withCount(23, (env) => once(root, env));
    expect(under.err).toBe("");
    expect(comments()).toHaveLength(0);

    const doubled = await withCount(24, (env) => once(root, env));
    expect(doubled.err).toBe("");
    expect(doubled.out).toContain("commented 1");
    expect(comments()).toHaveLength(1);

    const again = await withCount(60, (env) => once(root, env));
    expect(again.out).not.toContain("commented");
    expect(comments()).toHaveLength(1);
  });

  it("exits 1 with nothing to do, and leases nothing, when the only issue is under the threshold", async () => {
    const root = project();
    const { server, base } = await sentry(seedOf([issueWith("4513", "Error under the bar", 1)]));
    let run;
    try {
      run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base }));
    } finally {
      await close(server);
    }
    expect(run.err).toBe("");
    expect(run.code).toBe(1);
    expect(run.out.trim()).toBe("sentinel-gate: nothing to do — 1 candidate, none qualifies");
    const store = readStore(storeOf(root));
    expect(store.leases).toEqual({});
  });

  it("polls with the rules merged on origin, not the worktree's, and keeps them over an invalid change (#788)", async () => {
    const root = project();
    const worktreeConfig = readFileSync(join(root, ".ralph", "config.json"), "utf8");
    // Merged on origin only: the worktree, as between a loop's iterations, stays where it was.
    const lowered = JSON.parse(worktreeConfig);
    lowered.sentinel = { ...lowered.sentinel, minEvents: 1 };
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(lowered));
    publish(root);
    gitIn(root, "reset", "-q", "--hard", "HEAD~1");
    expect(readFileSync(join(root, ".ralph", "config.json"), "utf8")).toBe(worktreeConfig);

    const { server, base } = await sentry(seedOf([issueWith("4514", "Error under the old bar", 1)]));
    let run;
    try {
      run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base }));
    } finally {
      await close(server);
    }
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(run.out.trim().split("\n")).toEqual([
      "sentinel-gate: rules changed on origin/main — minEvents 10 → 1",
      "sentinel-gate: work available — sentinel issue sentry:4514 — Error under the old bar",
    ]);

    // An invalid config merged next is ignored: the restarted gate keeps the
    // rules it last held (kept under .ralph/logs), and says why.
    gitIn(root, "checkout", "-q", "--detach", "origin/main");
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...lowered, sentinel: { ...lowered.sentinel, mode: "loud" } }));
    publish(root);
    gitIn(root, "reset", "-q", "--hard", "HEAD~1");
    const { server: again, base: againBase } = await sentry(seedOf([issueWith("4515", "Another small one", 1)]));
    let kept;
    try {
      kept = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: againBase }));
    } finally {
      await close(again);
    }
    expect(kept.err).toBe("");
    const lines = kept.out.trim().split("\n");
    expect(lines[0]).toMatch(/^sentinel-gate: rules may be stale — origin\/main:\.ralph\/config\.json is invalid: .*mode.*; keeping the rules from /);
    expect(lines.at(-1)).toMatch(/^sentinel-gate: work available — sentinel issue sentry:4515 /);
  });

  it("exits 1 saying it is disabled in config, without reaching Sentry, when its block says off (#789)", async () => {
    const root = project(true, (config) => ({ ...config, sentinel: { ...(config.sentinel as Record<string, unknown>), enabled: false } }));
    // A port nothing listens on: a read would turn the answer into "could not be read".
    const run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: "http://127.0.0.1:9" }));
    expect(run.err).toBe("");
    expect(run.code).toBe(1);
    expect(run.out.trim()).toBe("sentinel-gate: nothing to do — disabled in config — not polling Sentry");
  });

  it("exits 1 with the reason, which names the missing token", async () => {
    const root = project();
    const run = await once(root, gateEnv(root));
    expect(run.err).toBe("");
    expect(run.code).toBe(1);
    expect(run.out.trim()).toBe(`sentinel-gate: nothing to do — no Sentry token — ${SENTRY_TOKEN_ENV} is not set`);
  });

  /**
   * Runs the blocking gate until it exits, or until `stopWhen` sees its output
   * (then it is killed and `code` is "killed"). Bounded: a gate that slept its
   * 300 s interval is killed after 20 s and `code` is "timeout".
   */
  async function blocking(
    root: string,
    env: NodeJS.ProcessEnv,
    stopWhen: (out: string) => boolean = () => false,
  ): Promise<{ code: number | null | "killed" | "timeout"; out: string; err: string }> {
    const child = spawn(BUN, [GATE, "300"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await new Promise<number | null | "killed" | "timeout">((resolve) => {
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
        if (stopWhen(out)) {
          child.kill("SIGKILL");
          resolve("killed");
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("timeout");
      }, 20_000);
      child.on("exit", (exitCode) => resolve(exitCode));
    });
    clearTimeout(timer);
    return { code, out, err };
  }

  // The test runner is the supervisor, alive throughout, so a hand-back is
  // the re-read line and not the orphan line. The token is one the gate uses,
  // as role-behaviour.ts exports it: only those make a gate hand back.
  const unreadEnv = (root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
    gateEnv(root, {
      RALPH_SUPERVISOR_PID: String(process.pid),
      RALPH_ROLE_SECRETS_UNREAD: SENTRY_TOKEN_ENV,
      RALPH_ROLE_SECRETS_GATE: SENTRY_TOKEN_ENV,
      ...extra,
    });
  const SECRET_REREAD_LINE = secretRereadLine("sentinel-gate");

  it("hands back for a secret re-read after a tokenless poll when the token's read failed, without sleeping (#759)", async () => {
    const root = project();
    const run = await blocking(root, unreadEnv(root, { RALPH_SECRET_REREAD: "1" }));
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const lines = run.out.trim().split("\n");
    expect(run.out).toContain(`sentinel-gate: no Sentry token — ${SENTRY_TOKEN_ENV} is not set at `);
    expect(run.out).toMatch(/\(poll 1, idle 0s\)/);
    expect(lines.at(-1)).toBe(`${SECRET_REREAD_LINE} — poll again in 300s — after poll 1`);
    expect(lines.at(-1)).toBe("sentinel-gate: secret re-read due — handing back to the supervisor — poll again in 300s — after poll 1");
    expect(lines.at(-1)).toMatch(/^[A-Za-z0-9_.-]+: secret re-read due/);
  });

  it("does not hand back to a supervisor that has not said it understands the re-read (#759)", async () => {
    // An old supervisor exports the unread names but not RALPH_SECRET_REREAD,
    // and would read the hand-back's exit 0 as work: the gate sleeps instead.
    const root = project();
    const run = await blocking(root, unreadEnv(root), (out) => out.includes(" — waiting 300s ("));
    expect(run.err).toBe("");
    expect(run.code).toBe("killed");
    expect(run.out).toContain(`sentinel-gate: no Sentry token — ${SENTRY_TOKEN_ENV} is not set at `);
    expect(run.out).not.toContain("secret re-read due");
  });

  it("sleeps rather than hands back on a poll the back-off schedule skips (#759)", async () => {
    // Poll 3: each hand-back drops the gate's in-process state, so a long
    // outage re-reads on polls 1, 2, 4, 8, then every 12th — not every poll.
    const root = project();
    const run = await blocking(
      root,
      unreadEnv(root, { RALPH_SECRET_REREAD: "1", RALPH_GATE_WAITING_SINCE: String(Math.floor(Date.now() / 1000)), RALPH_GATE_POLLS: "2" }),
      (out) => out.includes(" — waiting 300s ("),
    );
    expect(run.err).toBe("");
    expect(run.code).toBe("killed");
    expect(run.out).toMatch(/\(poll 3, idle /);
    expect(run.out).not.toContain("secret re-read due");
  });

  it("resumes the poll count and idle time the supervisor passes across hand-backs (#759)", async () => {
    const root = project();
    const since = Math.floor(Date.now() / 1000) - 7200;
    const run = await blocking(
      root,
      unreadEnv(root, { RALPH_SECRET_REREAD: "1", RALPH_GATE_WAITING_SINCE: String(since), RALPH_GATE_POLLS: "23" }),
    );
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    // Poll 24 is on the back-off schedule, so it hands back.
    expect(run.out).toMatch(/\(poll 24, idle /);
    expect(run.out).not.toMatch(/idle 0s\)/);
    expect(run.out.trim().split("\n").at(-1)).toBe(`${SECRET_REREAD_LINE} — poll again in 300s — after poll 24`);
  });

  it("exits 1 saying the reporter could not be read when nothing listens on its port", async () => {
    const root = project();
    const { server, base } = await sentry(seedOf([]));
    await close(server);
    const run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token", [SENTRY_API_ENV]: base }));
    expect(run.err).toBe("");
    expect(run.code).toBe(1);
    expect(run.out.trim()).toMatch(/^sentinel-gate: nothing to do — the error reporter could not be read: /);
  });

  it("exits 2 when the project's config has no sentinel block", async () => {
    const root = project(false);
    const run = await once(root, gateEnv(root, { [SENTRY_TOKEN_ENV]: "test-token" }));
    expect(run.code).toBe(2);
    expect(run.err).toContain("no 'sentinel' block");
  });
});

describe("sentinel/gate switched off (#789)", () => {
  /** A reporter that records every call, so "not polling Sentry" is checked rather than assumed. */
  function counted(seed: ReporterSeed): { calls: string[]; reporter: Reporter } {
    const inner = createFakeReporter(seed);
    const calls: string[] = [];
    return {
      calls,
      reporter: {
        kind: inner.kind,
        checkAccess: () => { calls.push("checkAccess"); return inner.checkAccess(); },
        listCandidates: (query) => { calls.push("listCandidates"); return inner.listCandidates(query); },
        readEvidence: (id) => { calls.push(`readEvidence ${id}`); return inner.readEvidence(id); },
      },
    };
  }

  const OFF: SentinelRules = { ...RULES, mode: "file", enabled: false };

  it("reads no reporter, files no draft or fallback, comments nothing and hands nothing over", async () => {
    const { calls, reporter } = counted(seedOf([fresh("3001"), fresh("3002"), fresh("3003")]));
    const tracker = createFakeTracker();
    const pushes: PushInput[] = [];
    const storePath = storeIn();
    // What file mode would act on this poll: a session's draft, an issue two
    // sessions failed (the templated fallback) and a filed one (recurrences).
    await withStore(storePath, (store) => {
      for (const id of ["3001", "3002", "3003"]) {
        const candidate = {
          id, title: `Error ${id}`, culprit: "c", level: "error", status: "unresolved" as const,
          regressed: false, firstSeen: hoursAgo(5), lastSeen: hoursAgo(1), events: 12, users: 1, permalink: `https://sentry.example/issues/${id}/`,
        };
        recordCandidate(store, "sentry", candidate, "file", NOW);
      }
      recordDraft(store, "sentry:3001", { title: "t", body: "b", at: NOW.toISOString() }, "file", NOW);
      store.issues["sentry:3002"]!.attempts = 2;
    });
    const before = readFileSync(storePath, "utf8");
    const deps: PollDeps = { rules: OFF, reporter: { read: reporter }, storePath, now: () => NOW, holder: HOLDER, filing: { tracker, push: (input) => void pushes.push(input) } };

    const verdict = await poll(deps);
    expect(verdict).toEqual({ work: false, why: "disabled in config — not polling Sentry" });
    expect(calls).toEqual([]);
    expect(tracker.writes).toEqual([]);
    expect(pushes).toEqual([]);
    expect(readFileSync(storePath, "utf8")).toBe(before);
    // The line the supervisor's log shows every poll.
    expect(waitingLine(verdict, { poll: 4, waitingSince: NOW, now: NOW, waitSeconds: 300 })).toBe(
      "sentinel-gate: disabled in config — not polling Sentry at 2026-11-04T12:00:00Z — waiting 300s (poll 4, idle 0s)",
    );

    // Switched on again, the same deps file the draft and the fallback, and hand the third issue over.
    const on = await poll({ ...deps, rules: { ...OFF, enabled: true } });
    expect(on).toEqual({ work: true, why: expect.stringMatching(/^sentinel issue sentry:3003 — /) });
    expect(calls).toContain("listCandidates");
    expect(tracker.issues.size).toBe(2);
  });

  it("says it is off rather than that the token is missing", async () => {
    const deps: PollDeps = { ...depsOf(seedOf([])), rules: OFF, reporter: { read: null, why: "no Sentry token — RALPH_SENTINEL_SENTRY_TOKEN is not set" } };
    expect(await poll(deps)).toEqual({ work: false, why: disabledWhy(OFF) });
  });

  it("is switched back on by a rules change pushed to origin, on the gate's next poll", async () => {
    const { root, publish } = liveProject({ enabled: false });
    const time = { at: 1_000_000 };
    const config = parseProjectConfig(readFileSync(join(root, ".ralph", "config.json"), "utf8"));
    const live = createLiveRules<SentinelRules>({
      root,
      role: "sentinel",
      baseBranch: "main",
      extract: sentinelRules,
      initial: { config, rules: sentinelRules(config)!, source: "the worktree" },
      now: () => time.at,
      statePath: null,
    });
    const { calls, reporter } = counted(seedOf([fresh("3101")]));
    const storePath = storeIn();
    const wired = (rules: SentinelRules): PollDeps => ({ rules, reporter: { read: reporter }, storePath, now: () => NOW, holder: HOLDER });
    let deps = wired(sentinelRules(config)!);
    const logged: string[] = [];
    const nextPoll = async (): Promise<Verdict> => {
      deps = await withLiveRules(live, deps, (fresh) => wired(sentinelRules(fresh)!), (line) => logged.push(`sentinel-gate: ${line}`));
      return poll(deps);
    };

    expect(await nextPoll()).toEqual({ work: false, why: "disabled in config — not polling Sentry" });
    expect(calls).toEqual([]);

    // Merged on origin while the gate runs: no restart, only the next poll.
    publish({});
    time.at += MIN_FETCH_INTERVAL_MS;
    const verdict = await nextPoll();
    expect(logged).toEqual(["sentinel-gate: rules changed on origin/main — enabled false → true"]);
    expect(verdict).toEqual({ work: true, why: expect.stringMatching(/^sentinel issue sentry:3101 — /) });
    expect(calls).toContain("listCandidates");

    // And off again the same way.
    publish({ enabled: false });
    time.at += MIN_FETCH_INTERVAL_MS;
    expect(await nextPoll()).toEqual({ work: false, why: "disabled in config — not polling Sentry" });
    expect(logged.at(-1)).toBe("sentinel-gate: rules changed on origin/main — enabled true → false");
  });

  /**
   * A bare origin and the gate's clone of it, carrying loggd's fixture with
   * its sentinel block edited — never this checkout. `publish` replaces the
   * block's `enabled` on origin from a second clone, as a merged change would.
   */
  function liveProject(initial: Record<string, unknown>): { root: string; publish: (edit: Record<string, unknown>) => void } {
    const dir = scratchDir("sentinel-gate-live-");
    const git = (cwd: string, ...args: string[]): void => {
      const out = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    };
    const origin = join(dir, "origin.git");
    const upstream = join(dir, "upstream");
    const root = join(dir, "worktree");
    const fixture = join(__dirname, "..", "fixtures", "loggd", ".ralph");
    const base = JSON.parse(readFileSync(join(fixture, "config.json"), "utf8")) as Record<string, unknown> & { sentinel: Record<string, unknown> };
    const write = (edit: Record<string, unknown>): void => {
      const { enabled: _enabled, ...block } = base.sentinel;
      writeFileSync(join(upstream, ".ralph", "config.json"), JSON.stringify({ ...base, sentinel: { ...block, ...edit } }));
    };
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "init", "-q", "-b", "main", upstream);
    cpSync(fixture, join(upstream, ".ralph"), { recursive: true });
    writeFileSync(join(upstream, ".gitignore"), ".ralph/logs/\n");
    write(initial);
    git(upstream, "add", ".");
    git(upstream, "commit", "-q", "-m", "init");
    git(upstream, "remote", "add", "origin", origin);
    git(upstream, "push", "-q", "origin", "main");
    git(dir, "clone", "-q", origin, root);
    return {
      root,
      publish: (edit) => {
        write(edit);
        git(upstream, "commit", "-q", "-am", "rules");
        git(upstream, "push", "-q", "origin", "main");
      },
    };
  }
});

describe("sentinel/gate file mode (#682)", () => {
  const FILE_RULES: SentinelRules = { ...RULES, mode: "file" };

  function fileDeps(
    seed: ReporterSeed,
    options: { rules?: Partial<SentinelRules>; tracker?: FakeTracker; storePath?: string; now?: Date } = {},
  ): PollDeps & { tracker: FakeTracker; pushes: PushInput[] } {
    const tracker = options.tracker ?? createFakeTracker();
    const pushes: PushInput[] = [];
    const now = options.now ?? NOW;
    return {
      rules: { ...FILE_RULES, ...options.rules },
      reporter: { read: createFakeReporter(seed) },
      storePath: options.storePath ?? storeIn(),
      now: () => now,
      holder: HOLDER,
      filing: { tracker, push: (input) => void pushes.push(input) },
      tracker,
      pushes,
    };
  }

  const DRAFT = { title: "Checkout crashes on a missing cart", body: "The cart is undefined when …", at: NOW.toISOString() };

  /** What a session does after the hand-over: record its draft. */
  const draftIt = (deps: PollDeps, key: string, mode: "observe" | "file" = "file"): Promise<unknown> =>
    withStore(deps.storePath, (store) => recordDraft(store, key, DRAFT, mode, NOW));

  it("files a session's draft once, labelled ready-for-human, with the marker and the permalink (AC1, AC5)", async () => {
    const deps = fileDeps(seedOf([fresh("2001")]));
    expect((await poll(deps)).work).toBe(true);
    await draftIt(deps, "sentry:2001");

    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("filed 1");
    const issues = [...deps.tracker.issues.values()];
    expect(issues).toHaveLength(1);
    expect(issues[0]!.labels).toEqual(["ready-for-human"]);
    expect(issues[0]!.labels).not.toContain("ready-for-agent");
    expect(issues[0]!.body).toContain("<!-- ralph-sentinel: sentry:2001 -->");
    expect(issues[0]!.body).toContain("https://sentry.example/issues/2001/");
    const record = readStore(deps.storePath).issues["sentry:2001"]!;
    expect(record.state).toBe("filed");
    expect(record.ticket).toBe(deps.tracker.ref(issues[0]!.number));

    await poll(deps);
    expect(deps.tracker.issues.size).toBe(1);
  });

  it("adopts the filed ticket instead of handing the issue over when the store is lost (AC2)", async () => {
    const deps = fileDeps(seedOf([fresh("2101")]));
    await poll(deps);
    await draftIt(deps, "sentry:2101");
    await poll(deps);
    const ticket = readStore(deps.storePath).issues["sentry:2101"]!.ticket;
    expect(ticket).not.toBeNull();

    rmSync(deps.storePath);
    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("adopted 1");
    const record = readStore(deps.storePath).issues["sentry:2101"]!;
    expect(record.state).toBe("filed");
    expect(record.ticket).toBe(ticket);
    expect(record.attempts).toBe(0);
    expect(deps.tracker.issues.size).toBe(1);
  });

  it("holds to the daily cap, pages once that day, and resumes the next UTC day (AC3)", async () => {
    // A lookback past a day, so the issues still qualify from tomorrow's clock.
    const seed = seedOf(["2201", "2202", "2203", "2204", "2205"].map((id, index) => fresh(id, { firstSeen: hoursAgo(10 - index) })));
    const deps = fileDeps(seed, { rules: { maxPerDay: 2, lookbackHours: 48 } });
    for (let round = 0; round < 2; round++) {
      const verdict = await poll(deps);
      expect(verdict.work).toBe(true);
      await draftIt(deps, parseCase(verdict.why)!);
    }
    const capped = await poll(deps);
    expect(capped).toEqual({
      work: false,
      why: "daily cap of 2 tickets reached for 2026-11-04; 3 issues wait for the next UTC day",
    });
    await poll(deps);
    await poll(deps);

    expect(deps.tracker.issues.size).toBe(2);
    const records = Object.values(readStore(deps.storePath).issues);
    expect(records.filter((record) => record.state === "filed")).toHaveLength(2);
    expect(records.filter((record) => record.state === "observed")).toHaveLength(3);
    expect(deps.pushes).toHaveLength(1);
    expect(deps.pushes[0]).toMatchObject({ kind: "sentinel-alert", occurrence: "sentinel-alert:2026-11-04", priority: "high", ticket: null });

    const tomorrow = fileDeps(seed, {
      rules: { maxPerDay: 2, lookbackHours: 48 },
      tracker: deps.tracker,
      storePath: deps.storePath,
      now: new Date(NOW.getTime() + 24 * 3_600_000),
    });
    const resumed = await poll(tomorrow);
    expect(resumed.work).toBe(true);
    expect(parseCase(resumed.why)).toBe("sentry:2203");
  });

  it("files a templated ticket for an issue two sessions failed (AC4, file mode)", async () => {
    const deps = fileDeps(seedOf([fresh("2301")]));
    // The same run and loop re-takes its own lease, as after a failed session.
    expect((await poll(deps)).work).toBe(true);
    expect((await poll(deps)).work).toBe(true);
    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("1 templated");
    const issues = [...deps.tracker.issues.values()];
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain("**Not diagnosed.**");
    expect(issues[0]!.labels).toEqual(["ready-for-human"]);
    expect(readStore(deps.storePath).issues["sentry:2301"]!.state).toBe("filed");
  });

  it("records the templated draft in observe mode and leaves the tracker alone (AC4, observe mode)", async () => {
    const deps = fileDeps(seedOf([fresh("2401")]), { rules: { mode: "observe" } });
    await poll(deps);
    await poll(deps);
    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("1 templated");
    const record = readStore(deps.storePath).issues["sentry:2401"]!;
    expect(record.state).toBe("drafted");
    expect(record.mode).toBe("observe");
    expect(record.draft?.body).toContain("**Not diagnosed.**");
    expect(deps.tracker.issues.size).toBe(0);
    expect(deps.tracker.writes).toEqual([]);
  });

  it("never touches a tracker it is handed in observe mode", async () => {
    const deps = fileDeps(seedOf([fresh("2501")]), { rules: { mode: "observe" } });
    expect((await poll(deps)).work).toBe(true);
    await draftIt(deps, "sentry:2501", "observe");
    expect((await poll(deps)).why).toContain("1 already drafted");
    expect(deps.tracker.issues.size).toBe(0);
    expect(deps.tracker.writes).toEqual([]);
  });

  it("does not file a draft recorded in observe mode once the project switches to file mode", async () => {
    const deps = fileDeps(seedOf([fresh("2601")]));
    expect((await poll(deps)).work).toBe(true);
    await draftIt(deps, "sentry:2601", "observe");
    await poll(deps);
    expect(deps.tracker.issues.size).toBe(0);
    expect(readStore(deps.storePath).issues["sentry:2601"]!.state).toBe("drafted");
  });

  it("keeps a draft when the tracker fails, and files it once on the next poll", async () => {
    const deps = fileDeps(seedOf([fresh("2701")]));
    await poll(deps);
    await draftIt(deps, "sentry:2701");
    deps.tracker.failNext("create", new Error("tracker answered 502\nretry later"));

    const failed = await poll(deps);
    expect(failed.work).toBe(false);
    expect(failed.why).toContain("filing failed for 1: tracker answered 502");
    const store = readStore(deps.storePath);
    expect(store.issues["sentry:2701"]!.state).toBe("drafted");
    expect(store.leases["sentry:2701"]).toBeUndefined();
    expect(deps.tracker.issues.size).toBe(0);

    await poll(deps);
    await poll(deps);
    expect(deps.tracker.issues.size).toBe(1);
    expect(readStore(deps.storePath).issues["sentry:2701"]!.state).toBe("filed");
  });

  it("files the other drafts on the same poll when the tracker refuses one", async () => {
    const tracker = createFakeTracker();
    // Refuses one draft every time, as a tracker does an oversized body.
    const picky: FakeTracker = Object.assign(Object.create(tracker) as FakeTracker, {
      create: (issue: Parameters<FakeTracker["create"]>[0]) =>
        issue.title === "Refused" ? Promise.reject(new Error("body is too long")) : tracker.create(issue),
    });
    const deps = fileDeps(seedOf([fresh("2801", { firstSeen: hoursAgo(10) }), fresh("2802", { firstSeen: hoursAgo(3) })]), { tracker: picky });
    expect(parseCase((await poll(deps)).why)).toBe("sentry:2801");
    await withStore(deps.storePath, (store) => recordDraft(store, "sentry:2801", { ...DRAFT, title: "Refused" }, "file", NOW));
    expect(parseCase((await poll(deps)).why)).toBe("sentry:2802");
    await draftIt(deps, "sentry:2802");

    const verdict = await poll(deps);
    expect(verdict.why).toContain("filing failed for 1: body is too long");
    expect(verdict.why).toContain("filed 1");
    const store = readStore(deps.storePath);
    expect(store.issues["sentry:2801"]!.state).toBe("drafted");
    expect(store.issues["sentry:2802"]!.state).toBe("filed");
    expect(tracker.issues.size).toBe(1);
  });

  it("files no templated ticket for sessions that failed under observe mode", async () => {
    // Two sessions failed it while the project observed; then it switched.
    const seed = seedOf([fresh("2901")]);
    const observing = depsOf(seed);
    expect((await poll(observing)).work).toBe(true);
    expect((await poll(observing)).work).toBe(true);
    const deps = fileDeps(seed, { storePath: observing.storePath });
    const verdict = await poll(deps);
    expect(verdict.work).toBe(false);
    expect(deps.tracker.issues.size).toBe(0);
    const record = readStore(deps.storePath).issues["sentry:2901"]!;
    expect(record.state).toBe("observed");
    expect(record.mode).toBe("observe");
  });

  it("files with the human label only, which the frontier keeps off coders (AC5)", () => {
    expect(SENTINEL_LABEL).toBe("ready-for-human");
  });

  describe("sentinel/gate recurrences (#683)", () => {
    const USERS = ["a", "b"];

    /** The seed's one issue, now with `count` events an hour before NOW: the fake reporter reads its seed live. */
    function setEvents(seed: ReporterSeed, count: number, overrides: Partial<SeedIssue> = {}): void {
      seed.issues[0] = { ...seed.issues[0]!, events: seedEvents(count, 1, USERS), ...overrides };
    }

    /** Hand the issue over, draft it, file it: the ticket's number. */
    async function fileIt(deps: PollDeps & { tracker: FakeTracker }, key: string): Promise<number> {
      expect((await poll(deps)).work).toBe(true);
      await draftIt(deps, key);
      expect((await poll(deps)).why).toContain("filed 1");
      const record = readStore(deps.storePath).issues[key]!;
      expect(record.state).toBe("filed");
      return record.ticketNumber!;
    }

    /**
     * Closed `hours` before NOW (three by default): before the seeded issue
     * was last seen, an hour before NOW, but inside the regression grace.
     */
    function closeTicket(tracker: FakeTracker, number: number, hours = 3, as: "completed" | "canceled" = "completed"): void {
      const issue = tracker.issues.get(number)!;
      issue.state = "closed";
      issue.closedAt = hoursAgo(hours);
      issue.closedAs = as;
    }

    const commentsOn = (tracker: FakeTracker, number: number): string[] => tracker.issues.get(number)!.comments.map((c) => c.body);

    it("comments once a day on an open ticket whose issue doubled, and not under 2x (AC1)", async () => {
      const seed = seedOf([fresh("3001", { release: "web@1.2.3" })]);
      const deps = fileDeps(seed);
      const number = await fileIt(deps, "sentry:3001");

      setEvents(seed, 23);
      expect((await poll(deps)).why).not.toContain("commented");
      expect(commentsOn(deps.tracker, number)).toEqual([]);

      setEvents(seed, 24);
      expect((await poll(deps)).why).toContain("commented 1");
      const comments = commentsOn(deps.tracker, number);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toContain("24 events and 2 users");
      expect(comments[0]).toContain(`last seen ${hoursAgo(1)}`);
      expect(comments[0]).toContain("release web@1.2.3");

      // Doubled again, the same UTC day: still one.
      setEvents(seed, 48);
      await poll(deps);
      expect(commentsOn(deps.tracker, number)).toHaveLength(1);

      // The next UTC day, still doubled from the last posted 24: a second one.
      const tomorrow = fileDeps(seed, { tracker: deps.tracker, storePath: deps.storePath, now: new Date(NOW.getTime() + 20 * 3_600_000) });
      expect((await poll(tomorrow)).why).toContain("commented 1");
      expect(commentsOn(deps.tracker, number)).toHaveLength(2);
      const recurrence = readStore(deps.storePath).issues["sentry:3001"]!.recurrence!;
      expect(recurrence.baseline).toBe(48);
      expect(recurrence.comments.map((c) => c.posted)).toEqual([true, true]);
    });

    it("files a new ready-for-human ticket for a closed one whose issue came back, never reopening it (AC2)", async () => {
      const seed = seedOf([fresh("3101")]);
      const deps = fileDeps(seed);
      const old = await fileIt(deps, "sentry:3101");
      closeTicket(deps.tracker, old);
      setEvents(seed, 12, { firstSeen: hoursAgo(400), regressed: true });
      const before = deps.tracker.writes.length;

      const handed = await poll(deps);
      expect(handed.work).toBe(true);
      expect(parseCase(handed.why)).toBe("sentry:3101");
      let record = readStore(deps.storePath).issues["sentry:3101"]!;
      expect(record.cycle).toBe(1);
      expect(record.state).toBe("observed");

      await draftIt(deps, "sentry:3101");
      expect((await poll(deps)).why).toContain("filed 1");
      record = readStore(deps.storePath).issues["sentry:3101"]!;
      expect(record.state).toBe("filed");
      expect(record.previousTickets).toEqual([`#${old}`]);
      expect(record.regressedAfter).toBe(`#${old}`);
      expect(record.cycle).toBe(1);
      const fresh1 = record.ticketNumber!;
      expect(fresh1).not.toBe(old);
      expect(record.ticket).toBe(`#${fresh1}`);
      const ticket = deps.tracker.issues.get(fresh1)!;
      expect(ticket.body.startsWith(`Regressed after #${old}.`)).toBe(true);
      expect(ticket.body).toContain("<!-- ralph-sentinel: sentry:3101 cycle 1 -->");
      expect(ticket.labels).toContain(SENTINEL_LABEL);
      // The closed ticket stays closed, and nothing was written on it.
      expect(deps.tracker.issues.get(old)!.state).toBe("closed");
      expect(deps.tracker.writes.slice(before).filter((write) => write.split(" ")[1] === String(old))).toEqual([]);
    });

    it("does nothing for a closed ticket whose issue stays resolved (AC3)", async () => {
      const seed = seedOf([fresh("3201")]);
      const deps = fileDeps(seed);
      const old = await fileIt(deps, "sentry:3201");
      closeTicket(deps.tracker, old);
      setEvents(seed, 40, { status: "resolved" });
      const writes = [...deps.tracker.writes];
      const stored = readStore(deps.storePath).issues["sentry:3201"]!;

      expect((await poll(deps)).work).toBe(false);
      expect(deps.tracker.writes).toEqual(writes);
      const record = readStore(deps.storePath).issues["sentry:3201"]!;
      expect(record.state).toBe("filed");
      expect(record.ticket).toBe(stored.ticket);
      expect(record.cycle).toBeUndefined();
    });

    it("in observe mode writes nothing to the tracker and keeps the would-be comment in the store (AC4)", async () => {
      const seed = seedOf([fresh("3301")]);
      const filing = fileDeps(seed);
      await fileIt(filing, "sentry:3301");
      const observe = fileDeps(seed, { rules: { mode: "observe" }, tracker: filing.tracker, storePath: filing.storePath });
      const writes = [...filing.tracker.writes];

      setEvents(seed, 24);
      expect((await poll(observe)).why).toContain("would comment 1");
      expect(filing.tracker.writes).toEqual(writes);
      const recurrence = readStore(filing.storePath).issues["sentry:3301"]!.recurrence!;
      expect(recurrence.comments).toHaveLength(1);
      expect(recurrence.comments[0]).toMatchObject({ posted: false, events: 24 });
      expect(recurrence.commentedOn).toBe("2026-11-04");
    });

    it("in observe mode reopens a closed ticket's record that came back and hands it over, writing nothing (AC4)", async () => {
      const seed = seedOf([fresh("3401")]);
      const filing = fileDeps(seed);
      const old = await fileIt(filing, "sentry:3401");
      // Past the grace, so the issue still firing counts without Sentry's flag.
      closeTicket(filing.tracker, old, REGRESSION_GRACE_HOURS + 5);
      // Neither new inside the lookback nor flagged regressed: the reopened record qualifies on its own.
      setEvents(seed, 12, { firstSeen: hoursAgo(400), regressed: false });
      const observe = fileDeps(seed, { rules: { mode: "observe" }, tracker: filing.tracker, storePath: filing.storePath });
      const writes = [...filing.tracker.writes];

      const handed = await poll(observe);
      expect(handed.work).toBe(true);
      expect(parseCase(handed.why)).toBe("sentry:3401");
      expect(filing.tracker.writes).toEqual(writes);
      const record = readStore(filing.storePath).issues["sentry:3401"]!;
      expect(record).toMatchObject({ state: "observed", cycle: 1, previousTickets: [`#${old}`], attempts: 1 });
    });

    it("leaves a ticket closed inside the grace alone while the issue is not flagged regressed", async () => {
      // A fix merged closes the ticket before its deploy; the old release keeps throwing until then.
      const seed = seedOf([fresh("3411")]);
      const deps = fileDeps(seed);
      const old = await fileIt(deps, "sentry:3411");
      closeTicket(deps.tracker, old, 3);
      setEvents(seed, 40, { firstSeen: hoursAgo(400), regressed: false });

      expect((await poll(deps)).work).toBe(false);
      expect(readStore(deps.storePath).issues["sentry:3411"]).toMatchObject({ state: "filed", ticket: `#${old}` });
    });

    it("never files again for a ticket closed as a duplicate or not planned", async () => {
      const seed = seedOf([fresh("3421")]);
      const deps = fileDeps(seed);
      const old = await fileIt(deps, "sentry:3421");
      closeTicket(deps.tracker, old, REGRESSION_GRACE_HOURS + 5, "canceled");
      setEvents(seed, 40, { firstSeen: hoursAgo(400), regressed: true });
      const issues = deps.tracker.issues.size;

      expect((await poll(deps)).work).toBe(false);
      expect(deps.tracker.issues.size).toBe(issues);
      expect(readStore(deps.storePath).issues["sentry:3421"]).toMatchObject({ state: "filed", ticket: `#${old}` });
    });

    it("moves a ticket it cannot read to the back of the rotation", async () => {
      const seed = seedOf([fresh("3431")]);
      const deps = fileDeps(seed);
      await fileIt(deps, "sentry:3431");
      deps.tracker.failNext("issue", new Error("issue was deleted"));

      expect((await poll(deps)).why).toContain("recurrence check failed for 1: issue was deleted");
      expect(readStore(deps.storePath).issues["sentry:3431"]!.recurrence!.checkedAt).toBe(NOW.toISOString());
    });

    it("in observe mode keeps a would-be comment for a drafted issue that doubled (AC4)", async () => {
      const seed = seedOf([fresh("3501")]);
      const deps = fileDeps(seed, { rules: { mode: "observe" } });
      expect((await poll(deps)).work).toBe(true);
      await draftIt(deps, "sentry:3501", "observe");
      expect((await poll(deps)).why).not.toContain("would comment");

      setEvents(seed, 24);
      expect((await poll(deps)).why).toContain("would comment 1");
      expect(deps.tracker.writes).toEqual([]);
      const recurrence = readStore(deps.storePath).issues["sentry:3501"]!.recurrence!;
      expect(recurrence.comments).toEqual([expect.objectContaining({ posted: false, events: 24, users: 2 })]);
    });

    it("sets the baseline of a record filed before recurrences on its first check, without commenting", async () => {
      const seed = seedOf([fresh("3601")]);
      const deps = fileDeps(seed);
      const number = await fileIt(deps, "sentry:3601");
      await withStore(deps.storePath, (store) => {
        const record = store.issues["sentry:3601"]!;
        delete record.recurrence;
        delete record.ticketNumber;
      });

      setEvents(seed, 30);
      expect((await poll(deps)).why).not.toContain("commented");
      expect(commentsOn(deps.tracker, number)).toEqual([]);
      expect(readStore(deps.storePath).issues["sentry:3601"]!.recurrence).toMatchObject({ baseline: 30, comments: [] });

      setEvents(seed, 60);
      expect((await poll(deps)).why).toContain("commented 1");
      expect(commentsOn(deps.tracker, number)).toHaveLength(1);
    });

    it("gives the day back when the comment fails, so the next poll retries it", async () => {
      const seed = seedOf([fresh("3701")]);
      const deps = fileDeps(seed);
      const number = await fileIt(deps, "sentry:3701");
      setEvents(seed, 24);
      deps.tracker.failNext("comment", new Error("tracker answered 502\nretry later"));

      expect((await poll(deps)).why).toContain("recurrence check failed for 1: tracker answered 502");
      expect(commentsOn(deps.tracker, number)).toEqual([]);
      const recurrence = readStore(deps.storePath).issues["sentry:3701"]!.recurrence!;
      expect(recurrence.commentedOn).toBeNull();
      expect(recurrence.comments).toEqual([]);

      expect((await poll(deps)).why).toContain("commented 1");
      expect(commentsOn(deps.tracker, number)).toHaveLength(1);
    });
  });
});
