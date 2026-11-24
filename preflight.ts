#!/usr/bin/env bun
/**
 * The startup preflight — prove the loop CAN work before it is allowed to.
 *
 * A supervisor that starts into a worktree missing one prerequisite does not
 * fail as that prerequisite. It spends a full-price orchestrator turn finding
 * out, and the shapes that failure takes are the expensive ones: a loop whose
 * three labels were never created works through the ENTIRE frontier, fails to
 * claim on each, and ends `DONE` having done nothing (`README.md`, "A missing
 * label is expensive"); a loop whose `gh` is unauthenticated reads an empty
 * backlog as a drained one. Both cost money to learn.
 *
 * So the questions are asked here instead, before the first iteration and
 * before the frontier gate, and they are asked in one place rather than at the
 * point of use. `ralph.sh` already refuses on the prerequisites it needs for
 * its OWN next line — bun, the model lineup, refused env files, a fresh worktree —
 * and those stay where they are, because a check that guards a specific
 * statement belongs beside it. What lives here is everything the ITERATION
 * needs and the supervisor never touches: the CLIs an iteration shells out to,
 * the credentials it works through, the repository state it reads, and the
 * frontier's own prerequisites.
 *
 * Three properties matter more than the check list:
 *
 * 1. **Read-only.** Nothing here writes, but for labels: on GitHub a missing
 *    label named in `roles.ts`'s `CREATED_LABELS` is created with `gh label
 *    create`, so a label a release declares does not deny every loop's next
 *    start, and on Linear or Jira the tracker's `ensureLabels` creates the
 *    labels a loop needs. Nothing else writes — not to GitHub, not to the
 *    frontier, not to the worktree. A
 *    preflight that claimed a ticket would hand it to a process that has not
 *    started yet, and lose it outright if startup then failed — the same
 *    reason `frontier-gate.ts` probes with `--dry-run`. The other probes are
 *    an executable-bit check on `PATH`, `auth status`, `label list`,
 *    `rev-parse`, and a secret-NAME listing; every one is a read.
 *
 * 2. **Bounded.** Every subprocess runs under a timeout. A supervisor started
 *    with `nohup … &` has no terminal, so an unauthenticated `gh` or a hung
 *    DNS lookup would otherwise sit forever looking like a running loop.
 *
 * 3. **Denied and unavailable are different answers.** A local requirement
 *    that is *denied* — no credential, no label, no CLI — cannot be fixed by
 *    waiting, so it refuses startup and prints the remedy. An external service
 *    that is *unavailable* — GitHub unreachable, rate-limited, Doppler's API
 *    down — is a wait: the operator's setup is fine, the loop simply cannot
 *    work yet, and refusing would mean a network blip permanently ends a loop
 *    that was meant to be left running. Neither answer claims anything.
 *
 * Usage:
 *   ralph/preflight.ts            report; 0 ready, 1 denied, 2 unavailable
 *   ralph/preflight.ts --json     the same verdict as one JSON object
 *   ralph/preflight.ts --labels   the project labels this loop needs, one per line
 *
 *   RALPH_PREFLIGHT_JSON=<path>   also write `{ verdict, checks }` to <path>, for
 *                                 the supervisor to name the failing check; a
 *                                 failed write changes nothing (it degrades)
 *
 * Which checks are asked is the LOOP'S ROLE's answer (`roles.ts`): a triager
 * runs no gates, delegates nothing and is given no application environment, so
 * holding it to a coder's list would refuse it for prerequisites it never
 * reaches. The role also adds to the labels `loop-labels` requires — its
 * verdict vocabulary — because a label that does not exist makes a triager
 * write nothing and report success.
 *
 * Exit 3 means the preflight itself is broken, which `ralph.sh` treats as
 * fatal — an unrunnable preflight is not evidence that anything is fine.
 */

import { execFile } from "node:child_process";
import { access, constants, stat, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadConfig, resolveLineup, type Runner } from "./models";
import { loopRoster, type LoopName } from "./frontier/next-tasks";
import { RALPH_HOME, projectRoot } from "./paths";
import { clerkConfigWarnings, clerkJira, clerkRules, loadProjectConfig, verifierRules, triageRules, type ProjectConfig } from "./project-config";
import { javPath, readJav, type JavRoster } from "./jav";
import { currentProjectId } from "./project-id";
import { keyedProjectTracker, projectTrackerConfig } from "./tracker/project";
import { keyedTriagerLabels, type AppLabels } from "./triage/intake";
import { TrackerUnavailableError, type Tracker } from "./tracker/types";
import { readDotenvFile } from "./secrets/dotenv";
import { JIRA_TOKEN_ENV, JiraError, jiraClient, parseJiraToken, type JiraClient } from "./clerk/jira";
import { SENTRY_TOKEN_ENV, VERCEL_TOKEN_ENV } from "./verifier/credentials";
import { isRateLimited } from "./pr-wait";
import {
  CREATED_LABELS,
  DEFAULT_ROLE,
  ROLES,
  ROLE_DESCRIPTORS,
  isRole,
  type PreflightCheck,
  type Role,
  type RolePreflight,
} from "./roles";

/** How long any one probe may take. Small enough that the whole preflight is. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Generous: this repo has a few dozen labels and the check is one call. */
const LABEL_LIMIT = 200;

/**
 * What a check came back with.
 *
 * `denied` carries a remedy because the message IS the product: an operator
 * reading it at 2am should not have to open `README.md` to learn which command
 * fixes it. `unavailable` carries none — there is nothing for them to do.
 */
export type Outcome =
  | { status: "ok"; detail?: string }
  | { status: "denied"; why: string; remedy: string }
  | { status: "unavailable"; why: string }
  /** The loop can work without it, only worse. Reported; never blocks startup. */
  | {
      status: "warn";
      why: string;
      remedy: string;
      /**
       * The secret behind this warning could not be read, so a role that
       * promotes the warning to a denial gets a wait instead (#767): whether
       * the secret is stored is unknown, and a denial would stop the loop for
       * good over a keyring that unlocks a minute later.
       */
      unread?: true;
    };

export interface CheckResult {
  /**
   * Which check this is, from the one vocabulary a role's list is a subset of
   * (`roles.ts`). Typed rather than free: a result named something no role can
   * ask for would be reported to nobody, and a role asking for a name no check
   * produces would go unrun — both silently, which is the one failure mode a
   * preflight cannot have.
   */
  name: PreflightCheck;
  outcome: Outcome;
}

export type Verdict = "ready" | "denied" | "unavailable";

/**
 * One answer from many checks. `denied` outranks `unavailable` deliberately:
 * a worktree with no `rafa-wip` label AND an unreachable GitHub is not a
 * waiting loop, it is a broken setup that will still be broken when the
 * network comes back — and waiting would hide it for as long as the operator
 * left the loop running.
 */
export function summarize(results: CheckResult[]): Verdict {
  if (results.some((r) => r.outcome.status === "denied")) return "denied";
  if (results.some((r) => r.outcome.status === "unavailable")) return "unavailable";
  return "ready";
}

/** The lines a supervisor logs. Only what failed, plus one verdict line. */
export function report(results: CheckResult[], verdict: Verdict): string[] {
  const lines: string[] = [];
  for (const { name, outcome } of results) {
    if (outcome.status === "denied") {
      lines.push(`preflight: ${name} — ${outcome.why}`);
      lines.push(`           fix: ${outcome.remedy}`);
    } else if (outcome.status === "unavailable") {
      lines.push(`preflight: ${name} — ${outcome.why} (unavailable, not denied)`);
    } else if (outcome.status === "warn") {
      lines.push(`preflight: ${name} — ${outcome.why} (warning, not fatal)`);
      lines.push(`           fix: ${outcome.remedy}`);
    }
  }
  if (verdict === "ready") {
    const warnings = results.filter((r) => r.outcome.status === "warn").length;
    lines.push(
      warnings === 0
        ? `preflight: ready — ${results.length} checks passed`
        : `preflight: ready — ${results.length - warnings} checks passed, ${warnings} warning${warnings === 1 ? "" : "s"}`,
    );
  } else if (verdict === "denied") {
    lines.push("preflight: refusing to start — a local requirement is not met");
  } else {
    lines.push("preflight: an external dependency is unavailable — nothing has been claimed");
  }
  return lines;
}

/**
 * Which side of the denied/unavailable line a failed GitHub probe falls on.
 *
 * Positive matching on unavailability rather than on denial, and an ambiguous
 * failure reads as DENIED. The evidence has to be specific: `gh` prints the
 * API host in an ordinary 403, and a bare `503` occurs inside perfectly
 * healthy JSON, so neither `api.github.com` nor a loose status number can be
 * what puts a loop into an unbounded wait.
 *
 * The two mistakes are not symmetrical: a denial misread as unavailable is a
 * supervisor that waits forever in silence, while an outage misread as denied
 * is one loud message an operator can act on and re-run.
 */
const UNAVAILABLE_EVIDENCE =
  /timed? ?out|deadline exceeded|error connecting to|connection (?:refused|reset)|could not resolve|dns|network is unreachable|unreachable|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|HTTP 50[234]|bad gateway|service unavailable|server error|rate ?limit|githubstatus|try again later/i;

export function classifyFailure(output: string, timedOut = false): "denied" | "unavailable" {
  if (timedOut) return "unavailable";
  return UNAVAILABLE_EVIDENCE.test(output) ? "unavailable" : "denied";
}

/**
 * The three labels a loop cannot claim, park, or finish a ticket without, plus
 * whatever `extra` its ROLE cannot work without (`roleLabels`).
 *
 * `extra` defaults to none, so the coder's answer — and every caller that
 * predates roles — is unchanged. De-duplicated, because a role's vocabulary
 * and the project's Jav labels are two lists that may name the same label, and
 * a remedy telling an operator to create one label twice reads as a bug in the
 * preflight.
 */
export function requiredLabels(loop: LoopName, extra: readonly string[] = []): string[] {
  const seen = new Map<string, string>();
  for (const name of [`${loop}-wip`, `${loop}-blocked`, `${loop}-done`, ...extra]) {
    // Keyed lower-case, first spelling kept: GitHub's label names are unique
    // case-insensitively, so `Spec` beside `spec` is ONE label, and a remedy
    // naming both would have its second `gh label create` fail. `missingLabels`
    // compares the same way, and the two must not disagree.
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

/**
 * The labels this ROLE needs beyond the per-loop triple: the vocabulary its
 * descriptor declares, plus the project's Jav difficulty labels when the role
 * is one that applies them.
 *
 * Exported for the Add-agent flow, which creates a new loop's labels
 * (`adding-an-agent.md` §6): it must be able to ask what a role needs without
 * running a preflight, or it creates the triple for a triager and leaves it
 * denied on the vocabulary.
 */
export function roleLabels(role: Role, jav: readonly string[] = []): string[] {
  const plan = ROLE_DESCRIPTORS[role].preflight;
  return [...plan.labels, ...(plan.requiresDifficultyLabels ? jav : [])];
}

/**
 * Every label this loop needs: the per-loop triple plus its role's, the
 * project's difficulty labels included when the role applies them.
 *
 * One function for both callers — the `loop-labels` check and `--labels` — so a
 * third source of labels is one edit and cannot leave the two disagreeing about
 * what a start requires.
 *
 * `keyed` is a Linear or Jira project, where a triager does the Slack intake
 * and speaks in that intake's labels too (#396). Those include an app label
 * from the project's `appLabels`, so a keyed triager without them is refused
 * here, before it starts, rather than sending every report to a person.
 */
export function requiredLabelsFor(
  loop: LoopName,
  role: Role,
  roster: JavRoster,
  options: { keyed?: boolean; apps?: AppLabels | null } = {},
): { labels: string[] } | { why: string } {
  const keyedTriager = options.keyed === true && role === "triager";
  if (keyedTriager && (options.apps ?? null) === null) {
    return { why: "a triager on a Linear or Jira tracker needs 'appLabels' ({ \"backoffice\": …, \"pwa\": … }) in .ralph/config.json: the Slack intake's rules read them" };
  }
  const intake = keyedTriager ? keyedTriagerLabels(options.apps!) : [];
  if (!ROLE_DESCRIPTORS[role].preflight.requiresDifficultyLabels) {
    return { labels: requiredLabels(loop, [...roleLabels(role), ...intake]) };
  }
  const jav = javDifficultyLabels(roster);
  if ("why" in jav) return jav;
  return { labels: requiredLabels(loop, [...roleLabels(role, jav.labels), ...intake]) };
}

/**
 * The project's Jav difficulty labels, or why they could not be read.
 *
 * Read from the file rather than passed in, because they are per project and
 * the descriptor cannot list them. `readJav` THROWS on a malformed file or
 * block — deliberately, since silently routing every ticket to every loop is
 * what Jav exists to prevent — so it is caught here: an unreadable file is a
 * denial with the path in it, not an exit 3 that reads as a broken preflight.
 *
 * Asked only of a role whose `requiresDifficultyLabels` is set. For every other role a broken
 * `jav.json` is the frontier's problem to report, not a refused start.
 */
export function javDifficultyLabels(
  roster: JavRoster,
  root: string = projectRoot(),
  env: NodeJS.ProcessEnv = process.env,
): { labels: string[] } | { why: string } {
  const path = javPath(env);
  try {
    return { labels: [...readJav(path, currentProjectId(root, env), roster).labels] };
  } catch (error) {
    // Whatever the fault was — `readJav` refuses a bad `routes` block as
    // readily as a bad `labels` one — the message is its own, and it names what
    // it found. Reported as the block being unreadable rather than as the
    // labels being missing, because the second would misdescribe a routes error.
    return { why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Which role's checks this run is held to.
 *
 * From the project's roster — the config this preflight has already read — and
 * never from `RALPH_LOOP_ROLE`: the preflight is also run by hand (step 11 of
 * adding an agent), and a role read from an environment the operator did not
 * set would hold a triager to a coder's checks and refuse it for them.
 *
 * An unreadable config or a name the roster does not carry falls back to the
 * coder, which is the strictest list and changes nothing: `project-config` and
 * `loop-identity` are already denying in both cases, so this run cannot come
 * back ready whatever the fallback asks.
 */
export function roleFor(config: ProjectConfig | null, loop: LoopName | null): Role {
  if (config === null || loop === null) return DEFAULT_ROLE;
  return config.roster.find((entry) => entry.name === loop)?.role ?? DEFAULT_ROLE;
}

/**
 * The results with this role's verdict overrides applied.
 *
 * Only a `warn` or a `denied` outcome is rewritten, and only to the other of
 * the two. `ok` has nothing to override, and `unavailable` is left alone on
 * purpose: it says an external service could not be reached, which is a wait
 * for every role, and promoting it to a denial would let one network blip
 * permanently refuse a loop meant to be left running overnight.
 *
 * A `warn` marked `unread` that would be promoted to a denial becomes
 * `unavailable` instead: an unread secret is never a denial, and only a wait
 * where it would otherwise deny (#767). Kept a warning, it stays a warning.
 */
export function applyVerdicts(results: CheckResult[], plan: RolePreflight): CheckResult[] {
  return results.map((result) => {
    const wanted = plan.verdicts[result.name];
    const { outcome } = result;
    if (wanted === undefined || wanted === outcome.status) return result;
    if (outcome.status !== "warn" && outcome.status !== "denied") return result;
    const { why, remedy } = outcome;
    if (wanted === "denied" && outcome.status === "warn" && outcome.unread) {
      return { name: result.name, outcome: { status: "unavailable", why } };
    }
    return { name: result.name, outcome: { status: wanted, why, remedy } };
  });
}

/**
 * Which of this loop's labels the repository is missing, and the exact command
 * that creates each. Pure, so the expensive failure it prevents — see the file
 * header — is pinned by a test rather than by an operator's memory.
 */
export function missingLabels(loop: LoopName, existing: string[], extra: readonly string[] = []): string[] {
  const have = new Set(existing.map((name) => name.toLowerCase()));
  return requiredLabels(loop, extra).filter((name) => !have.has(name.toLowerCase()));
}

/**
 * The loop identity, validated against the project's roster (`loops` in its
 * config), which every claim fence reads.
 * `ralph.sh` resolves and exports it; an empty or unknown value here means the
 * preflight was run by hand from a shell that never did.
 */
export function resolveLoopName(raw: string | undefined, roster: readonly string[] = loopRoster()): LoopName | null {
  if (raw === undefined || raw === "") return null;
  return roster.includes(raw) ? raw : null;
}

export interface Ran {
  ok: boolean;
  /** stdout alone. Anything PARSED comes from here — see `output`. */
  stdout: string;
  /**
   * stdout and stderr together, for classification only: a CLI may report the
   * reason on either stream. Never parse it — `gh` writes its new-release
   * notice to stderr on a *successful* command, so a merged string would fail
   * to parse as JSON on any machine with an outdated `gh`, and a healthy setup
   * would be refused for "returning something this preflight cannot parse".
   */
  output: string;
  timedOut: boolean;
}

const timeoutMs = (): number => {
  const raw = process.env.RALPH_PREFLIGHT_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
};

/**
 * Run a probe, never throwing, always bounded. Every call site treats failure
 * as an answer rather than an exception, so throwing would only be caught and
 * converted back into this.
 */
function run(command: string, args: string[]): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs(), maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `killed` is how a timeout arrives from `execFile` — the signal, not
        // an `ETIMEDOUT` code. It also covers a `maxBuffer` overflow and an
        // outside SIGTERM, and reading those as unavailable is the right
        // widening: none is evidence that the operator's setup is wrong, and
        // all three end the probe without an answer.
        resolve({
          ok: error === null,
          stdout,
          output: `${stdout}${stderr}`,
          timedOut: error !== null && "killed" in error && error.killed === true,
        });
      },
    );
  });
}

/** Is this name an executable on PATH? The `command -v` a shell would run. */
async function onPath(name: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return false;
}

/**
 * The CLIs an ITERATION shells out to. `bun` is absent on purpose — this file
 * is running under it — and so is everything `ralph.sh` needs for its own next
 * statement, which it checks there.
 */
const REQUIRED_TOOLS: { name: string; why: string; remedy: string }[] = [
  {
    name: "git",
    why: "the iteration cannot read the repository without it",
    remedy: "install git and re-run",
  },
  {
    name: "gh",
    why: "the claim, the pull request, and CI are all read through it",
    remedy: "install the GitHub CLI: https://cli.github.com",
  },
  {
    name: "claude",
    why: "the orchestrator turn is a `claude -p` process",
    remedy: "install Claude Code and re-run",
  },
  {
    name: "python3",
    why: "the orchestrator event stream is rendered and redacted by `stream-render.py`",
    remedy: "install Python 3 and re-run",
  },
  {
    name: "uuidgen",
    why: "each iteration is given a fixed session id so `usage.py` can find its transcript",
    remedy: "install util-linux (uuidgen) and re-run",
  },
];

/**
 * Where a credential check says a secret should be set: the Doppler scope, the
 * configured dotenv file, or "" when the project has no secrets runner.
 */
function secretsScope(config: ProjectConfig | null): string {
  if (config?.secrets.runner === "doppler") return ` in Doppler ${config.secrets.project}/${config.secrets.config}`;
  if (config?.secrets.runner === "dotenv") return ` in ${config.secrets.file}`;
  return "";
}

/**
 * The secrets manager's CLI, when the project's config names one. `dotenv` has
 * none: the file is read by `bun`, which every run already requires.
 */
const SECRETS_TOOLS: Record<string, { name: string; why: string; remedy: string }> = {
  doppler: {
    name: "doppler",
    why: "the iteration runs under `doppler run`",
    remedy: "install the Doppler CLI and re-run",
  },
};

export function requiredTools(
  config: ProjectConfig | null,
  role: Role = DEFAULT_ROLE,
): { name: string; why: string; remedy: string }[] {
  // The secrets CLI is owed only by a role the project's secrets manager wraps.
  // A triager is given no application environment at all, so requiring the CLI
  // that injects it would refuse the start for a tool that is never invoked —
  // the same over-strictness that drops `doppler-scope` from its list.
  const secrets =
    config === null || !ROLE_DESCRIPTORS[role].secrets.manager ? undefined : SECRETS_TOOLS[config.secrets.runner];
  const runner = process.env.RALPH_RUNNER_ORCHESTRATOR?.trim() || resolveLineup({ config: loadConfig(), role }).orchestrator.runner;
  const tools = REQUIRED_TOOLS.map((tool) => tool.name === "claude" && runner === "codex"
    ? { name: "codex", why: "the orchestrator turn runs through codex exec", remedy: "install Codex CLI, run codex login, and re-run" }
    : tool);
  // Kept in the position it always had (after claude), so the first missing
  // tool's remedy is the same one an operator saw before the seam.
  if (secrets) tools.splice(3, 0, secrets);
  return tools;
}

/**
 * The executor stage's runner, resolved the way `requiredTools` resolves the
 * orchestrator's, or null for a role whose lineup has no executor at all
 * (`roles.ts` `stages`).
 *
 * Null is unreachable from the one caller — the `executor-tools` check is not in
 * such a role's list — and is here so that a role added later cannot resolve a
 * stage it does not run by way of a default this function fell back to.
 */
function executorRunner(role: Role): Runner | null {
  // The override is read FIRST, exactly as `requiredTools` reads the
  // orchestrator's: an operator who has named the runner has answered the
  // question, and resolving the file anyway would fail the whole preflight on a
  // `models.json` the run was never going to consult.
  const override = process.env.RALPH_RUNNER_EXECUTOR?.trim();
  if (override) return override as Runner;
  return resolveLineup({ config: loadConfig(), role }).executor?.runner ?? null;
}

/**
 * The `executor-tools` result for `role`, as the zero-or-one-element list the
 * check list splices in.
 *
 * Empty for a role with no executor stage: the probe would be asking whether a
 * sandbox this role never enters is usable. Its list drops the check anyway, so
 * this is the second fence rather than the first.
 */
async function executorToolsResult(role: Role): Promise<CheckResult[]> {
  const runner = executorRunner(role);
  return runner === null ? [] : [await checkExecutorTools(runner)];
}

async function checkTools(config: ProjectConfig | null, role: Role): Promise<CheckResult> {
  const tools = requiredTools(config, role);
  const missing: string[] = [];
  for (const tool of tools) {
    if (!(await onPath(tool.name))) missing.push(tool.name);
  }
  if (missing.length === 0) {
    return { name: "tools", outcome: { status: "ok", detail: `${tools.length} on PATH` } };
  }
  const first = tools.find((tool) => tool.name === missing[0])!;
  return {
    name: "tools",
    outcome: {
      status: "denied",
      why: `not on PATH: ${missing.join(", ")} — ${first.why}`,
      remedy: first.remedy,
    },
  };
}

/**
 * The shims briefs name directly, each beside the runtime that provides it.
 * A host without the runtime owes nothing; a host with it owes the shim.
 */
const EXECUTOR_SHIMS: { shim: string; runtime: string }[] = [
  { shim: "bunx", runtime: "bun" },
  { shim: "npm", runtime: "node" },
  { shim: "npx", runtime: "node" },
];

const CODEX_TOOL_PROBE = ["bash", join(RALPH_HOME, "codex-executor.sh"), "--probe-tools"];

/**
 * Can the executor run the commands its brief spells out? On 2026-09-23 the
 * Codex sandbox exposed `bun` but not `bunx`, and four of five overnight runs
 * typed the `bunx jest …` they were told to, got exit 127, and spent steps
 * finding out `bun x` worked. Nothing failed loudly; the cost was the steps.
 *
 * The codex runner is asked from inside its own sandbox: its PATH is not the
 * supervisor's, so a tool on this PATH proves nothing there. `opencode` and
 * `claude` inherit this PATH through `env -i PATH=…`, so it is read directly.
 * A Codex executor with no bubblewrap is left alone: `delegate.sh` degrades
 * on exactly that and says so.
 */
export async function checkExecutorTools(runner: Runner, probe: string[] = CODEX_TOOL_PROBE): Promise<CheckResult> {
  if (runner === "codex") {
    if (!(await onPath("bwrap"))) {
      return { name: "executor-tools", outcome: { status: "ok", detail: "skipped — no bubblewrap; delegate.sh degrades" } };
    }
    const [command, ...args] = probe;
    const { ok, output } = await run(command!, args);
    if (ok) return { name: "executor-tools", outcome: { status: "ok" } };
    const failed = output.split("\n").filter((line) => line !== "" && !line.startsWith("ok ")).join("; ");
    return {
      name: "executor-tools",
      outcome: {
        status: "denied",
        why: `the Codex executor's sandbox cannot run what briefs tell it to: ${failed || "the probe failed"}`,
        remedy: `expose the tool in ralph/codex-executor.sh (runtime_args), then check: bash ${join(RALPH_HOME, "codex-executor.sh")} --probe-tools`,
      },
    };
  }
  const missing: string[] = [];
  for (const { shim, runtime } of EXECUTOR_SHIMS) {
    if ((await onPath(runtime)) && !(await onPath(shim))) missing.push(`${shim} (beside ${runtime})`);
  }
  if (missing.length === 0) return { name: "executor-tools", outcome: { status: "ok" } };
  return {
    name: "executor-tools",
    outcome: {
      status: "denied",
      why: `the ${runner} executor inherits this PATH, which has no ${missing.join(", ")}`,
      remedy: "reinstall the runtime so its shims sit beside it on PATH (bun: ln -s bun \"$(dirname \"$(command -v bun)\")/bunx\")",
    },
  };
}

/**
 * The loop writes an iteration log, a supervisor log and a usage ledger into
 * `.ralph/logs`. A read-only or absent directory is a permission failure that
 * would otherwise surface mid-iteration, after the turn was paid for.
 */
export async function checkLogsWritable(): Promise<CheckResult> {
  const dir = ".ralph/logs";
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      return {
        name: "logs-writable",
        outcome: {
          status: "denied",
          why: `${dir} exists but is not a directory`,
          remedy: `remove it and run: mkdir -p ${dir}`,
        },
      };
    }
  } catch {
    return {
      name: "logs-writable",
      outcome: {
        status: "denied",
        why: `${dir} does not exist, so this run could not be logged`,
        remedy: `mkdir -p ${dir}`,
      },
    };
  }
  try {
    await access(dir, constants.W_OK);
  } catch {
    return {
      name: "logs-writable",
      outcome: {
        status: "denied",
        why: `${dir} is not writable by this user`,
        remedy: `chmod u+w ${dir}`,
      },
    };
  }
  return { name: "logs-writable", outcome: { status: "ok" } };
}

function checkLoopIdentity(raw: string | undefined, loop: LoopName | null, roster: readonly string[]): CheckResult {
  if (loop !== null) {
    return { name: "loop-identity", outcome: { status: "ok", detail: loop } };
  }
  return {
    name: "loop-identity",
    outcome: {
      status: "denied",
      why:
        raw === undefined || raw === ""
          ? "RALPH_LOOP_NAME is not set, so a claim would carry no owner"
          : `RALPH_LOOP_NAME is '${raw}', which no claim fence reads`,
      remedy:
        roster.length === 0
          ? "fix .ralph/config.json first: its `loops` names the loops this project runs"
          : `write one of ${roster.join(", ")} into .ralph/loop-name, or export RALPH_LOOP_NAME`,
    },
  };
}

async function checkGitHubCredentials(): Promise<CheckResult> {
  const { ok, output, timedOut } = await run("gh", ["auth", "status"]);
  if (ok) return { name: "github-credentials", outcome: { status: "ok" } };
  if (classifyFailure(output, timedOut) === "unavailable") {
    return {
      name: "github-credentials",
      outcome: { status: "unavailable", why: "GitHub could not be reached to verify credentials" },
    };
  }
  return {
    name: "github-credentials",
    outcome: {
      status: "denied",
      why: "the GitHub CLI is not authenticated, so the loop could neither claim nor read a ticket",
      remedy: "gh auth login",
    },
  };
}

/**
 * The three labels this loop claims, parks and finishes with. Missing ones are
 * the single most expensive setup failure the loop has: `takeOne` records the
 * failed `--add-label` as an obstruction and walks on, so a loop with no
 * labels burns a whole Opus iteration claiming nothing, and repeats until the
 * iteration cap.
 */
async function checkLoopLabels(loop: LoopName | null, role: Role, roster: JavRoster, apps: AppLabels | null): Promise<CheckResult> {
  if (loop === null) {
    // Nothing to ask about, and no verdict to distort: `loop-identity` is
    // already denying, so this run cannot come back ready whatever this says.
    return { name: "loop-labels", outcome: { status: "ok", detail: "skipped — no loop identity" } };
  }
  // Before the network call: a role whose labels cannot even be enumerated has
  // nothing to compare the repository against, and asking GitHub first would
  // report the wrong missing set.
  // Any non-null answer, an unavailable credential included, is a keyed project.
  const keyed = keyedTrackerFor(projectRoot());
  const wanted = requiredLabelsFor(loop, role, roster, { keyed: keyed !== null, apps });
  if ("why" in wanted) {
    return {
      name: "loop-labels",
      outcome: {
        status: "denied",
        why: `the labels a ${role} needs could not be read: ${wanted.why}`,
        remedy: `fix ${javPath()} (bun ${join(RALPH_HOME, "jav.ts")} --json shows what it parses as)`,
      },
    };
  }
  // A Linear or Jira project's labels and states live on its tracker (#334).
  if (keyed !== null) {
    const config = projectTrackerConfig(projectRoot());
    return checkTrackerLabels(keyed, wanted.labels, config !== null && config.kind !== "github" ? [config.states.claimed, config.states.done] : []);
  }
  const { ok, stdout, output, timedOut } = await run("gh", [
    "label",
    "list",
    "--limit",
    String(LABEL_LIMIT),
    "--json",
    "name",
  ]);
  if (!ok) {
    return {
      name: "loop-labels",
      outcome:
        classifyFailure(output, timedOut) === "unavailable"
          ? { status: "unavailable", why: "the repository's labels could not be read" }
          : {
              status: "denied",
              why: "the repository's labels could not be read, and not because of the network",
              remedy: "check repository access: gh label list",
            },
    };
  }
  let names: string[];
  try {
    names = (JSON.parse(stdout) as { name: string }[]).map((label) => label.name);
  } catch {
    return {
      name: "loop-labels",
      outcome: {
        status: "denied",
        why: "`gh label list --json name` returned something this preflight cannot parse",
        remedy: "check the gh version: gh label list --json name",
      },
    };
  }
  const have = new Set(names.map((name) => name.toLowerCase()));
  const absent = wanted.labels.filter((name) => !have.has(name.toLowerCase()));
  // A label in `CREATED_LABELS` is created here, as a Linear or Jira project's
  // `ensureLabels` does: one a later release declares would otherwise deny
  // every GitHub loop at its next start until somebody ran `gh label create`,
  // and nobody is awake for that. Every other missing label — the loop's own
  // triple, whose denial `adding-an-agent.md` §6 quotes, and any role label an
  // operator spells — is denied as before. A create that fails for any reason
  // but "already exists" or the network leaves the label denied.
  const triple = requiredLabels(loop);
  const missing: string[] = [];
  for (const name of absent) {
    const spec = Object.hasOwn(CREATED_LABELS, name) ? CREATED_LABELS[name] : undefined;
    if (spec !== undefined) {
      const created = await run("gh", ["label", "create", name, "--color", spec.color, "--description", spec.description]);
      if (created.ok || /already exists/i.test(created.output)) continue;
      if (classifyFailure(created.output, created.timedOut) === "unavailable") {
        return { name: "loop-labels", outcome: { status: "unavailable", why: `the ${name} label could not be created` } };
      }
    }
    missing.push(name);
  }
  if (missing.length === 0) {
    return { name: "loop-labels", outcome: { status: "ok", detail: wanted.labels.join(" ") } };
  }
  return {
    name: "loop-labels",
    outcome: {
      status: "denied",
      // The claim-label wording is quoted verbatim by `adding-an-agent.md` §6,
      // so it stays exactly as it was. The other branch is role-neutral: a
      // ci-doctor needs `ci-health` and triages nothing.
      why: `the repository has no ${missing.join(", ")} label, so this loop could ${
        missing.some((name) => triple.includes(name)) ? "claim nothing" : `not label its work as a ${role}`
      }`,
      remedy: missing.map((name) => `gh label create ${name}`).join(" && "),
    },
  };
}

/** The project's Linear or Jira tracker, the reason it cannot be had, or null on GitHub. */
function keyedTrackerFor(root: string): Tracker | TrackerUnavailableError | null {
  try {
    return keyedProjectTracker(root);
  } catch (error) {
    if (error instanceof TrackerUnavailableError) return error;
    throw error;
  }
}

/**
 * Who `checkTrackerLabels` reports for: the check's name, what a label the
 * tracker refused would cost, where it is created by hand, and how a state
 * the tracker lacks is fixed. A loop's and a clerk's results differ in all
 * four, and both land in one report.
 */
export interface TrackerLabelsCaller {
  name: PreflightCheck;
  cost: string;
  /** Where a refused label is created by hand; null is the tracker itself. */
  where: string | null;
  statesRemedy: string;
}

const LOOP_LABELS_CALLER: TrackerLabelsCaller = {
  name: "loop-labels",
  cost: "this loop could claim nothing",
  where: null,
  statesRemedy: "set tracker.states in .ralph/config.json to states the tracker has",
};

/**
 * The loop's labels on a Linear or Jira tracker, created when missing (Linear
 * labels are per team; Jira's are free-form and need none), and the claimed
 * and done states the config maps checked against the tracker's workflow, so
 * a misspelt state is named before the first claim rather than warned about
 * on every one.
 */
export async function checkTrackerLabels(
  tracker: Tracker | TrackerUnavailableError,
  labels: string[],
  mapped: string[],
  caller: TrackerLabelsCaller = LOOP_LABELS_CALLER,
): Promise<CheckResult> {
  const name = caller.name;
  if (tracker instanceof TrackerUnavailableError) {
    return {
      name,
      outcome: { status: "denied", why: tracker.message, remedy: "connect the project's tracker from the dashboard (Setup → Tracker)" },
    };
  }
  let ensured: { created: string[]; missing: string[] };
  let states: string[] | null;
  try {
    ensured = await tracker.ensureLabels(labels);
    states = tracker.workflowStates === undefined ? null : await tracker.workflowStates();
  } catch (error) {
    return {
      name,
      outcome: { status: "unavailable", why: `the ${tracker.kind} tracker could not be read: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
  if (ensured.missing.length > 0) {
    return {
      name,
      outcome: {
        status: "denied",
        why: `the ${tracker.kind} tracker has no ${ensured.missing.join(", ")} label and refused to create it, so ${caller.cost}`,
        remedy: `create ${ensured.missing.join(", ")} in ${caller.where ?? tracker.kind} by hand`,
      },
    };
  }
  const absent = states === null ? [] : mapped.filter((state) => !states.includes(state));
  if (absent.length > 0) {
    return {
      name,
      outcome: {
        status: "denied",
        why: `the ${tracker.kind} tracker has no workflow state named ${absent.map((state) => `'${state}'`).join(" or ")} (it has ${states!.join(", ")})`,
        remedy: caller.statesRemedy,
      },
    };
  }
  const created = ensured.created.length === 0 ? "" : ` (created ${ensured.created.join(", ")})`;
  return { name, outcome: { status: "ok", detail: `${labels.join(" ")}${created}` } };
}

/**
 * The Jira intake board a clerk files on (felipearos/ralph#447): readable by
 * the clerk's Jira account, holding every workflow status the clerk moves
 * tickets to, and — when one is configured — the story points field.
 *
 * An unreadable board or a missing status is a DENIAL for a live or quiet clerk, with
 * the config remedy: the first report of the night would otherwise be filed
 * nowhere, or land in a status nobody confirms from. In shadow, which files
 * nothing, each is a warning. A missing points field is a warning in both:
 * the points still go in the description.
 *
 * Asked with the credential the supervisor hands the preflight (it exports
 * the gate's proved secrets to it); none in the environment is not asked,
 * because `clerk-credentials` already says why. Null for any other role and
 * for a shadow clerk with no board. `build` is the seam a test hands a fake
 * Jira through.
 */
export async function checkClerkIntakeBoard(
  config: ProjectConfig | null,
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
  build: (site: string, credential: { email: string; token: string }) => JiraClient = (site, credential) => jiraClient(site, credential),
): Promise<CheckResult | null> {
  if (role !== "clerk" || config === null) return null;
  const rules = clerkRules(config);
  const board = rules?.jira.intakeProject ?? null;
  if (rules === null || board === null) return null;
  const credential = parseJiraToken(env[JIRA_TOKEN_ENV]);
  if (credential === null) return null;
  const name = "clerk-intake-board" as const;
  // Quiet writes the board as live does (felipearos/ralph#443), so it needs it as live does.
  const live = rules.mode !== "shadow";
  const refuse = (why: string, remedy: string): CheckResult => ({ name, outcome: live ? { status: "denied", why, remedy } : { status: "warn", why, remedy } });
  const jira = build(rules.jira.site, credential);
  let statuses: string[];
  try {
    await jira.project(board);
    statuses = await jira.projectStatuses(board);
  } catch (error) {
    const why = error instanceof JiraError ? error.failure.why : error instanceof Error ? error.message : String(error);
    // A board Jira could not be reached for is a wait for a live clerk, not
    // a config to fix; one it refused is the config's.
    if (live && error instanceof JiraError && error.failure.kind !== "denied") return { name, outcome: { status: "unavailable", why: `the Jira intake board ${board} could not be read: ${why}` } };
    return refuse(
      `the Jira intake board ${board} cannot be read by the clerk's Jira account: ${why}`,
      `set clerk.jira.intakeProject in .ralph/config.json to a board the account behind ${JIRA_TOKEN_ENV} can browse, or give it access to ${board}`,
    );
  }
  const wanted = Object.entries(clerkJira(rules.jira).statuses);
  const absent = wanted.filter(([, status]) => !statuses.includes(status));
  if (absent.length > 0) {
    return refuse(
      `the Jira intake board ${board} has no workflow status named ${absent.map(([, status]) => `'${status}'`).join(" or ")} (it has ${statuses.join(", ") || "none"})`,
      `set ${absent.map(([key]) => `clerk.jira.statuses.${key}`).join(" and ")} in .ralph/config.json to the status names ${board}'s workflow has`,
    );
  }
  // A warning, live or not: without it the clerk files and confirms as
  // before, and only the merged move is a note on every poll.
  const merged = clerkJira(rules.jira).mergedStatus;
  if (merged !== null && !statuses.includes(merged)) {
    return {
      name,
      outcome: {
        status: "warn",
        why: `the Jira intake board ${board} has no workflow status named '${merged}', so no ticket moves there when its PR is merged (it has ${statuses.join(", ") || "none"})`,
        remedy: `add a '${merged}' status to ${board}'s workflow, or set clerk.jira.mergedStatus in .ralph/config.json to one it has`,
      },
    };
  }
  const field = rules.jira.storyPointsField ?? null;
  if (field !== null) {
    let known: boolean;
    try {
      known = (await jira.fields()).some((one) => one.id === field);
    } catch (error) {
      const why = error instanceof JiraError ? error.failure.why : error instanceof Error ? error.message : String(error);
      return {
        name,
        outcome: { status: "warn", why: `the Jira field list could not be read (${why}), so ${field} is unchecked; if it is wrong, story points go in the description`, remedy: "nothing to do unless it persists" },
      };
    }
    if (!known) {
      return {
        name,
        outcome: {
          status: "warn",
          why: `Jira has no field ${field}, so story points will go in the description of each intake ticket instead`,
          remedy: "set clerk.jira.storyPointsField in .ralph/config.json to the story points field id Jira's field list names, or remove it",
        },
      };
    }
  }
  const named = [...wanted.map(([, status]) => status), ...(merged === null ? [] : [merged])];
  return { name, outcome: { status: "ok", detail: `${board}: ${named.join(", ")}${field === null ? "" : `, ${field}`}` } };
}

/**
 * The dotenv file a `dotenv` project's children run under (#49), read before
 * any child starts: a missing, unreadable or malformed file would otherwise
 * surface as a child failing on an absent variable, far from its cause. A file
 * git tracks in the project is refused first, being the worst of the four —
 * its values are already in the history. No value from the file ever reaches
 * a `why` or a `remedy`: the parser's own reasons name a line number only.
 */
export async function checkSecretsFile(root: string, config: ProjectConfig): Promise<CheckResult> {
  const name = "secrets-file";
  if (config.secrets.runner !== "dotenv") return { name, outcome: { status: "ok" } };
  const configured = config.secrets.file;
  const path = resolve(root, configured);
  const read = readDotenvFile(path);
  if (read.kind !== "missing") {
    // Only a path inside the project can be tracked by it; asking git about one
    // outside would fail as "outside repository", which is not an answer. A
    // name that merely starts with two dots (`..env`) is still inside.
    const inside = relative(resolve(root), path);
    const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
    if (inside !== "" && !outside) {
      const tracked = await run("git", ["-C", root, "ls-files", "--error-unmatch", "--", inside]);
      if (tracked.ok) {
        return {
          name,
          outcome: {
            status: "denied",
            why: `the secrets file ${path} is tracked by git in the project, so its values are in the repository's history`,
            remedy: `git rm --cached ${inside}, add it to .gitignore, and rotate every value it holds — they are in the history`,
          },
        };
      }
      // Untracked is not enough: a coder's `git add -A`, or the supervisor's
      // own role-violation patch and `git clean`, would publish or delete a
      // file git does not ignore. Asked as "is it ignored", so a git that
      // could not answer refuses rather than passing the file.
      const ignored = await run("git", ["-C", root, "check-ignore", "-q", "--", inside]);
      if (!ignored.ok) {
        return {
          name,
          outcome: {
            status: "denied",
            why: `the secrets file ${path} is inside the project and not ignored by git, so a commit or a clean could take it`,
            remedy: `add ${inside} to the project's .gitignore, or move the file outside the project and point secrets.file at it`,
          },
        };
      }
    }
  }
  switch (read.kind) {
    case "ok":
      return { name, outcome: { status: "ok", detail: path } };
    case "missing":
      return {
        name,
        outcome: {
          status: "denied",
          why: `the secrets file ${path} is missing`,
          remedy: `create ${path} with the project's secrets as KEY=value lines (secrets.file in .ralph/config.json names it)`,
        },
      };
    case "unreadable":
      return {
        name,
        outcome: {
          status: "denied",
          why: `the secrets file ${path} is unreadable (${read.why})`,
          remedy: `make ${path} a regular file the loop's user can read`,
        },
      };
    case "malformed":
      return {
        name,
        outcome: {
          status: "denied",
          why: `the secrets file ${path} is malformed: ${read.why}`,
          remedy: `fix the named line of ${path}`,
        },
      };
  }
}

/**
 * Probe the same explicit scope used for child execution (`secrets.project` /
 * `secrets.config` in the project's config). Only names are read here;
 * development-env.sh runs the project's own check on the injected values before
 * a child starts.
 */
async function checkDopplerScope(scope: { project: string; config: string }): Promise<CheckResult> {
  const { ok, output, timedOut } = await run("doppler", ["secrets", "--only-names", "--json", "-p", scope.project, "-c", scope.config]);
  if (ok) return { name: "doppler-scope", outcome: { status: "ok" } };
  const raw = dopplerOutput(output);
  if (dopplerFailure(output, timedOut) === "unavailable") {
    return {
      name: "doppler-scope",
      outcome: { status: "unavailable", why: `the Doppler secrets could not be read${raw ? `: ${raw}` : ""}` },
    };
  }
  return {
    name: "doppler-scope",
    outcome: {
      status: "denied",
      why: `Doppler ${scope.project}/${scope.config} secrets cannot be read — missing access or expired auth${raw ? `: ${raw}` : ""}`,
      remedy: `doppler setup -p ${scope.project} -c ${scope.config}   (then: doppler login)`,
    },
  };
}

/**
 * The Doppler outputs that name a problem only the operator can fix: auth,
 * setup or scope. Doppler is classified the other way round from GitHub — a
 * failure is a wait unless it says it is a denial — because on 2026-10-21 the
 * boot-time `doppler secrets` output matched no pattern and seven loops
 * stopped as denied. A transient read must be a wait, not a stopped loop.
 */
const DOPPLER_DENIED_EVIDENCE =
  /unauthori[sz]ed|\b401\b|\b403\b|forbidden|(?:invalid|expired|revoked) (?:auth |service |personal )?token|token (?:has )?(?:expired|is invalid|revoked)|doppler login|doppler setup|you must specify a (?:project|config)|(?:project|config|environment) (?:\S+ )?not found|could not find (?:the )?(?:project|config)|access denied|permission|not authenticated|unable to authenticate|(?:provide|no) (?:a )?(?:auth |service )?token/i;

export function dopplerFailure(output: string, timedOut = false): "denied" | "unavailable" {
  if (timedOut || UNAVAILABLE_EVIDENCE.test(output)) return "unavailable";
  return DOPPLER_DENIED_EVIDENCE.test(output) ? "denied" : "unavailable";
}

/** The raw Doppler output, on one line and short enough for a log line. */
function dopplerOutput(output: string, limit = 300): string {
  const flat = output.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** The warning a secret the supervisor could not read answers (#767). */
function unreadWarning(secret: string, scope: string): Outcome {
  return {
    status: "warn",
    why: `${secret} could not be read from the secrets manager${scope}`,
    remedy: "nothing to do if it reads on a later try; the supervisor reads it again before each poll",
    unread: true,
  };
}

/**
 * Whether an iteration can read its CI logs. `ralph.sh` exports
 * RALPH_BUILDKITE_READ_TOKEN only after `bk-log.ts --check-token` has proved it
 * read-only, so its presence here is the whole answer and no probe is needed.
 * Asked only of a project whose required checks include a Buildkite one; a
 * warning, because a loop without logs still works — it explains red CI worse.
 *
 * Unless the supervisor lists the token as UNREAD: Doppler failed for a reason
 * other than "not found" — on 2026-10-28 a keyring still locked at boot — so
 * the token may well be stored. That is still a warning, marked `unread`: a
 * coder works without the token and the supervisor reads it again before each
 * poll (#759), so holding it at startup would be over-reach. Only where the
 * warning is a denial — the ci-doctor and the pr-medic, whose stop over a
 * locked keyring took loggd's doc and medi loops down that night —
 * `applyVerdicts` turns it into `unavailable`, a wait (#767).
 */
export function checkBuildkiteLogs(
  config: ProjectConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult | null {
  if (!config?.requiredChecks.some((name) => name.startsWith("buildkite/"))) return null;
  if (env.RALPH_BUILDKITE_READ_TOKEN?.trim()) return { name: "buildkite-logs", outcome: { status: "ok" } };
  const scope = secretsScope(config);
  const names = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter((name) => name !== "");
  if (names(env.RALPH_ROLE_SECRETS_UNREAD).includes("RALPH_BUILDKITE_READ_TOKEN")) {
    return { name: "buildkite-logs", outcome: unreadWarning("RALPH_BUILDKITE_READ_TOKEN", scope) };
  }
  return {
    name: "buildkite-logs",
    outcome: {
      status: "warn",
      why: "no read-only Buildkite token, so iterations cannot read why a CI check is red",
      remedy: `store a token with only read_builds, read_build_logs and read_artifacts as RALPH_BUILDKITE_READ_TOKEN${scope}, and restart`,
    },
  };
}

/**
 * Whether gh can read the project's GitHub Actions runs, the GitHub Actions
 * counterpart of {@link checkBuildkiteLogs}: `gh-actions-log.ts` and
 * `ci-log.ts` read a red Actions check's logs through gh, so a token without
 * Actions access leaves an iteration unable to say why CI is red.
 *
 * Always a warning, never a denial, whatever the probe says: a loop that
 * cannot read CI logs still works, it only explains red CI worse, and a probe
 * that could refuse a start would turn a GitHub blip into a stuck loop.
 *
 * Fenced to a project with a required check that could be an Actions job. The
 * provider is inferred from the check name alone, and a `buildkite/` check is
 * `bk-log.ts`'s, so a project requiring only those (or nothing) asks gh nothing.
 * The repo comes from the config, as {@link checkVerifierDeploySource}'s does.
 */
export async function checkActionsLogs(
  config: ProjectConfig | null,
  read: (args: string[]) => Promise<Ran> = (args) => run("gh", args),
): Promise<CheckResult | null> {
  if (!config?.requiredChecks.some((name) => !name.startsWith("buildkite/"))) return null;
  const ran = await read(["api", `repos/${config.repo}/actions/runs?per_page=1`]);
  if (ran.ok) return { name: "actions-logs", outcome: { status: "ok" } };
  // gh prints the response body on stdout before its own `gh: … (HTTP 403)` line, so prefer that line.
  const lines = ran.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const first = lines.find((line) => line.startsWith("gh:")) ?? lines[0] ?? "gh printed nothing";
  // GitHub answers a rate limit with a 403 too; that is "try later", not a
  // missing scope, and a wrong remedy teaches an operator to skip warnings.
  if (ran.timedOut || isRateLimited(ran.output) || !/HTTP 40[34]|resource not accessible/i.test(ran.output)) {
    return {
      name: "actions-logs",
      outcome: {
        status: "warn",
        why: `GitHub could not be reached to check that gh can read ${config.repo}'s Actions logs: ${first}`,
        remedy: "nothing to do if GitHub is down; otherwise check gh auth status, and restart",
      },
    };
  }
  return {
    name: "actions-logs",
    outcome: {
      status: "warn",
      why: `gh cannot read ${config.repo}'s GitHub Actions runs, so iterations cannot read why a CI check is red: ${first}`,
      remedy: `give gh's token read access to Actions on ${config.repo} (classic: repo; fine-grained: Actions read), and restart`,
    },
  };
}

/**
 * Whether this loop's gate can retry a candidate flake's failed job itself.
 *
 * A warning, never a denial: without the token the loop still watches CI,
 * classifies failures and fixes them — it just cannot ask Buildkite to re-run a
 * job, so it only ever sees a flake's second verdict on a rerun somebody else
 * triggered. That is a worse doctor, not a broken one.
 *
 * Worded for the LOOP rather than for the doctor since felipearos/ralph#245:
 * the pr-medic declares the same token, so naming the doctor here would print
 * an operator of a `medi` loop a remedy about a role it does not hold.
 *
 * Asked only of a role that DECLARES the secret, which is what keeps a coder's
 * results unchanged (#158 AC 3) without the coder's check list having to refuse
 * it: `roles.ts`'s convention is that a role states what it drops, so a new
 * check reaching every role is the behaviour to preserve, and "does this role
 * work with that credential at all" is a question about the descriptor rather
 * than about the role's name.
 *
 * The presence test is NOT the environment alone. The retry token is a `gate`
 * secret: `ralph.sh` keeps its value for the intake gate's own invocation and
 * `unset`s it everywhere else — including from its own environment, which this
 * preflight inherits — so a correctly configured doctor would otherwise be
 * warned on every start. The supervisor's two name lists are the only answer
 * available here, and the WITHHELD one is why there are two: a token the
 * operator has stored can still be withheld, because `ralph.sh` withholds a
 * credential its check refused exactly as it does one with no checker at all.
 * Reporting that as "no token" would print a remedy the operator has already
 * followed.
 *
 * A third list, UNREAD, answers before both warnings: Doppler failed for a
 * reason other than "not found", so whether the token is stored is unknown.
 * A warning marked `unread` says so (#767) — the supervisor reads it again
 * before each poll (#759) — where "no token" would print a store-it remedy
 * that may already be done.
 */
export function checkBuildkiteRetry(
  config: ProjectConfig | null,
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult | null {
  const secret = "RALPH_BUILDKITE_RETRY_TOKEN";
  const declared = ROLE_DESCRIPTORS[role].secrets.named.find((named) => named.name === secret);
  if (declared === undefined) return null;
  // The same fence `buildkite-logs` has: a project whose CI is not Buildkite
  // has no job for this token to retry, and reporting the check at all would
  // name a remedy that does nothing.
  if (!config?.requiredChecks.some((name) => name.startsWith("buildkite/"))) return null;
  const names = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter((name) => name !== "");
  // The environment answers only for a hand-run `preflight.ts` — under the
  // supervisor a gate secret is unset before this runs, whether or not the host
  // exported it — and then only while the secret HAS a checker. A visible value
  // is not a usable one: `ralph.sh` hands the gate nothing it has not proved, so
  // reporting `ok` because the token is in the environment would be this check's
  // own defect inverted, telling an operator who ran it under their secrets
  // manager that a credential works while every supervisor start withholds it.
  const inEnvironment = (env[secret]?.trim() ?? "") !== "";
  const proved = declared.check !== null;
  const withheld = names(env.RALPH_ROLE_SECRETS_WITHHELD).includes(secret);
  // The supervisor's own lists outrank what the environment shows, and
  // WITHHELD is read before AVAILABLE: a hand-run preflight under the secrets
  // manager sees the value even on a start that refused it, and `ok` there
  // would contradict the very supervisor whose list is in the same environment.
  if (!withheld && (names(env.RALPH_ROLE_SECRETS_AVAILABLE).includes(secret) || (inEnvironment && proved))) {
    return { name: "buildkite-retry", outcome: { status: "ok" } };
  }
  const scope = secretsScope(config);
  if (names(env.RALPH_ROLE_SECRETS_UNREAD).includes(secret)) {
    return { name: "buildkite-retry", outcome: unreadWarning(secret, scope) };
  }
  if (withheld || inEnvironment) {
    return {
      name: "buildkite-retry",
      outcome: {
        status: "warn",
        why: "a write-capable Buildkite token is stored but withheld, so this loop runs on natural reruns only",
        remedy:
          declared.check === null
            ? `wait for ${secret}'s check command to ship: an unproved credential that can write builds is withheld exactly as a failed one is`
            : `find why ${declared.check} refused it, and store a token with exactly write_builds as ${secret}, and restart`,
      },
    };
  }
  return {
    name: "buildkite-retry",
    outcome: {
      status: "warn",
      why: "no write-capable Buildkite token, so this loop cannot re-run a candidate flake's job and runs on natural reruns only",
      remedy: `store a token with exactly write_builds as ${secret}${scope}, and restart`,
    },
  };
}

/**
 * Whether the clerk's gate — or a live triager's — was handed every
 * credential it works through.
 *
 * A DENIAL, not the retry token's warning: a clerk without its Slack token
 * cannot read the channel at all, so starting one would only have its gate
 * stop the loop on the first poll — at 3 a.m. rather than at the start, which
 * is the trade the spec refuses (felipearos/ralph#315). Asked only of a role
 * that declares a `RALPH_CLERK_*` secret, which keeps every other role's
 * results unchanged without their lists having to drop the check.
 *
 * A triager declares the Jira token too, but needs it only when `triage.jira`
 * is live (#397): shadow writes nothing to Jira and a project with no block
 * moves nothing, so either is asked nothing rather than denied for a token it
 * would never use.
 *
 * Read off the supervisor's two name lists, for `buildkite-retry`'s reason:
 * the clerk's tokens are `gate` secrets, unset from this process before it
 * runs, so the environment cannot answer — and a token that IS stored but
 * failed its check is withheld, which is a different remedy from storing it.
 */
export function checkClerkCredentials(
  config: ProjectConfig | null,
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult | null {
  const declared = ROLE_DESCRIPTORS[role].secrets.named.filter((named) => named.name.startsWith("RALPH_CLERK_"));
  if (declared.length === 0) return null;
  const triager = role === "triager";
  if (triager && (config === null || triageRules(config).jira?.mode !== "live")) return null;
  const names = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter((name) => name !== "");
  const available = names(env.RALPH_ROLE_SECRETS_AVAILABLE);
  const withheld = names(env.RALPH_ROLE_SECRETS_WITHHELD);
  const unread = names(env.RALPH_ROLE_SECRETS_UNREAD);
  const scope = secretsScope(config);
  for (const secret of declared) {
    // A hand-run preflight under the secrets manager sees the value itself;
    // proved only once its checker exists, as `buildkite-retry` reads it.
    const inEnvironment = (env[secret.name]?.trim() ?? "") !== "" && secret.check !== null;
    if (!withheld.includes(secret.name) && (available.includes(secret.name) || inEnvironment)) continue;
    // Doppler failed for a reason other than "not found" — on 2026-10-29 a
    // keyring still locked at boot. The token may well be stored, so this is a
    // wait the supervisor re-reads through, not a denial that ends the loop.
    if (unread.includes(secret.name)) {
      return {
        name: "clerk-credentials",
        outcome: { status: "unavailable", why: `${secret.name} could not be read from the secrets manager${scope}` },
      };
    }
    if (withheld.includes(secret.name)) {
      return {
        name: "clerk-credentials",
        outcome: {
          status: "denied",
          why: `${secret.name} is stored but withheld: its check refused it`,
          remedy: `run \`bun ${RALPH_HOME}/${secret.check}\` with the token exported to see why, fix the token, and restart`,
        },
      };
    }
    if (triager) {
      return {
        name: "clerk-credentials",
        outcome: {
          status: "denied",
          why: `no ${secret.name}, so the triager's gate cannot move to-person reports to Jira (\`triage.jira\` is live)`,
          remedy: `store the Jira credential as ${secret.name}${scope}, and restart`,
        },
      };
    }
    return {
      name: "clerk-credentials",
      outcome: {
        status: "denied",
        why: `no ${secret.name}, so the clerk's gate cannot read its channel or file anything`,
        remedy: `store the clerk's token as ${secret.name}${scope}, and restart`,
      },
    };
  }
  return { name: "clerk-credentials", outcome: { status: "ok", detail: declared.map((secret) => secret.name).join(", ") } };
}

/**
 * Whether a verifier's gate was handed every read credential it works through,
 * and whether the project tells it what to watch at all.
 *
 * A DENIAL, for `clerk-credentials`' reason: a verifier that cannot read Sentry
 * or see a deploy land can conclude nothing, and finding that out on the first
 * poll at 3 a.m. is the trade felipearos/ralph#560 refuses. Null for every
 * other role, so their results are unchanged.
 *
 * Availability is read off the supervisor's name lists exactly as the clerk's
 * check reads it: the tokens are `gate` secrets, unset from this process.
 */
export function checkVerifierCredentials(
  config: ProjectConfig | null,
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult | null {
  if (role !== "verifier") return null;
  const rules = config === null ? null : verifierRules(config);
  if (config === null || rules === null) {
    return {
      name: "verifier-credentials",
      outcome: {
        status: "denied",
        why: "the project has no `verifier` block, so a verifier has no production to watch",
        remedy: "add a `verifier` block to .ralph/config.json with `productionUrl`, `deploy.source` and `sentry` (`org`, `project`), and restart",
      },
    };
  }
  // A block without a usable deploy source never validates (`verifierProblems`
  // refuses a missing or unknown source and a vercel source with no project),
  // so it surfaces as the `project-config` denial, which names the key; the
  // rules this check reads always carry one.
  const source = rules.deploy.source;
  const required = [
    { name: SENTRY_TOKEN_ENV, vendor: "Sentry", cannot: "read Sentry for the errors a change brings" },
    ...(source === "vercel"
      ? [{ name: VERCEL_TOKEN_ENV, vendor: "Vercel", cannot: "see a Vercel deploy land" }]
      : []),
  ];
  const declared = ROLE_DESCRIPTORS[role].secrets.named;
  const names = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter((name) => name !== "");
  const available = names(env.RALPH_ROLE_SECRETS_AVAILABLE);
  const withheld = names(env.RALPH_ROLE_SECRETS_WITHHELD);
  const unread = names(env.RALPH_ROLE_SECRETS_UNREAD);
  const scope = secretsScope(config) || " in the supervisor's environment";
  for (const secret of required) {
    const check = declared.find((named) => named.name === secret.name)?.check ?? null;
    const inEnvironment = (env[secret.name]?.trim() ?? "") !== "" && check !== null;
    if (!withheld.includes(secret.name) && (available.includes(secret.name) || inEnvironment)) continue;
    if (unread.includes(secret.name)) {
      return {
        name: "verifier-credentials",
        outcome: { status: "unavailable", why: `${secret.name} could not be read from the secrets manager${config.secrets.runner === "none" ? "" : scope}` },
      };
    }
    if (withheld.includes(secret.name)) {
      return {
        name: "verifier-credentials",
        outcome: {
          status: "denied",
          why: `${secret.name} is stored but withheld: its check refused it`,
          remedy: `run \`bun ${RALPH_HOME}/${check}\` with the token exported to see why, fix the token, and restart`,
        },
      };
    }
    return {
      name: "verifier-credentials",
      outcome: {
        status: "denied",
        why: `no ${secret.name}, so the verifier's gate cannot ${secret.cannot}`,
        remedy: `store a read-only ${secret.vendor} token as ${secret.name}${scope}, and restart`,
      },
    };
  }
  const detail = [
    required.map((secret) => secret.name).join(", "),
    ...(source === "github-deployments" ? ["deploy source github-deployments reads through gh"] : []),
  ].join("; ");
  return { name: "verifier-credentials", outcome: { status: "ok", detail } };
}

/**
 * {@link checkVerifierCredentials}, plus a probe that gh can read the
 * project's deployments when the deploy source is github-deployments. That
 * source holds no token of its own, so "reads through gh" was a promise no one
 * checked: a gh token without deployments access would leave the gate reporting
 * "deploy source unavailable" on every poll, all night, instead of one denial
 * at startup. The repo comes from the config, not `{owner}/{repo}`: preflight's
 * cwd is not guaranteed to resolve to it.
 */
export async function checkVerifierDeploySource(
  config: ProjectConfig | null,
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
  read: (args: string[]) => Promise<Ran> = (args) => run("gh", args),
): Promise<CheckResult | null> {
  const credentials = checkVerifierCredentials(config, role, env);
  if (credentials === null || credentials.outcome.status !== "ok" || config === null) return credentials;
  const rules = verifierRules(config);
  if (rules === null || rules.deploy.source !== "github-deployments") return credentials;
  const { environment } = rules.deploy;
  const ran = await read(["api", `repos/${config.repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=1`]);
  if (ran.ok) {
    return {
      name: "verifier-credentials",
      outcome: { status: "ok", detail: `${SENTRY_TOKEN_ENV}; deploy source github-deployments reads ${config.repo} deployments (${environment}) through gh` },
    };
  }
  if (classifyFailure(ran.output, ran.timedOut) === "unavailable") {
    return { name: "verifier-credentials", outcome: { status: "unavailable", why: `GitHub could not be reached to read ${config.repo}'s deployments` } };
  }
  // gh prints the response body on stdout before its own `gh: … (HTTP 403)` line, so prefer that line.
  const lines = ran.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const first = lines.find((line) => line.startsWith("gh:")) ?? lines[0] ?? "gh printed nothing";
  return {
    name: "verifier-credentials",
    outcome: {
      status: "denied",
      why: `gh cannot read ${config.repo}'s deployments, so the verifier's gate could never see a deploy land: ${first}`,
      remedy: `give gh's token read access to deployments on ${config.repo} (classic: repo or repo_deployment; fine-grained: Deployments read), and restart`,
    },
  };
}

/**
 * The repository state the ITERATION reads. `prompt.md` works from
 * `origin/<baseBranch>` throughout and `frontier-gate.ts` fences from
 * `origin/<baseBranch>:<plan>`, so a worktree with no such ref is not a loop
 * that works from a stale base — it is one whose every base read fails.
 *
 * Freshness itself is `ralph.sh`'s guard, which can distinguish a stale
 * worktree from a mid-ticket one; this only asks that the ref exists at all.
 */
export async function checkRepositoryState(baseBranch = "main"): Promise<CheckResult> {
  const repo = await run("git", ["rev-parse", "--git-dir"]);
  if (!repo.ok) {
    return {
      name: "repository-state",
      outcome: {
        status: "denied",
        why: `${process.cwd()} is not a git worktree`,
        remedy: "run the loop from inside a worktree of the project repository",
      },
    };
  }
  const base = await run("git", ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`]);
  if (!base.ok) {
    return {
      name: "repository-state",
      outcome: {
        status: "denied",
        why: `origin/${baseBranch} is unknown here, and every base read the iteration makes goes through it`,
        remedy: `git fetch origin ${baseBranch}`,
      },
    };
  }
  return { name: "repository-state", outcome: { status: "ok" } };
}

/**
 * The files the frontier and the iteration are made of. Harness files are
 * absolute, under RALPH_HOME; project files are the ones its config names,
 * relative to the project root. A harness checkout that is merely old fails on
 * these in confusing ways — the second loop's once sat three commits behind
 * with no `frontier-gate.ts` in it at all, and died on a missing file rather
 * than on staleness.
 */
export const HARNESS_FILES = [
  // Every role's prompt template, the coder's `prompt.md` included: a harness
  // checkout from before a role landed would otherwise pass preflight and then
  // die on `models.ts: cannot read …/prompts/triager.md`, which is the
  // confusing missing-file death this list exists to turn into a staleness
  // report. Derived from the descriptors so a new role cannot forget.
  ...new Set(ROLES.map((role) => ROLE_DESCRIPTORS[role].prompt)),
  "models.json",
  "frontier-gate.ts",
  "frontier/next.ts",
  "frontier/next-tasks.ts",
  "frontier/github-rate-limit.ts",
  "frontier/branch-claims.ts",
  "jav.ts",
  "block-reason.ts",
];

export function frontierFiles(config: ProjectConfig | null, home: string = RALPH_HOME): string[] {
  return [
    ...HARNESS_FILES.map((file) => join(home, file)),
    ...(config === null ? [] : [config.promptFragment, config.coderFragment, config.plan]),
  ];
}

export async function checkFrontierPrerequisites(
  config: ProjectConfig | null = null,
  home: string = RALPH_HOME,
): Promise<CheckResult> {
  const missing: string[] = [];
  for (const file of frontierFiles(config, home)) {
    try {
      await access(file, constants.R_OK);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length === 0) {
    return { name: "frontier-prerequisites", outcome: { status: "ok" } };
  }
  const harnessMissing = missing.some((file) => isAbsolute(file));
  return {
    name: "frontier-prerequisites",
    outcome: {
      status: "denied",
      why: `unreadable here: ${missing.join(", ")} — ${harnessMissing ? "an old or incomplete harness checkout" : "the project config names files this checkout does not have"}`,
      remedy: harnessMissing
        ? `git -C ${home} pull --ff-only`
        : "git fetch origin && git checkout --detach origin/<baseBranch>, or fix .ralph/config.json",
    },
  };
}

/**
 * The project's `.ralph/config.json`, strictly validated. Everything below
 * that depends on the project — its secrets scope, its base branch, its files —
 * reads it, so an invalid one is denied here rather than half-applied there.
 */
export function checkProjectConfig(root: string = process.cwd()): { result: CheckResult; config: ProjectConfig | null } {
  try {
    const config = loadProjectConfig(root);
    // A setting that turns a feature off is a warning, never a refusal: the loop still starts.
    const [warning] = clerkConfigWarnings(config);
    if (warning !== undefined) {
      return { result: { name: "project-config", outcome: { status: "warn", why: warning, remedy: "set 'clerk.operator' in .ralph/config.json, and restart" } }, config };
    }
    return { result: { name: "project-config", outcome: { status: "ok", detail: config.repo } }, config };
  } catch (error) {
    return {
      result: {
        name: "project-config",
        outcome: {
          status: "denied",
          why: (error as Error).message,
          remedy: "commit a valid .ralph/config.json (see the harness README and examples/.ralph/)",
        },
      },
      config: null,
    };
  }
}

/**
 * Every check this ROLE is held to, in one pass. Local answers first — they are
 * free, and a worktree with no `gh` on PATH must be told that rather than told
 * GitHub is unreachable. The two network probes run concurrently, because the
 * preflight is on the critical path of every start.
 *
 * A check the role does not list is not run: `runs` guards the call, not the
 * report. That is the difference between a triager whose Doppler result is
 * hidden and one that never asks Doppler at all — only the second can start on
 * a host holding no such credential.
 */
export async function preflight(): Promise<CheckResult[]> {
  const raw = process.env.RALPH_LOOP_NAME;
  const project = checkProjectConfig();
  const config = project.config;
  // The roster is the project's; with no valid config there is none, so the
  // identity is denied too, and the config's own denial says what to fix.
  const roster = config?.loops ?? [];
  // The identity check compares and lists names; `loop-labels` reaches Jav,
  // whose route targets are the coders, so it gets the roster with its roles.
  const rosterRoles = config?.roster ?? [];
  const loop = resolveLoopName(raw, roster);
  const role = roleFor(config, loop);
  const plan = ROLE_DESCRIPTORS[role].preflight;
  const runs = (check: PreflightCheck): boolean => plan.checks.includes(check);
  const tools = await checkTools(config, role);
  // Kept by name: a github-deployments source's gh probe replaces it once the
  // tools gate below has passed, so a missing gh is never read as a scope.
  const verifierCredentials = runs("verifier-credentials") ? checkVerifierCredentials(config, role) : null;
  const local = [
    // `MANDATORY_CHECKS` — `project-config`, `tools` and `loop-identity` — are
    // asked of every role whatever its list says. The role itself is read out of
    // that config and that name, so a run that dropped either would be deciding
    // what to check from what it had refused to look at; and `tools` guards
    // every probe after it, since a missing `gh` makes each one fail as "not
    // authenticated" rather than as itself. `roles.test.ts` fences the three
    // into every role's list, so no descriptor can claim to have dropped one.
    project.result,
    tools,
    checkLoopIdentity(raw, loop, roster),
    ...(runs("logs-writable") ? [await checkLogsWritable()] : []),
    ...(runs("repository-state") ? [await checkRepositoryState(config?.baseBranch ?? "main")] : []),
    ...(runs("frontier-prerequisites") ? [await checkFrontierPrerequisites(config)] : []),
    ...(runs("executor-tools") ? await executorToolsResult(role) : []),
    ...(runs("buildkite-logs") ? [checkBuildkiteLogs(config)].filter((result): result is CheckResult => result !== null) : []),
    ...(runs("buildkite-retry") ? [checkBuildkiteRetry(config, role)].filter((result): result is CheckResult => result !== null) : []),
    ...(runs("clerk-credentials") ? [checkClerkCredentials(config, role)].filter((result): result is CheckResult => result !== null) : []),
    ...(verifierCredentials !== null ? [verifierCredentials] : []),
    // Local and ahead of every child: the file is what their environment is.
    ...(runs("secrets-file") && config?.secrets.runner === "dotenv" ? [await checkSecretsFile(process.cwd(), config)] : []),
  ];
  // A missing CLI would make its probe fail as "denied" for the wrong reason —
  // "not authenticated" when the truth is "no gh at all". The tools check has
  // already said so, and its remedy is the useful one. Held by name rather
  // than by position, so reordering the list above cannot disarm it silently.
  if (tools.outcome.status === "denied") return applyVerdicts(local, plan);

  const remote = await Promise.all([
    ...(runs("github-credentials") ? [checkGitHubCredentials()] : []),
    ...(verifierCredentials !== null ? [checkVerifierDeploySource(config, role)] : []),
    ...(runs("loop-labels") ? [checkLoopLabels(loop, role, rosterRoles, config?.appLabels ?? null)] : []),
    ...(runs("clerk-intake-board") ? [checkClerkIntakeBoard(config, role)] : []),
    ...(runs("actions-logs") ? [checkActionsLogs(config)] : []),
    ...(runs("doppler-scope") && config?.secrets.runner === "doppler"
      ? [checkDopplerScope({ project: config.secrets.project, config: config.secrets.config })]
      : []),
  ]);
  const probed = remote.find((result) => result?.name === "verifier-credentials") ?? null;
  return applyVerdicts(
    [...(probed === null ? local : local.filter((result) => result !== verifierCredentials)), ...remote.filter((result): result is CheckResult => result !== null)],
    plan,
  );
}

/**
 * Every label this loop needs, one per line, for the Add-agent flow to create
 * (`adding-an-agent.md` §6). The triple plus whatever its role declares, so an
 * operator adding a triager does not learn the vocabulary from a refusal.
 *
 * Its own mode rather than a field of `--json`, because it is read by a shell
 * loop rather than by a program, and because it must answer without running a
 * single probe: the labels are what you create BEFORE the preflight can pass.
 *
 * `ask` names a loop that is not on the roster yet, which is the Add-agent
 * case: its roster PR is still open, so resolving the name against the roster
 * would refuse the one question the flow needs answered. The role then has to
 * be given, since there is no entry to read it from.
 */
export function labelsFor(ask: { loop: string; role: Role } | null = null): { labels: string[] } | { why: string } {
  const { config } = checkProjectConfig();
  if (config === null) return { why: "the project's .ralph/config.json could not be read" };
  const keyed = config.tracker.kind !== "github";
  if (ask !== null) return requiredLabelsFor(ask.loop, ask.role, config.roster, { keyed, apps: config.appLabels ?? null });
  const loop = resolveLoopName(process.env.RALPH_LOOP_NAME, config.loops);
  if (loop === null) {
    return {
      why: `RALPH_LOOP_NAME must name one of this project's loops (${config.loops.join(", ")})`,
    };
  }
  return requiredLabelsFor(loop, roleFor(config, loop), config.roster, { keyed, apps: config.appLabels ?? null });
}

const EXIT: Record<Verdict, number> = { ready: 0, denied: 1, unavailable: 2 };

/**
 * `--labels`'s optional `--loop`/`--role` pair, or a usage message. Both or
 * neither: a loop without a role has no entry to read the role from, and a
 * role without a loop has nothing to name the triple after.
 */
function labelsAsk(argv: string[]): { loop: string; role: Role } | null | string {
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    return index === -1 ? null : (argv[index + 1] ?? "");
  };
  const loop = valueOf("--loop");
  const role = valueOf("--role");
  if (loop === null && role === null) return null;
  if (loop === null || role === null) return "--labels takes --loop and --role together, or neither";
  if (loop === "" || loop.startsWith("--")) return "--loop needs the agent's name";
  if (!isRole(role)) return `--role must be one of ${ROLES.join(", ")}; got '${role}'`;
  return { loop, role };
}

/**
 * `--doppler-failure`: classify a failed Doppler command's output (stdin) the
 * way the startup scope probe does, for `ralph.sh`'s per-turn scope probe
 * (#759). One rule in one place: a bash pattern of its own would drift from
 * this one, and the 2026-10-21 boot showed what a wrong "denied" costs. Never
 * fails: anything that goes wrong answers `unavailable`, which is a wait.
 */
async function classifyDopplerFailure(): Promise<void> {
  let answer: "denied" | "unavailable" = "unavailable";
  try {
    answer = dopplerFailure(await Bun.stdin.text());
  } catch {
    // An unreadable stdin is no evidence of a denial.
  }
  console.log(answer);
}

async function main(): Promise<void> {
  // Before the chdir: the classifier reads only its stdin, and must answer even
  // where no project root can be found.
  if (process.argv.slice(2).includes("--doppler-failure")) {
    await classifyDopplerFailure();
    return;
  }
  // Anchored like `ralph.sh`, `status.sh` and the gate, so every relative path
  // above resolves from the worktree root wherever this was invoked from.
  process.chdir(projectRoot());

  const argv = process.argv.slice(2);
  if (argv.includes("--labels")) {
    const ask = labelsAsk(argv);
    if (typeof ask === "string") {
      console.error(`preflight: ${ask}`);
      process.exitCode = 2;
      return;
    }
    const answer = labelsFor(ask);
    if ("why" in answer) {
      console.error(`preflight: ${answer.why}`);
      process.exitCode = 1;
      return;
    }
    for (const label of answer.labels) console.log(label);
    return;
  }

  const results = await preflight();
  const verdict = summarize(results);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ verdict, checks: results }, null, 2));
  } else {
    for (const line of report(results, verdict)) console.log(line);
  }
  const jsonPath = process.env.RALPH_PREFLIGHT_JSON;
  if (jsonPath) {
    try {
      await writeFile(jsonPath, JSON.stringify({ verdict, checks: results }));
    } catch {
      // The file is a convenience for the supervisor, which degrades to its
      // old message when it is missing; it must never change the verdict.
    }
  }
  process.exitCode = EXIT[verdict];
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 3;
  }
}
