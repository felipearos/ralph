// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  choose,
  detect,
  effectiveRule,
  LIMIT_FILE,
  parseOverride,
  parseRegistry,
  projectRule,
  readLimit,
  ROUTER_FULL_FILE,
  suggestName,
  type Account,
  type Limit,
} from "./claude-account";
import { claudeAccountsProblems, rosterEntries } from "./project-config";
import { subprocessSuite } from "./test-timeouts";
import { scratchDir } from "./test-scratch";

subprocessSuite("runs bun claude-account.ts pick, mark, list, add, remove, view and assign");

const NOW = Date.parse("2026-11-25T12:00:00Z");
const A: Account = { name: "acme-a", configDir: "/accounts/a" };
const B: Account = { name: "acme-b", configDir: "/accounts/b" };
const C: Account = { name: "acme-c", configDir: "/accounts/c" };
const limitedUntil = (ms: number): Limit => ({ untilMs: ms, window: "five_hour", source: "ralph" });
const limits = (table: Record<string, Limit | null>) => (account: Account) => table[account.name] ?? null;

describe("choose", () => {
  it("is the environment's account with no rule", () => {
    expect(choose(null, [A, B], limits({}), NOW).verdict).toBe("default");
  });

  it("runs on the first account in use while it is not at its limit", () => {
    const choice = choose({ use: ["acme-b", "acme-a"], onLimit: "next" }, [A, B], limits({}), NOW);
    expect(choice).toMatchObject({ verdict: "run", account: B, onLimit: "next" });
  });

  it("moves on to the next account in use that is not at its limit", () => {
    const choice = choose({ use: ["acme-a", "acme-b", "acme-c"], onLimit: "next" }, [A, B, C], limits({ "acme-a": limitedUntil(NOW + 60_000) }), NOW);
    expect(choice).toMatchObject({ verdict: "run", account: B });
    expect(choice.detail).toContain("acme-a at its limit until");
  });

  it("waits for the earliest reset when every account in use is at its limit", () => {
    const choice = choose(
      { use: ["acme-a", "acme-b"], onLimit: "next" },
      [A, B],
      limits({ "acme-a": limitedUntil(NOW + 600_000), "acme-b": limitedUntil(NOW + 60_000) }),
      NOW,
    );
    expect(choice).toMatchObject({ verdict: "wait", account: B, seconds: 60 });
  });

  it("never waits past the cap, nor for nothing", () => {
    const far = choose({ use: ["acme-a"] }, [A], limits({ "acme-a": limitedUntil(NOW + 30 * 86_400_000) }), NOW, 3600);
    expect(far).toMatchObject({ verdict: "wait", seconds: 3600 });
    const near = choose({ use: ["acme-a"] }, [A], limits({ "acme-a": limitedUntil(NOW + 10) }), NOW);
    expect(near).toMatchObject({ verdict: "wait", seconds: 1 });
  });

  it("keeps a wait loop on its first account even when the next one is free", () => {
    const choice = choose({ use: ["acme-a", "acme-b"], onLimit: "wait" }, [A, B], limits({ "acme-a": limitedUntil(NOW + 60_000) }), NOW);
    expect(choice).toMatchObject({ verdict: "wait", account: A });
  });

  it("stops a stop loop when its account is at its limit", () => {
    const choice = choose({ use: ["acme-a", "acme-b"], onLimit: "stop" }, [A, B], limits({ "acme-a": limitedUntil(NOW + 60_000) }), NOW);
    expect(choice).toMatchObject({ verdict: "stop", account: A });
  });

  it("defaults the policy to wait", () => {
    expect(choose({ use: ["acme-a"] }, [A], limits({}), NOW).onLimit).toBe("wait");
  });

  it("skips accounts this host does not register, and falls back to the environment when none is", () => {
    const skipped = choose({ use: ["acme-x", "acme-a"], onLimit: "next" }, [A], limits({}), NOW);
    expect(skipped).toMatchObject({ verdict: "run", account: A });
    expect(skipped.detail).toContain("not registered on this host: acme-x");
    // `wait` looks at the first REGISTERED account, not the first name.
    expect(choose({ use: ["acme-x", "acme-a"] }, [A], limits({}), NOW)).toMatchObject({ verdict: "run", account: A });
    expect(choose({ use: ["acme-x"] }, [A], limits({}), NOW).verdict).toBe("default");
  });
});

describe("parseRegistry", () => {
  it("reads accounts and drops only the bad entries", () => {
    const { accounts, problem } = parseRegistry(
      JSON.stringify({ accounts: { "acme-a": { configDir: "/a" }, "Bad Name": { configDir: "/b" }, "acme-c": {} } }),
    );
    expect(accounts).toEqual([{ name: "acme-a", configDir: "/a" }]);
    expect(problem).toContain("'Bad Name' is not an account name");
    expect(problem).toContain("'acme-c' needs a 'configDir'");
  });

  it("is empty with a reason for a file that is not a registry", () => {
    expect(parseRegistry("{").accounts).toEqual([]);
    expect(parseRegistry("[]").problem).toContain("'accounts'");
  });
});

describe("readLimit", () => {
  const dir = () => {
    const path = scratchDir("claude-account-limit-");
    mkdirSync(path, { recursive: true });
    return path;
  };

  it("reads the loop's mark until it passes", () => {
    const path = dir();
    writeFileSync(join(path, LIMIT_FILE), JSON.stringify({ until: new Date(NOW + 60_000).toISOString(), window: "seven_day" }));
    expect(readLimit(path, NOW)).toEqual({ untilMs: NOW + 60_000, window: "seven_day", source: "ralph" });
    expect(readLimit(path, NOW + 60_000)).toBeNull();
  });

  it("honours the account router's marker, and the later of the two", () => {
    const path = dir();
    writeFileSync(join(path, ROUTER_FULL_FILE), String((NOW + 120_000) / 1000));
    expect(readLimit(path, NOW)).toMatchObject({ untilMs: NOW + 120_000, source: "router" });
    writeFileSync(join(path, LIMIT_FILE), JSON.stringify({ until: new Date(NOW + 60_000).toISOString() }));
    expect(readLimit(path, NOW)).toMatchObject({ untilMs: NOW + 120_000, source: "router" });
  });

  it("is no limit for a missing or unreadable mark", () => {
    const path = dir();
    expect(readLimit(path, NOW)).toBeNull();
    writeFileSync(join(path, LIMIT_FILE), "not json");
    writeFileSync(join(path, ROUTER_FULL_FILE), "soon");
    expect(readLimit(path, NOW)).toBeNull();
  });
});

describe("effectiveRule", () => {
  const roster = rosterEntries([
    "acme-coder",
    { name: "acme-own", claudeAccounts: { use: ["acme-b"] } },
    { name: "acme-env", claudeAccounts: null },
  ]);
  const project = { use: ["acme-a"], onLimit: "next" as const };

  it("prefers the loop's entry, then the project's", () => {
    expect(effectiveRule("acme-own", { roster, claudeAccounts: project })).toEqual({ rule: { use: ["acme-b"] }, source: "config-loop" });
    expect(effectiveRule("acme-coder", { roster, claudeAccounts: project })).toEqual({ rule: project, source: "config" });
  });

  it("lets a loop opt out with null, and has no rule without config", () => {
    expect(effectiveRule("acme-env", { roster, claudeAccounts: project })).toEqual({ rule: null, source: "config-loop" });
    expect(effectiveRule("acme-coder", { roster })).toEqual({ rule: null, source: "none" });
    expect(effectiveRule("acme-coder", null)).toEqual({ rule: null, source: "none" });
  });
});

describe("the host override", () => {
  const roster = rosterEntries([{ name: "acme-coder" }, { name: "acme-own", claudeAccounts: { use: ["acme-b"] } }] as never);
  const config = { roster, claudeAccounts: { use: ["acme-a"] } };

  it("is read before the committed config: the loop's entry, then the project's", () => {
    const override = parseOverride(
      JSON.stringify({ entries: { "*": { rule: { use: ["acme-c"], onLimit: "stop" } }, "acme-coder": { rule: { use: ["acme-b"] } } } }),
    ).override;
    expect(effectiveRule("acme-coder", config, override)).toEqual({ rule: { use: ["acme-b"] }, source: "override" });
    expect(effectiveRule("acme-own", config, override)).toEqual({ rule: { use: ["acme-c"], onLimit: "stop" }, source: "override-project" });
    expect(projectRule(config, override)).toEqual({ rule: { use: ["acme-c"], onLimit: "stop" }, source: "override-project" });
    expect(projectRule(config, null)).toEqual({ rule: { use: ["acme-a"] }, source: "config" });
  });

  it("takes null as the environment's account", () => {
    const override = parseOverride(JSON.stringify({ entries: { "acme-coder": { rule: null } } })).override;
    expect(effectiveRule("acme-coder", config, override)).toEqual({ rule: null, source: "override" });
  });

  it("drops a bad entry, never the whole file", () => {
    const { override, problem } = parseOverride(JSON.stringify({ entries: { "*": { rule: { use: [] } }, "acme-coder": { rule: { use: ["acme-a"] } } } }));
    expect(Object.keys(override!.entries)).toEqual(["acme-coder"]);
    expect(problem).toContain("entries.*.rule.use");
    expect(parseOverride("nope").override).toBeNull();
  });
});

describe("detect", () => {
  it("finds .claude and .claude-* directories holding a login or a profile", () => {
    const home = scratchDir("claude-account-home-");
    for (const name of [".claude", ".claude-acme", ".claude-empty", ".config"]) mkdirSync(join(home, name), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    writeFileSync(join(home, ".claude-acme", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "dev@example.org", organizationName: "Acme" } }));
    writeFileSync(join(home, ".claude-file"), "not a directory");
    const rows = detect([{ name: "acme-main", configDir: join(home, ".claude") }], { HOME: home });
    expect(rows).toEqual([
      { configDir: join(home, ".claude"), suggestedName: "acme-main", loggedIn: true, email: null, organization: null, registeredAs: "acme-main" },
      { configDir: join(home, ".claude-acme"), suggestedName: "acme", loggedIn: false, email: "dev@example.org", organization: "Acme", registeredAs: null },
    ]);
  });

  it("suggests a free registry name from the directory", () => {
    expect(suggestName("/h/.claude", new Set())).toBe("default");
    expect(suggestName("/h/.claude-Work Stuff", new Set())).toBe("work-stuff");
    expect(suggestName("/h/.claude-acme", new Set(["acme"]))).toBe("acme-2");
  });
});

describe("claudeAccountsProblems", () => {
  it("accepts a list of names and a policy", () => {
    expect(claudeAccountsProblems({ use: ["acme-a", "acme_b"], onLimit: "next" }, "claudeAccounts", false)).toEqual([]);
    expect(claudeAccountsProblems(null, "loops[0].claudeAccounts", true)).toEqual([]);
  });

  it("names every problem", () => {
    expect(claudeAccountsProblems(null, "claudeAccounts", false)).toHaveLength(1);
    expect(claudeAccountsProblems({ use: [] }, "c", false)).toEqual(["'c.use' must be a non-empty list of account names"]);
    const problems = claudeAccountsProblems({ use: ["acme-a", "acme-a", "Acme B"], onLimit: "later", extra: 1 }, "c", false);
    expect(problems).toEqual([
      "unknown key 'c.extra'",
      "'c.use' repeats 'acme-a'",
      "'c.use[2]' must be an account name (lowercase letters, digits, '-' or '_'); got \"Acme B\"",
      "'c.onLimit' must be one of wait, next, stop",
    ]);
  });
});

describe("the CLI", () => {
  const scratch = () => {
    const root = scratchDir("claude-account-cli-");
    const project = join(root, "project");
    mkdirSync(join(project, ".ralph"), { recursive: true });
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    return { root, project, home, registry: join(root, "claude-accounts.json"), override: join(root, "override.json") };
  };
  const cli = (where: ReturnType<typeof scratch>, args: string[], env: Record<string, string> = {}) =>
    spawnSync("bun", [join(import.meta.dirname, "claude-account.ts"), ...args], {
      cwd: where.project,
      encoding: "utf8",
      env: {
        ...process.env,
        RALPH_PROJECT: where.project,
        RALPH_CLAUDE_ACCOUNTS_FILE: where.registry,
        RALPH_CLAUDE_ACCOUNTS_OVERRIDE_FILE: where.override,
        RALPH_USAGE_NOW_MS: String(NOW),
        HOME: where.home,
        CLAUDE_CONFIG_DIR: "",
        ...env,
      },
    });

  it("registers accounts, picks one for a loop, marks it spent and moves on", () => {
    const where = scratch();
    const first = join(where.root, "first");
    const second = join(where.root, "second");
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, ".credentials.json"), "{}");
    expect(cli(where, ["add", "--name", "acme-a", "--dir", first]).status).toBe(0);
    expect(cli(where, ["add", "--name", "acme-b", "--dir", second]).status).toBe(0);
    writeFileSync(
      join(where.project, ".ralph", "config.json"),
      readFileSync(join(import.meta.dirname, "fixtures", "loggd", ".ralph", "config.json"), "utf8").replace(
        /^\{/,
        '{\n  "claudeAccounts": { "use": ["acme-a", "acme-b"], "onLimit": "next" },',
      ),
    );

    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toBe(`run\tacme-a\t${first}\t0\tnext\trunning on Claude account acme-a (onLimit next)\n`);

    const state = join(where.root, "usage-wait.json");
    writeFileSync(state, JSON.stringify({ until: new Date(NOW + 3_600_000).toISOString(), window: "five_hour" }));
    expect(cli(where, ["mark", "--account", "acme-a", "--state", state, "--loop", "ralph"]).status).toBe(0);
    expect(existsSync(join(first, LIMIT_FILE))).toBe(true);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^run\tacme-b\t/);

    const listed = JSON.parse(cli(where, ["list", "--json"]).stdout) as { accounts: { name: string; loggedIn: boolean; limitedUntil: string | null }[] };
    expect(listed.accounts.map(({ name, loggedIn, limitedUntil }) => ({ name, loggedIn, limited: limitedUntil !== null }))).toEqual([
      { name: "acme-a", loggedIn: false, limited: true },
      { name: "acme-b", loggedIn: true, limited: false },
    ]);

    expect(cli(where, ["clear", "--account", "acme-a"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^run\tacme-a\t/);
    expect(cli(where, ["remove", "--name", "acme-a"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^run\tacme-b\t/);
  });

  it("never shortens a mark another loop left", () => {
    const where = scratch();
    const dir = join(where.root, "a");
    cli(where, ["add", "--name", "acme-a", "--dir", dir]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LIMIT_FILE), JSON.stringify({ until: new Date(NOW + 7_200_000).toISOString() }));
    const state = join(where.root, "usage-wait.json");
    writeFileSync(state, JSON.stringify({ until: new Date(NOW + 60_000).toISOString() }));
    expect(cli(where, ["mark", "--account", "acme-a", "--state", state]).status).toBe(0);
    expect(readLimit(dir, NOW)?.untilMs).toBe(NOW + 7_200_000);
  });

  it("picks the environment's account, exit 0, when nothing can be read", () => {
    const where = scratch();
    const run = cli(where, ["pick", "--loop", "ralph"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^default\t-\t-\t0\twait\t/);
  });

  it("marks nothing for an unknown account or a missing state", () => {
    const where = scratch();
    expect(cli(where, ["mark", "--account", "acme-a", "--state", join(where.root, "nope.json")]).status).toBe(1);
  });
  it("assigns an account to a loop and to the project on this host, and the loop picks it", () => {
    const where = scratch();
    writeFileSync(
      join(where.project, ".ralph", "config.json"),
      readFileSync(join(import.meta.dirname, "fixtures", "loggd", ".ralph", "config.json"), "utf8"),
    );
    const a = join(where.home, ".claude-acme-a");
    const b = join(where.home, ".claude-acme-b");
    expect(cli(where, ["add", "--name", "acme-a", "--dir", a]).status).toBe(0);
    expect(existsSync(a)).toBe(true);
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, ".credentials.json"), "{}");

    // Not registered yet: refused, and nothing written.
    expect(cli(where, ["assign", "--target", "*", "--use", "acme-b"]).status).toBe(1);
    expect(existsSync(where.override)).toBe(false);
    expect(cli(where, ["add", "--name", "acme-b", "--dir", b]).status).toBe(0);
    expect(cli(where, ["add", "--name", "acme-c", "--dir", b]).status).toBe(1);

    expect(cli(where, ["assign", "--target", "*", "--use", "acme-a,acme-b", "--on-limit", "next"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^run\tacme-a\t/);
    expect(cli(where, ["assign", "--target", "ralph", "--use", "acme-b", "--on-limit", "stop"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^run\tacme-b\t.*\tstop\t/);
    expect(cli(where, ["assign", "--target", "nobody", "--use", "acme-b"]).status).toBe(1);

    const view = JSON.parse(cli(where, ["view", "--json"]).stdout) as {
      version: number;
      accounts: { name: string; loggedIn: boolean }[];
      detected: { configDir: string; registeredAs: string | null }[];
      project: { source: string; rule: unknown };
      loops: { loop: string; own: boolean; source: string; choice: { verdict: string } }[];
    };
    expect(view.version).toBe(1);
    expect(view.accounts.map((account) => [account.name, account.loggedIn])).toEqual([
      ["acme-a", false],
      ["acme-b", true],
    ]);
    expect(view.detected).toEqual([expect.objectContaining({ configDir: b, registeredAs: "acme-b" })]);
    expect(view.project).toMatchObject({ source: "override-project", rule: { use: ["acme-a", "acme-b"], onLimit: "next" } });
    expect(view.loops.find((loop) => loop.loop === "ralph")).toMatchObject({ own: true, source: "override", choice: { verdict: "run" } });

    expect(cli(where, ["assign", "--target", "ralph", "--env"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^default\t/);
    expect(cli(where, ["unassign", "--target", "ralph"]).status).toBe(0);
    expect(cli(where, ["unassign", "--target", "*"]).status).toBe(0);
    expect(cli(where, ["pick", "--loop", "ralph"]).stdout).toMatch(/^default\t/);
  });

  it("views a project whose config cannot be read, saying why", () => {
    const where = scratch();
    const run = cli(where, ["view", "--json"]);
    expect(run.status).toBe(0);
    const view = JSON.parse(run.stdout) as { configProblem: string | null; loops: unknown[] };
    expect(view.configProblem).toContain("config.json");
    expect(view.loops).toEqual([]);
  });
});
