#!/usr/bin/env bun
/**
 * Which Claude account a loop runs on, and what it does when that account's
 * usage limit is spent.
 *
 * A host may have several Claude Code accounts logged in, each in its own
 * config directory (`CLAUDE_CONFIG_DIR`). The host registers them by name in
 * a file that never leaves it, since a directory is a host fact and a name
 * may be a client's (house rule 5):
 *
 *   $RALPH_CLAUDE_ACCOUNTS_FILE, else $XDG_CONFIG_HOME/ralph/claude-accounts.json
 *   (else ~/.config/ralph/claude-accounts.json):
 *
 *   { "accounts": { "personal": { "configDir": "~/.claude" },
 *                   "work":     { "configDir": "~/.claude-work" } } }
 *
 * A project picks among them in `.ralph/config.json`, for all its loops or
 * for one (`loops[i].claudeAccounts`, `null` for "the environment's"):
 *
 *   "claudeAccounts": { "use": ["work", "personal"], "onLimit": "next" }
 *
 * The dashboard (and an operator) may override that on this host without a
 * commit: `<git-common-dir>/ralph-claude-accounts.json`, keyed by loop name
 * or `*` for the whole project, read before the committed config:
 *
 *   { "entries": { "*": { "rule": { "use": ["work"], "onLimit": "wait" } },
 *                  "acme-coder": { "rule": null } } }
 *
 * `onLimit` says what happens when the account a loop runs on hits its usage
 * limit: `wait` (the default) waits for that account's reset; `next` moves to
 * the next account in `use` that is not at its limit and waits only when
 * every one is, for the earliest reset; `stop` stops the loop as blocked,
 * claim kept. With `wait` and `stop` only the first registered account in
 * `use` ever runs.
 *
 * A limit is the account's, not the loop's, so the loop that hits it marks
 * the account (`<configDir>/.ralph-limit.json`) and every loop on that account
 * — in any project on the host — sees it at its next checkpoint instead of
 * spending a turn to learn it. The account router's own marker
 * (`<configDir>/.router-full-until`, unix seconds) counts the same.
 *
 * Every doubt falls back to today's behaviour, never to a stuck loop: no rule,
 * no registry, no registered account in `use`, or an error all mean `default`
 * — run on the environment's account, `CLAUDE_CONFIG_DIR` untouched. A wait is
 * never longer than RALPH_CLAUDE_ACCOUNT_MAX_WAIT_SECONDS (7 days).
 *
 * Usage:
 *   claude-account.ts pick --loop <name>
 *       one line, tab-separated, always exit 0:
 *       <default|run|wait|stop> <account|-> <configDir|-> <seconds> <onLimit> <detail>
 *       seconds: how long a wait lasts (0 otherwise).
 *   claude-account.ts mark --account <name> --state <usage-wait.json> [--loop <name>]
 *       record that the account is at its limit until the reset the loop's
 *       usage wait names (`usage-limit.ts detect`). Exit 0, or 1 when nothing
 *       was written.
 *   claude-account.ts show --loop <name>
 *       the rule, the accounts and the choice, as JSON.
 *   claude-account.ts list [--json]
 *       every registered account: its directory, whether it is logged in and
 *       until when it is at its limit.
 *   claude-account.ts add --name <name> --dir <configDir>
 *   claude-account.ts remove --name <name>
 *       edit the registry. Log an account in once with
 *       `CLAUDE_CONFIG_DIR=<configDir> claude` and `/login`.
 *   claude-account.ts clear --account <name>
 *       forget the account's limit mark (it was lifted early, or was wrong).
 *   claude-account.ts detect [--json]
 *       the Claude config directories in $HOME (`.claude`, `.claude-*`) and
 *       $CLAUDE_CONFIG_DIR, with the login each holds and the registered name.
 *   claude-account.ts view --json
 *       everything the dashboard draws for the project at the working
 *       directory: accounts, detected directories, and each loop's rule,
 *       where it comes from and the account it runs on now.
 *   claude-account.ts assign --target <loop|*> (--use <a,b> [--on-limit wait|next|stop] | --env)
 *   claude-account.ts unassign --target <loop|*>
 *       write or drop this host's override for a loop or the project.
 *
 * RALPH_USAGE_NOW_MS overrides the clock (tests only).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CLAUDE_ACCOUNT_NAME,
  CLAUDE_ON_LIMIT,
  CLAUDE_ON_LIMIT_DEFAULT,
  claudeAccountsProblems,
  loadProjectConfig,
  type ClaudeAccountsRule,
  type ClaudeOnLimit,
  type ProjectConfig,
} from "./project-config";

/** The mark a loop leaves in an account's directory when its limit rejects a turn. */
export const LIMIT_FILE = ".ralph-limit.json";
/** The account router's marker (unix seconds), honoured as the same fact. */
export const ROUTER_FULL_FILE = ".router-full-until";
/** Where an account keeps its login on Linux; its absence means "not logged in". */
const CREDENTIALS_FILE = ".credentials.json";
/** Where an account keeps its profile (`oauthAccount`): who it is logged in as. */
const PROFILE_FILE = ".claude.json";
/** This host's override, in git's common directory beside the leases. */
export const OVERRIDE_FILE = "ralph-claude-accounts.json";
/** The override's project-wide key. */
export const PROJECT_KEY = "*";
const DEFAULT_MAX_WAIT_SECONDS = 7 * 24 * 3600;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export interface Account {
  name: string;
  configDir: string;
}

export interface Limit {
  untilMs: number;
  window: string | null;
  source: "ralph" | "router";
}

export type RuleSource = "override" | "override-project" | "config-loop" | "config" | "none";

export interface OverrideEntry {
  /** The rule, or null for "the environment's account". */
  rule: ClaudeAccountsRule | null;
  at: string;
}

export interface Override {
  entries: Record<string, OverrideEntry>;
}

export type Choice =
  | { verdict: "default"; onLimit: ClaudeOnLimit; detail: string }
  | { verdict: "run" | "stop"; account: Account; onLimit: ClaudeOnLimit; detail: string }
  | { verdict: "wait"; account: Account; onLimit: ClaudeOnLimit; seconds: number; detail: string };

const nowMs = (): number => {
  const raw = Number(process.env.RALPH_USAGE_NOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : Date.now();
};

const expandHome = (path: string): string => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** The registry's path on this host. */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.RALPH_CLAUDE_ACCOUNTS_FILE?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "ralph", "claude-accounts.json");
}

/**
 * The registry's accounts, or none with the reason. A bad entry is dropped,
 * never the whole file: one typo must not move every loop off its account.
 */
export function parseRegistry(text: string): { accounts: Account[]; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { accounts: [], problem: `not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw) || !isObject(raw.accounts)) return { accounts: [], problem: "must be an object with 'accounts'" };
  const accounts: Account[] = [];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(raw.accounts)) {
    if (!CLAUDE_ACCOUNT_NAME.test(name)) {
      problems.push(`'${name}' is not an account name`);
      continue;
    }
    const dir = isObject(value) ? value.configDir : undefined;
    if (typeof dir !== "string" || dir.trim() === "") {
      problems.push(`'${name}' needs a 'configDir'`);
      continue;
    }
    accounts.push({ name, configDir: resolve(expandHome(dir.trim())) });
  }
  return { accounts, problem: problems.length > 0 ? problems.join("; ") : null };
}

export function readRegistry(path: string = registryPath()): { accounts: Account[]; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { accounts: [], problem: code === "ENOENT" ? null : `cannot read ${path} (${code ?? (error as Error).message})` };
  }
  return parseRegistry(text);
}

/** Until when the account in `configDir` is at its limit, or null when it is not (or nobody knows). */
export function readLimit(configDir: string, now: number): Limit | null {
  const found: Limit[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(join(configDir, LIMIT_FILE), "utf8"));
    if (isObject(raw) && typeof raw.until === "string") {
      const untilMs = Date.parse(raw.until);
      if (Number.isFinite(untilMs)) found.push({ untilMs, window: typeof raw.window === "string" ? raw.window : null, source: "ralph" });
    }
  } catch {
    // No mark, or one that cannot be read: not limited.
  }
  try {
    const seconds = Number(readFileSync(join(configDir, ROUTER_FULL_FILE), "utf8").trim());
    if (Number.isFinite(seconds) && seconds > 0) found.push({ untilMs: seconds * 1000, window: null, source: "router" });
  } catch {
    // The router is optional.
  }
  const live = found.filter((limit) => limit.untilMs > now);
  if (live.length === 0) return null;
  // Both say the account is spent: it is spent until the later of the two.
  return live.reduce((a, b) => (b.untilMs > a.untilMs ? b : a));
}

/** The rule that applies to `loop`, and where it came from: this host's override first, then the config. */
export function effectiveRule(
  loop: string,
  config: Pick<ProjectConfig, "claudeAccounts" | "roster"> | null,
  override: Override | null = null,
): { rule: ClaudeAccountsRule | null; source: RuleSource } {
  const layers: Array<[RuleSource, ClaudeAccountsRule | null | undefined]> = [
    ["override", override?.entries[loop]?.rule],
    ["override-project", override?.entries[PROJECT_KEY]?.rule],
    ["config-loop", config?.roster.find((entry) => entry.name === loop)?.claudeAccounts],
    ["config", config?.claudeAccounts],
  ];
  for (const [source, rule] of layers) {
    if (rule !== undefined) return { rule, source };
  }
  return { rule: null, source: "none" };
}

/** The project-wide rule, ignoring any one loop's: what "all agents" shows. */
export function projectRule(
  config: Pick<ProjectConfig, "claudeAccounts"> | null,
  override: Override | null,
): { rule: ClaudeAccountsRule | null; source: RuleSource } {
  const own = override?.entries[PROJECT_KEY]?.rule;
  if (own !== undefined) return { rule: own, source: "override-project" };
  if (config?.claudeAccounts !== undefined) return { rule: config.claudeAccounts, source: "config" };
  return { rule: null, source: "none" };
}

/** The override file's content; a bad entry is dropped, never the whole file. */
export function parseOverride(text: string): { override: Override | null; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { override: null, problem: `not JSON: ${(error as Error).message}` };
  }
  if (!isObject(raw) || !isObject(raw.entries)) return { override: null, problem: "must be an object with 'entries'" };
  const entries: Record<string, OverrideEntry> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!isObject(value) || !("rule" in value)) {
      problems.push(`'${key}' needs a 'rule'`);
      continue;
    }
    const ruleProblems = claudeAccountsProblems(value.rule, `entries.${key}.rule`, true);
    if (ruleProblems.length > 0) {
      problems.push(...ruleProblems);
      continue;
    }
    entries[key] = { rule: value.rule as ClaudeAccountsRule | null, at: typeof value.at === "string" ? value.at : "" };
  }
  return { override: { entries }, problem: problems.length > 0 ? problems.join("; ") : null };
}

/** Where the override lives: git's common directory, so every worktree of the repo shares it. */
export function overridePath(root: string = process.cwd()): string {
  const pinned = process.env.RALPH_CLAUDE_ACCOUNTS_OVERRIDE_FILE?.trim();
  if (pinned) return pinned;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (common) return join(common, OVERRIDE_FILE);
  } catch {
    // Not a git checkout: the worktree's own state directory.
  }
  return join(root, ".ralph", OVERRIDE_FILE);
}

function readOverride(path: string): { override: Override | null; problem: string | null } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { override: null, problem: code === "ENOENT" ? null : `cannot read ${path} (${code ?? (error as Error).message})` };
  }
  return parseOverride(text);
}

/** Who an account directory is logged in as, from its profile; nulls when it says nothing. */
export function readProfile(configDir: string): { email: string | null; organization: string | null } {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(configDir, PROFILE_FILE), "utf8"));
    const account = isObject(raw) && isObject(raw.oauthAccount) ? raw.oauthAccount : null;
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
    return { email: text(account?.emailAddress), organization: text(account?.organizationName) };
  } catch {
    return { email: null, organization: null };
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

export interface Detected {
  configDir: string;
  /** A name to register it under: its directory's suffix, free in the registry. */
  suggestedName: string;
  loggedIn: boolean;
  email: string | null;
  organization: string | null;
  /** The registry's name for it, or null when it is not registered. */
  registeredAs: string | null;
}

/** A registry name from a directory: `.claude` is `default`, `.claude-work` is `work`. */
export function suggestName(configDir: string, taken: ReadonlySet<string>): string {
  const base = configDir.replace(/\/+$/, "").split("/").pop() ?? "";
  const stem =
    base
      .replace(/^\.?claude[-_.]?/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 36) || "default";
  let name = /^[a-z0-9]/.test(stem) ? stem : `a${stem}`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  return name;
}

/**
 * The Claude config directories on this host: `$HOME/.claude` and every
 * `$HOME/.claude-*` directory, plus `$CLAUDE_CONFIG_DIR`, each holding a
 * login or a profile. Never throws: a directory that cannot be read is not one.
 */
export function detect(registered: readonly Account[], env: NodeJS.ProcessEnv = process.env): Detected[] {
  const home = env.HOME?.trim() || homedir();
  const found = new Set<string>();
  try {
    for (const name of readdirSync(home)) {
      if (name === ".claude" || /^\.claude[-_.][A-Za-z0-9_.-]+$/.test(name)) found.add(join(home, name));
    }
  } catch {
    // No readable home: nothing to detect there.
  }
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) found.add(resolve(expandHome(fromEnv)));
  const taken = new Set(registered.map((account) => account.name));
  const rows: Detected[] = [];
  for (const configDir of [...found].sort()) {
    if (!isDir(configDir)) continue;
    const loggedIn = existsSync(join(configDir, CREDENTIALS_FILE));
    if (!loggedIn && !existsSync(join(configDir, PROFILE_FILE))) continue;
    const registeredAs = registered.find((account) => account.configDir === configDir)?.name ?? null;
    const suggestedName = registeredAs ?? suggestName(configDir, taken);
    if (registeredAs === null) taken.add(suggestedName);
    rows.push({ configDir, suggestedName, loggedIn, ...readProfile(configDir), registeredAs });
  }
  return rows;
}

const at = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function waitSeconds(untilMs: number, now: number, maxSeconds: number): number {
  return Math.min(maxSeconds, Math.max(1, Math.ceil((untilMs - now) / 1000)));
}

/**
 * The account a loop runs on now. Pure but for `limitOf`, so a test can hand
 * it any state of the world.
 */
export function choose(
  rule: ClaudeAccountsRule | null,
  registered: readonly Account[],
  limitOf: (account: Account) => Limit | null,
  now: number,
  maxWaitSeconds: number = DEFAULT_MAX_WAIT_SECONDS,
): Choice {
  const onLimit = rule?.onLimit ?? CLAUDE_ON_LIMIT_DEFAULT;
  if (rule === null) return { verdict: "default", onLimit, detail: "no claudeAccounts rule: the environment's account" };
  const byName = new Map(registered.map((account) => [account.name, account]));
  const usable = rule.use.map((name) => byName.get(name)).filter((account): account is Account => account !== undefined);
  const missing = rule.use.filter((name) => !byName.has(name));
  const unregistered = missing.length > 0 ? `; not registered on this host: ${missing.join(", ")}` : "";
  if (usable.length === 0) {
    return { verdict: "default", onLimit, detail: `no account of ${rule.use.join(", ")} is registered on this host: the environment's account` };
  }
  // Only `next` ever looks past the first: `wait` and `stop` keep a loop on
  // its one account, which is the point of choosing them.
  const candidates = onLimit === "next" ? usable : usable.slice(0, 1);
  const limits = candidates.map((account) => ({ account, limit: limitOf(account) }));
  const free = limits.find((entry) => entry.limit === null);
  if (free !== undefined) {
    const passed = limits.slice(0, limits.indexOf(free)).map((entry) => `${entry.account.name} at its limit until ${at(entry.limit!.untilMs)}`);
    const why = passed.length > 0 ? `${passed.join(", ")}; ` : "";
    return { verdict: "run", account: free.account, onLimit, detail: `${why}running on Claude account ${free.account.name} (onLimit ${onLimit})${unregistered}` };
  }
  const soonest = limits.reduce((a, b) => (b.limit!.untilMs < a.limit!.untilMs ? b : a));
  const until = soonest.limit!.untilMs;
  if (onLimit === "stop") {
    return { verdict: "stop", account: soonest.account, onLimit, detail: `${soonest.account.name} is at its usage limit until ${at(until)} and onLimit is stop${unregistered}` };
  }
  const every = limits.length > 1 ? `every account (${limits.map((entry) => entry.account.name).join(", ")}) is at its limit; ` : "";
  return {
    verdict: "wait",
    account: soonest.account,
    onLimit,
    seconds: waitSeconds(until, now, maxWaitSeconds),
    detail: `${every}waiting for ${soonest.account.name} to reset at ${at(until)}${unregistered}`,
  };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function maxWait(): number {
  const raw = Number(process.env.RALPH_CLAUDE_ACCOUNT_MAX_WAIT_SECONDS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_WAIT_SECONDS;
}

function loadConfig(): ProjectConfig | null {
  try {
    return loadProjectConfig();
  } catch {
    // ralph.sh refused to start on a bad config already; here it only means "no rule".
    return null;
  }
}

function decide(loop: string): { choice: Choice; source: RuleSource; registry: ReturnType<typeof readRegistry> } {
  const { rule, source } = effectiveRule(loop, loadConfig(), readOverride(overridePath()).override);
  const registry = readRegistry();
  const now = nowMs();
  return { choice: choose(rule, registry.accounts, (account) => readLimit(account.configDir, now), now, maxWait()), source, registry };
}

/** A field `ralph.sh` reads with `IFS=$'\t' read`: never empty, never a tab or newline. */
const field = (value: string): string => (value === "" ? "-" : value.replace(/[\t\n]+/g, " "));

function pick(args: string[]): number {
  const loop = flag(args, "--loop") ?? "";
  let line: string[];
  try {
    const { choice } = decide(loop);
    line =
      choice.verdict === "default"
        ? ["default", "-", "-", "0", choice.onLimit, choice.detail]
        : [choice.verdict, choice.account.name, choice.account.configDir, String(choice.verdict === "wait" ? choice.seconds : 0), choice.onLimit, choice.detail];
  } catch (error) {
    line = ["default", "-", "-", "0", CLAUDE_ON_LIMIT_DEFAULT, `account choice failed (${(error as Error).message}): the environment's account`];
  }
  console.log(line.map(field).join("\t"));
  return 0;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // tmp+rename so a loop reading the mark never sees half of it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function mark(args: string[]): number {
  const name = flag(args, "--account");
  const statePath = flag(args, "--state");
  if (!name || !statePath) return 1;
  const account = readRegistry().accounts.find((entry) => entry.name === name);
  if (account === undefined) return 1;
  const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (!isObject(state) || typeof state.until !== "string" || !Number.isFinite(Date.parse(state.until))) return 1;
  const now = nowMs();
  // Never shorten a mark another loop left: a later reset is the safer fact.
  const prior = readLimit(account.configDir, now);
  if (prior !== null && prior.source === "ralph" && prior.untilMs >= Date.parse(state.until)) return 0;
  writeJson(join(account.configDir, LIMIT_FILE), {
    until: state.until,
    window: typeof state.window === "string" ? state.window : null,
    by: flag(args, "--loop") ?? null,
    at: new Date(now).toISOString(),
  });
  return 0;
}

function show(args: string[]): number {
  const loop = flag(args, "--loop");
  if (!loop) {
    console.error("show needs --loop <name>");
    return 2;
  }
  const { rule } = effectiveRule(loop, loadConfig(), readOverride(overridePath()).override);
  const { choice, source, registry } = decide(loop);
  console.log(JSON.stringify({ loop, rule, source, registry: registryPath(), registryProblem: registry.problem, choice }, null, 2));
  return 0;
}

/** Every registered account as `list` and `view` report it. */
function accountRows(accounts: readonly Account[], now: number) {
  return accounts.map((account) => {
    const limit = readLimit(account.configDir, now);
    return {
      name: account.name,
      configDir: account.configDir,
      loggedIn: existsSync(join(account.configDir, CREDENTIALS_FILE)),
      ...readProfile(account.configDir),
      limitedUntil: limit === null ? null : new Date(limit.untilMs).toISOString(),
      limitSource: limit?.source ?? null,
    };
  });
}

function list(args: string[]): number {
  const registry = readRegistry();
  const rows = accountRows(registry.accounts, nowMs());
  if (args.includes("--json")) {
    console.log(JSON.stringify({ registry: registryPath(), problem: registry.problem, accounts: rows }, null, 2));
    return 0;
  }
  if (registry.problem !== null) console.error(`${registryPath()}: ${registry.problem}`);
  if (rows.length === 0) console.log(`no Claude accounts registered (${registryPath()}); add one: bun claude-account.ts add --name <name> --dir <configDir>`);
  for (const row of rows) {
    const login = row.loggedIn ? "logged in" : `not logged in (CLAUDE_CONFIG_DIR=${row.configDir} claude, then /login)`;
    const limit = row.limitedUntil === null ? "available" : `at its limit until ${row.limitedUntil}`;
    console.log(`${row.name}\t${row.configDir}\t${login}\t${limit}`);
  }
  return 0;
}

/** The registry file as JSON, or a fresh one; refuses to overwrite one it cannot parse. */
function registryForEdit(path: string): Json {
  if (!existsSync(path)) return { accounts: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(raw) || !isObject(raw.accounts)) throw new Error(`${path} must be an object with 'accounts'; fix it by hand`);
  return raw;
}

function add(args: string[]): number {
  const name = flag(args, "--name");
  const dir = flag(args, "--dir");
  if (!name || !CLAUDE_ACCOUNT_NAME.test(name) || !dir) {
    console.error("add needs --name <lowercase name> --dir <configDir>");
    return 2;
  }
  const path = registryPath();
  const raw = registryForEdit(path);
  const configDir = resolve(expandHome(dir));
  const twin = readRegistry(path).accounts.find((account) => account.configDir === configDir && account.name !== name);
  if (twin !== undefined) {
    console.error(`${configDir} is already registered as ${twin.name}`);
    return 1;
  }
  (raw.accounts as Json)[name] = { configDir };
  // A new account's directory exists before its first login, so the login
  // command the page shows can be run as is.
  mkdirSync(configDir, { recursive: true });
  writeJson(path, raw);
  const loggedIn = existsSync(join(configDir, CREDENTIALS_FILE));
  console.log(`registered ${name} → ${configDir} in ${path}`);
  if (!loggedIn) console.log(`not logged in yet: CLAUDE_CONFIG_DIR=${configDir} claude, then /login`);
  return 0;
}

function remove(args: string[]): number {
  const name = flag(args, "--name");
  const path = registryPath();
  const raw = registryForEdit(path);
  if (!name || !(name in (raw.accounts as Json))) {
    console.error(`no account '${name ?? ""}' in ${path}`);
    return 1;
  }
  delete (raw.accounts as Json)[name];
  writeJson(path, raw);
  console.log(`removed ${name} from ${path}; a project whose claudeAccounts names it now skips it`);
  return 0;
}

function clear(args: string[]): number {
  const name = flag(args, "--account");
  const account = readRegistry().accounts.find((entry) => entry.name === name);
  if (account === undefined) {
    console.error(`no account '${name ?? ""}' in ${registryPath()}`);
    return 1;
  }
  rmSync(join(account.configDir, LIMIT_FILE), { force: true });
  console.log(`cleared ${name}'s limit mark`);
  return 0;
}

function detectCommand(args: string[]): number {
  const rows = detect(readRegistry().accounts);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ detected: rows }, null, 2));
    return 0;
  }
  if (rows.length === 0) console.log("no Claude config directory found in $HOME");
  for (const row of rows) {
    const who = row.email ?? (row.loggedIn ? "logged in" : "not logged in");
    console.log(`${row.configDir}\t${who}\t${row.registeredAs === null ? `not registered (suggest: ${row.suggestedName})` : `registered as ${row.registeredAs}`}`);
  }
  return 0;
}

/**
 * Everything the dashboard draws, in one read: the accounts, the directories
 * it could add, the project's rule and each loop's. Read failures are fields,
 * never an exit: the page shows what is wrong.
 */
function view(): number {
  const registry = readRegistry();
  const now = nowMs();
  let config: ProjectConfig | null = null;
  let configProblem: string | null = null;
  try {
    config = loadProjectConfig();
  } catch (error) {
    configProblem = (error as Error).message;
  }
  const overrideFile = overridePath();
  const { override, problem: overrideProblem } = readOverride(overrideFile);
  const limitOf = (account: Account) => readLimit(account.configDir, now);
  const project = projectRule(config, override);
  const loops = (config?.roster ?? []).map((entry) => {
    const { rule, source } = effectiveRule(entry.name, config, override);
    return {
      loop: entry.name,
      rule,
      source,
      own: override?.entries[entry.name] !== undefined,
      choice: choose(rule, registry.accounts, limitOf, now, maxWait()),
    };
  });
  console.log(
    JSON.stringify(
      {
        version: 1,
        registry: registryPath(),
        registryProblem: registry.problem,
        overrideFile,
        overrideProblem,
        configProblem,
        accounts: accountRows(registry.accounts, now),
        detected: detect(registry.accounts),
        project: { ...project, choice: choose(project.rule, registry.accounts, limitOf, now, maxWait()) },
        loops,
      },
      null,
      2,
    ),
  );
  return 0;
}

function assign(args: string[], drop: boolean): number {
  const target = flag(args, "--target");
  if (!target) {
    console.error(`${drop ? "unassign" : "assign"} needs --target <loop|*>`);
    return 2;
  }
  let config: ProjectConfig | null = null;
  try {
    config = loadProjectConfig();
  } catch {
    // An unreadable config does not stop an override: it is what may rescue the loop.
  }
  if (target !== PROJECT_KEY && config !== null && !config.roster.some((entry) => entry.name === target)) {
    console.error(`no loop '${target}' in the project's roster`);
    return 1;
  }
  const path = overridePath();
  const { override, problem } = readOverride(path);
  if (problem !== null && override === null) {
    console.error(`${path}: ${problem}; fix it by hand`);
    return 1;
  }
  const entries = { ...override?.entries };
  if (drop) {
    delete entries[target];
  } else {
    let rule: ClaudeAccountsRule | null;
    if (args.includes("--env")) {
      rule = null;
    } else {
      const use = (flag(args, "--use") ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
      const onLimit = flag(args, "--on-limit");
      rule = onLimit === undefined ? { use } : { use, onLimit: onLimit as ClaudeOnLimit };
      const problems = claudeAccountsProblems(rule, "rule", false);
      if (onLimit !== undefined && !CLAUDE_ON_LIMIT.includes(onLimit as ClaudeOnLimit)) problems.push(`--on-limit must be one of ${CLAUDE_ON_LIMIT.join(", ")}`);
      const registered = new Set(readRegistry().accounts.map((account) => account.name));
      const unknown = use.filter((name) => !registered.has(name));
      if (unknown.length > 0) problems.push(`not registered on this host: ${unknown.join(", ")}`);
      if (problems.length > 0) {
        console.error(problems.join("; "));
        return 1;
      }
    }
    entries[target] = { rule, at: new Date(nowMs()).toISOString() };
  }
  writeJson(path, { entries });
  const who = target === PROJECT_KEY ? "every loop of the project" : target;
  console.log(drop ? `${who}: back to the committed config` : `${who}: set; loops pick it up at their next iteration`);
  return 0;
}

export function main(args: string[]): number {
  const [command, ...rest] = args;
  // `pick` and `mark` run inside a loop: they never throw at it.
  if (command === "pick") return pick(rest);
  if (command === "mark") {
    try {
      return mark(rest);
    } catch {
      return 1;
    }
  }
  try {
    if (command === "show") return show(rest);
    if (command === "list") return list(rest);
    if (command === "add") return add(rest);
    if (command === "remove") return remove(rest);
    if (command === "clear") return clear(rest);
    if (command === "detect") return detectCommand(rest);
    if (command === "view") return view();
    if (command === "assign") return assign(rest, false);
    if (command === "unassign") return assign(rest, true);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  console.error("usage: claude-account.ts pick|mark|show|list|add|remove|clear|detect|view|assign|unassign …");
  return 2;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
