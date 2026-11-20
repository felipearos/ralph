import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  createLiveRules,
  describeRulesChange,
  freshestConfig,
  liveRulesStatePath,
  realGit,
  withLiveRules,
  type LiveRulesOptions,
} from "./live-rules";
import { parseProjectConfig, sentinelRules, type SentinelRules } from "./project-config";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs git against temporary bare origins and their clones");

const FIXTURE = join(__dirname, "fixtures", "loggd", ".ralph");
// Pinned to observe whatever loggd's live mode is: the fixture mirrors loggd
// (fixture-mirror.test.ts), and these tests are about a change FROM observe.
const FIXTURE_CONFIG = JSON.parse(readFileSync(join(FIXTURE, "config.json"), "utf8")) as Record<string, unknown> & {
  sentinel: Record<string, unknown>;
};
const BASE: typeof FIXTURE_CONFIG = { ...FIXTURE_CONFIG, sentinel: { ...FIXTURE_CONFIG.sentinel, mode: "observe" } };

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);
  return out.stdout.trim();
}

/** Loggd's fixture config with the sentinel block edited. */
const withSentinel = (edit: Record<string, unknown>): Record<string, unknown> => ({ ...BASE, sentinel: { ...BASE.sentinel, ...edit } });

/**
 * A bare origin, a "maintainer" clone that pushes to it, and the gate's own
 * clone, all in a scratch directory — never this checkout.
 */
function repos(): { origin: string; upstream: string; root: string; push: (text: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "ralph-live-rules-"));
  scratch.push(dir);
  const origin = join(dir, "origin.git");
  const upstream = join(dir, "upstream");
  const root = join(dir, "worktree");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", upstream);
  git(upstream, "config", "user.email", "t@example.com");
  git(upstream, "config", "user.name", "t");
  cpSync(FIXTURE, join(upstream, ".ralph"), { recursive: true });
  writeFileSync(join(upstream, ".ralph", "config.json"), JSON.stringify(BASE));
  // As a real project's: the kept copy lives in the ignored logs directory.
  writeFileSync(join(upstream, ".gitignore"), ".ralph/logs/\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-q", "-m", "init");
  git(upstream, "remote", "add", "origin", origin);
  git(upstream, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, root);
  const push = (text: string): string => {
    writeFileSync(join(upstream, ".ralph", "config.json"), text);
    git(upstream, "commit", "-q", "-am", "rules");
    git(upstream, "push", "-q", "origin", "main");
    return git(upstream, "rev-parse", "HEAD");
  };
  return { origin, upstream, root, push };
}

/** A clock the test moves, so the rate limit is crossed without sleeping. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function live(root: string, extra: Partial<LiveRulesOptions<SentinelRules>> = {}) {
  const config = parseProjectConfig(readFileSync(join(root, ".ralph", "config.json"), "utf8"));
  return createLiveRules<SentinelRules>({
    root,
    role: "sentinel",
    baseBranch: "main",
    extract: sentinelRules,
    initial: { config, rules: sentinelRules(config)!, source: "the worktree" },
    minFetchIntervalMs: 60_000,
    ...extra,
  });
}

describe("live rules from origin", () => {
  it("picks up a rules change pushed to origin on the next refresh, and says so once", async () => {
    const { root, push } = repos();
    const time = clock();
    const rules = live(root, { now: time.now });

    const first = await rules.refresh();
    expect(first.problem).toBeNull();
    expect(first.changed).toBe(false);
    expect(first.lines).toEqual([]);
    expect(first.rules.mode).toBe("observe");

    const commit = push(JSON.stringify(withSentinel({ mode: "file", maxPerDay: 10 })));
    time.advance(60_000);
    const second = await rules.refresh();
    expect(second.problem).toBeNull();
    expect(second.changed).toBe(true);
    expect(second.rules.mode).toBe("file");
    expect(second.rules.maxPerDay).toBe(10);
    expect(second.source).toBe(`origin/main@${commit.slice(0, 8)}`);
    expect(second.lines).toEqual(["rules changed on origin/main — maxPerDay 5 → 10, mode observe → file"]);

    time.advance(60_000);
    const third = await rules.refresh();
    expect(third.changed).toBe(false);
    expect(third.lines).toEqual([]);
  });

  it("does not fetch again inside the interval, but still reads what another fetch brought", async () => {
    const { root, push } = repos();
    const time = clock();
    const fetches: string[][] = [];
    const rules = live(root, {
      now: time.now,
      git: (args, options) => {
        if (args[0] === "fetch") fetches.push(args);
        return realGit(args, options);
      },
    });
    await rules.refresh();
    push(JSON.stringify(withSentinel({ minEvents: 3 })));
    const inside = await rules.refresh();
    expect(fetches).toHaveLength(1);
    expect(inside.rules.minEvents).toBe(10);
    // Another loop on the host fetched: the shared ref moved without this module.
    git(root, "fetch", "-q", "origin", "main");
    const after = await rules.refresh();
    expect(fetches).toHaveLength(1);
    expect(after.rules.minEvents).toBe(3);
  });

  it("keeps the last valid rules over a malformed or invalid config, and says why once per reason", async () => {
    const { root, push } = repos();
    const time = clock();
    const rules = live(root, { now: time.now });
    push(JSON.stringify(withSentinel({ mode: "file" })));
    expect((await rules.refresh()).rules.mode).toBe("file");

    push("{ not json");
    time.advance(60_000);
    const malformed = await rules.refresh();
    expect(malformed.rules.mode).toBe("file");
    expect(malformed.changed).toBe(false);
    expect(malformed.problem).toMatch(/origin\/main:\.ralph\/config\.json is not valid JSON/);
    expect(malformed.lines).toHaveLength(1);
    expect(malformed.lines[0]).toMatch(/^rules may be stale — .*not valid JSON.*; keeping the rules from origin\/main@/);

    time.advance(60_000);
    expect((await rules.refresh()).lines).toEqual([]);

    push(JSON.stringify(withSentinel({ mode: "loud", maxPerDay: -1 })));
    time.advance(60_000);
    const invalid = await rules.refresh();
    expect(invalid.rules.mode).toBe("file");
    expect(invalid.problem).toMatch(/origin\/main:\.ralph\/config\.json is invalid: .*mode/);
    expect(invalid.lines).toHaveLength(1);

    const { sentinel: _gone, ...noBlock } = BASE;
    void _gone;
    const loops = (BASE.loops as unknown[]).filter((loop) => (loop as { role?: string }).role !== "sentinel");
    push(JSON.stringify({ ...noBlock, loops }));
    time.advance(60_000);
    const missing = await rules.refresh();
    expect(missing.rules.mode).toBe("file");
    expect(missing.problem).toBe("origin/main:.ralph/config.json has no 'sentinel' block");

    push(JSON.stringify(withSentinel({ mode: "observe" })));
    time.advance(60_000);
    const back = await rules.refresh();
    expect(back.problem).toBeNull();
    expect(back.rules.mode).toBe("observe");
    expect(back.lines).toEqual([
      "rules changed on origin/main — mode file → observe",
      expect.stringMatching(/^rules read from origin\/main@\w{8} again$/),
    ]);
  });

  it("degrades on a fetch that fails, then reads the ref as last fetched", async () => {
    const { root, origin } = repos();
    const time = clock();
    const rules = live(root, { now: time.now });
    await rules.refresh();
    git(root, "remote", "set-url", "origin", join(origin, "..", "gone.git"));
    time.advance(60_000);
    const failed = await rules.refresh();
    expect(failed.rules.mode).toBe("observe");
    expect(failed.problem).toMatch(/^could not fetch origin\/main: .*; using origin\/main as last fetched$/);
    expect(failed.lines).toHaveLength(1);
  });

  it("degrades on a fetch that hangs past its timeout", async () => {
    const { root } = repos();
    // The local transport runs upload-pack through the shell: this one hangs.
    git(root, "config", "remote.origin.uploadpack", "sleep 30; git-upload-pack");
    const time = clock();
    const rules = live(root, { now: time.now, fetchTimeoutMs: 500 });
    const started = Date.now();
    const hung = await rules.refresh();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(hung.problem).toMatch(/could not fetch origin\/main: timed out after 500ms/);
    expect(hung.rules.mode).toBe("observe");
  });

  it("degrades with no origin remote, and with no such branch on origin", async () => {
    const { root } = repos();
    const noBranch = await live(root, { baseBranch: "trunk" }).refresh();
    expect(noBranch.problem).toMatch(/^could not fetch origin\/trunk: /);
    expect(noBranch.rules.mode).toBe("observe");
    expect(noBranch.source).toBe("the worktree");

    git(root, "remote", "remove", "origin");
    const noRemote = await live(root, { statePath: null }).refresh();
    expect(noRemote.problem).toMatch(/^could not fetch origin\/main: /);
    expect(noRemote.rules.mode).toBe("observe");
    expect(noRemote.lines[0]).toMatch(/keeping the rules from the worktree$/);
  });

  it("keeps the last valid copy for a restart, and an iteration reads it while it is newer than HEAD", async () => {
    const { root, push } = repos();
    const commit = push(JSON.stringify(withSentinel({ mode: "file" })));
    await live(root).refresh();
    const state = liveRulesStatePath(root, "sentinel");
    expect(existsSync(state)).toBe(true);
    // Under the worktree's ignored logs, never in git.
    expect(git(root, "status", "--porcelain", "--ignored=no")).toBe("");

    const fresh = freshestConfig(root, "sentinel");
    expect(fresh.commit).toBe(commit);
    expect(sentinelRules(fresh.config)?.mode).toBe("file");

    // A restarted gate starts from it, and says nothing changed.
    const restarted = createLiveRules<SentinelRules>({
      root,
      role: "sentinel",
      baseBranch: "main",
      extract: sentinelRules,
      initial: { config: fresh.config, rules: sentinelRules(fresh.config)!, source: fresh.source },
    });
    const first = await restarted.refresh();
    expect(first.changed).toBe(false);
    expect(first.lines).toEqual([]);

    // The worktree fast-forwarded past it: the worktree's own config wins again.
    git(root, "checkout", "-q", "--detach", "origin/main");
    writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify(withSentinel({ mode: "observe" })));
    git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-am", "local");
    expect(sentinelRules(freshestConfig(root, "sentinel").config)?.mode).toBe("observe");
  });

  it("falls back to the worktree when the kept copy is unreadable", () => {
    const { root } = repos();
    const state = liveRulesStatePath(root, "sentinel");
    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(state, "not json");
    expect(freshestConfig(root, "sentinel").source).toBe("the worktree");
  });
});

describe("withLiveRules", () => {
  it("rewires on a change, keeps the deps otherwise, and never rejects", async () => {
    const { root, push } = repos();
    const time = clock();
    const rules = live(root, { now: time.now });
    const lines: string[] = [];
    const initial = { rules: rules.current().rules, wiredFrom: "start" };
    const rewire = (config: ReturnType<typeof parseProjectConfig>) => ({ rules: sentinelRules(config)!, wiredFrom: "fresh" });

    const same = await withLiveRules(rules, initial, rewire, (line) => lines.push(line));
    expect(same).toBe(initial);

    push(JSON.stringify(withSentinel({ reporter: { kind: "sentry", org: "acme", project: "web", environment: "production" } })));
    time.advance(60_000);
    const changed = await withLiveRules(rules, initial, rewire, (line) => lines.push(line));
    expect(changed.wiredFrom).toBe("fresh");
    expect(changed.rules.reporter.project).toBe("web");
    expect(lines).toEqual([expect.stringMatching(/^rules changed on origin\/main — reporter\.org faros-o9 → acme, /)]);

    push(JSON.stringify(withSentinel({ minUsers: 7 })));
    time.advance(60_000);
    const kept = await withLiveRules(rules, changed, () => { throw new Error("no wiring"); }, (line) => lines.push(line));
    expect(kept.wiredFrom).toBe("fresh");
    expect(kept.rules.minUsers).toBe(7);
    expect(lines.at(-1)).toMatch(/could not be rewired for them \(no wiring\)/);

    const broken = { refresh: () => Promise.reject(new Error("boom")), current: rules.current };
    expect(await withLiveRules(broken, kept, rewire, () => {})).toBe(kept);
  });
});

describe("describeRulesChange", () => {
  it("names each changed rule by its path", () => {
    expect(describeRulesChange({ mode: "observe", n: 1, a: { b: [1, 2] }, e: null }, { mode: "file", n: 1, a: { b: [1] }, e: "x" }))
      .toBe('mode observe → file, a.b [1,2] → [1], e none → x');
    expect(describeRulesChange({ mode: "file" }, { mode: "file" })).toBe("");
  });
});
