/**
 * The host's Claude accounts, from the page's side of the process boundary.
 *
 * The page never writes the account registry or the project's override
 * itself: it runs the harness's `claude-account.ts`, which owns both files
 * (the registry under ~/.config/ralph, the override in the repo's git common
 * directory), so the loops that read them and the page that sets them cannot
 * disagree about where they live or what they mean. Every change re-reads the
 * whole view afterwards, so the page draws what the loops will see.
 *
 * It owns the executor behind `guarded()`, so a timeout, a missing `bun` or an
 * executor that rejects all read as a view with a `problem`, never a 500.
 */
import { join, resolve } from "node:path";

import { ADAPTER_ENV, configCheckout, defaultBunPath, isRecord } from "./adapter";
import {
  CLAUDE_ON_LIMITS,
  type ClaudeAccountChoiceView,
  type ClaudeAccountDetectedView,
  type ClaudeAccountsAnswer,
  type ClaudeAccountsLoopView,
  type ClaudeAccountsRequest,
  type ClaudeAccountsRuleView,
  type ClaudeAccountsSource,
  type ClaudeAccountsTargetView,
  type ClaudeAccountsView,
  type ClaudeAccountView,
  type ClaudeOnLimitView,
  type Env,
} from "./contracts";
import { guarded, type ExecResult, type Executor } from "./executor";

export const CLAUDE_ACCOUNTS_SCRIPT = "claude-account.ts";

/**
 * Every verb the page runs, one script: the view it reads, and the five
 * writes, each of which edits only the host's account registry, an account's
 * limit mark or the project's override. The read-only suite pins this list.
 */
export const CLAUDE_ACCOUNTS_SURFACE = {
  view: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["view", "--json"] },
  add: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["add"] },
  remove: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["remove"] },
  clear: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["clear"] },
  assign: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["assign"] },
  unassign: { script: CLAUDE_ACCOUNTS_SCRIPT, args: ["unassign"] },
} as const;

/** The CLI arguments one request runs; the view is read again afterwards. */
export function claudeAccountsArgs(request: ClaudeAccountsRequest): string[] {
  const S = CLAUDE_ACCOUNTS_SURFACE;
  switch (request.action) {
    case "add":
      return [...S.add.args, "--name", request.name, "--dir", request.dir];
    case "remove":
      return [...S.remove.args, "--name", request.name];
    case "clear-limit":
      return [...S.clear.args, "--account", request.name];
    case "assign":
      return [...S.assign.args, "--target", request.target, "--use", request.use.join(","), "--on-limit", request.onLimit];
    case "assign-env":
      return [...S.assign.args, "--target", request.target, "--env"];
    case "unassign":
      return [...S.unassign.args, "--target", request.target];
  }
}

export interface ClaudeAccountsAdapter {
  view(): Promise<ClaudeAccountsView>;
  act(request: ClaudeAccountsRequest): Promise<ClaudeAccountsAnswer>;
}

export interface ClaudeAccountsAdapterConfig {
  /** The harness checkout `claude-account.ts` is run from. */
  cliDir: string;
  /** The project's registered checkout: the CLI's cwd, whose config and git common dir it reads. */
  root: string;
  bunPath?: string;
  env?: Env;
  exec: Executor;
  /** Which checkout holds the project's config; the page's own lookup unless a test pins it. */
  configCheckout?: (root: string) => string;
}

const EMPTY: Omit<ClaudeAccountsView, "problem"> = { accounts: [], detected: [], project: null, loops: [], problems: [] };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const problemView = (problem: string): ClaudeAccountsView => ({ ...EMPTY, problem });

const SOURCES: readonly ClaudeAccountsSource[] = ["override", "override-project", "config-loop", "config", "none"];
const VERDICTS: readonly ClaudeAccountChoiceView["verdict"][] = ["default", "run", "wait", "stop"];

function rule(value: unknown): ClaudeAccountsRuleView | null {
  if (!isRecord(value) || !Array.isArray(value.use)) return null;
  const use = value.use.filter((name): name is string => typeof name === "string");
  const onLimit = (CLAUDE_ON_LIMITS as readonly unknown[]).includes(value.onLimit) ? (value.onLimit as ClaudeOnLimitView) : "wait";
  return use.length === 0 ? null : { use, onLimit };
}

function choice(value: unknown): ClaudeAccountChoiceView {
  if (!isRecord(value)) return { verdict: "default", account: null, detail: "" };
  const verdict = VERDICTS.includes(value.verdict as ClaudeAccountChoiceView["verdict"]) ? (value.verdict as ClaudeAccountChoiceView["verdict"]) : "default";
  const account = isRecord(value.account) ? text(value.account.name) : null;
  return { verdict, account, detail: text(value.detail) ?? "" };
}

function target(value: unknown): ClaudeAccountsTargetView | null {
  if (!isRecord(value)) return null;
  const source = SOURCES.includes(value.source as ClaudeAccountsSource) ? (value.source as ClaudeAccountsSource) : "none";
  return { rule: rule(value.rule), source, choice: choice(value.choice) };
}

function account(value: unknown): ClaudeAccountView | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const configDir = text(value.configDir);
  if (name === null || configDir === null) return null;
  const until = text(value.limitedUntil);
  return {
    name,
    configDir,
    loggedIn: value.loggedIn === true,
    email: text(value.email),
    organization: text(value.organization),
    limitedUntil: until !== null && !Number.isNaN(Date.parse(until)) ? until : null,
  };
}

function detected(value: unknown): ClaudeAccountDetectedView | null {
  if (!isRecord(value)) return null;
  const configDir = text(value.configDir);
  const suggestedName = text(value.suggestedName);
  if (configDir === null || suggestedName === null) return null;
  return {
    configDir,
    suggestedName,
    loggedIn: value.loggedIn === true,
    email: text(value.email),
    organization: text(value.organization),
    registeredAs: text(value.registeredAs),
  };
}

const defined = <T,>(value: T | null): value is T => value !== null;

/** Narrow `claude-account.ts view --json`; anything off-shape is a `problem`, never a throw. */
export function parseClaudeAccountsView(result: ExecResult): ClaudeAccountsView {
  if (result.status !== 0) {
    const status = result.status === null ? "did not run" : `exited ${result.status}`;
    return problemView(text(result.stderr) ?? `claude-account.ts view ${status} without saying why`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return problemView(`claude-account.ts view did not print JSON: ${result.stdout.trim().slice(0, 200)}`);
  }
  if (!isRecord(value) || value.version !== 1) {
    return problemView(`claude-account.ts view printed an unexpected shape: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  const list = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);
  const loops = list(value.loops)
    .map((entry): ClaudeAccountsLoopView | null => {
      const base = target(entry);
      const loop = isRecord(entry) ? text(entry.loop) : null;
      return base === null || loop === null ? null : { ...base, loop, own: isRecord(entry) && entry.own === true };
    })
    .filter(defined);
  const problems = [
    ["the account registry", value.registryProblem],
    ["this host's override", value.overrideProblem],
    ["the project's config", value.configProblem],
  ]
    .map(([where, problem]) => (text(problem) === null ? null : `${where as string}: ${text(problem)}`))
    .filter(defined);
  return {
    accounts: list(value.accounts).map(account).filter(defined),
    detected: list(value.detected).map(detected).filter(defined),
    project: target(value.project),
    loops,
    problems,
    problem: null,
  };
}

export function createClaudeAccountsAdapter(config: ClaudeAccountsAdapterConfig): ClaudeAccountsAdapter {
  const root = resolve(config.root);
  const bunPath = config.bunPath ?? defaultBunPath();
  const exec = guarded(config.exec);
  const script = join(resolve(config.cliDir), CLAUDE_ACCOUNTS_SCRIPT);
  // The checkout holding the project's config, found per run: a main checkout
  // on a branch without `.ralph/` leaves it to the loops' worktrees, as every
  // other config read of the page does. Any worktree of the repo shares the
  // git common dir the override lives in.
  const run = (args: string[]): Promise<ExecResult> => {
    const checkout = (config.configCheckout ?? configCheckout)(root);
    const env: Env = { ...process.env, ...config.env, [ADAPTER_ENV.loopStateRoot]: root, [ADAPTER_ENV.project]: checkout };
    return exec({ command: bunPath, args: [script, ...args], cwd: root, env });
  };
  const view = async (): Promise<ClaudeAccountsView> => parseClaudeAccountsView(await run([...CLAUDE_ACCOUNTS_SURFACE.view.args]));
  return {
    view,
    act: async (request) => {
      const result = await run(claudeAccountsArgs(request));
      const ok = result.status === 0;
      const said = ok ? text(result.stdout) : (text(result.stderr) ?? text(result.stdout));
      const message = said ?? (ok ? "done" : `claude-account.ts ${request.action} failed without saying why`);
      // Read again whatever the answer: a refused change may still have written part of it.
      return { ok, message, view: await view() };
    },
  };
}
