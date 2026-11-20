#!/usr/bin/env bun
/**
 * `triage-apply.ts` — the only place a triager's writes are made.
 *
 * The triager model reads a unit, decides what to do, and writes the decision
 * to `.ralph/logs/triage-plan-<unit>.json`. It never runs `gh issue edit`,
 * `create` or `close` itself. This tool takes the plan and:
 *
 *   1. VALIDATES it against rules the model cannot bend (`triage/validate.ts`)
 *   2. SIMULATES the frontier the plan would leave (`triage/simulate.ts`)
 *   3. ORDERS the writes so no intermediate state is offerable (`triage/order.ts`)
 *   4. APPLIES them one at a time, paced and idempotent (`triage/apply.ts`)
 *   5. VERIFIES the real frontier still reads, restoring the bodies if not
 *   6. RELEASES the claim and leaves the marker that records the decision
 *
 * A refusal at 1 or 2 makes ZERO GitHub writes. That is the tool's whole
 * contract: a plan is either wholly safe or wholly refused, because a
 * half-applied split is a backlog nobody — human or loop — can reason about.
 *
 *   bun triage-apply.ts --plan .ralph/logs/triage-plan-142.json [--dry-run] [--json]
 *
 * Exit codes: 0 applied (or a clean dry run) · 1 a write failed · 3 refused,
 * nothing written · 6 applied then reverted · 64 usage · 69 the tracker is not
 * connected · 75 rate limited.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { RATE_LIMITED_EXIT, classifyRateLimit } from "./frontier/github-rate-limit";
import {
  buildTickets,
  readFrontierInputs,
  type RawIssue,
  type Ticket,
} from "./frontier/next-tasks";
import { parsePlanFences, planLocation } from "./frontier-gate";
import type { JavRoster } from "./jav";
import { harnessPath, projectRoot } from "./paths";
import { loadProjectConfig, triageRules, type ProjectConfig } from "./project-config";
import { currentProjectId } from "./project-id";
import { roleLabels, javDifficultyLabels } from "./preflight";
import { loopsWithRole } from "./roster";
import { formatTriageMarker, triageBodyHash } from "./triage-marker";
import type { IssueComment } from "./block-reason";
import { createTracker, TrackerUnavailableError, type Tracker } from "./tracker/index";
import { applySteps, restoreBodies, type ApplyIo, type IssueState } from "./triage/apply";
import { carriesOpMarker, opMarker } from "./triage/body";
import { applyKeyedPlan, type KeyedApplyResult } from "./triage/keyed";
import { ledgerPath } from "./triage/ledger";
import { orderOps } from "./triage/order";
import { parsePlan, type TriagePlan } from "./triage/plan";
import { simulate } from "./triage/simulate";
import { triageLimits, validatePlan, type DuplicateState } from "./triage/validate";

export const EXIT = {
  ok: 0,
  failed: 1,
  refused: 3,
  reverted: 6,
  usage: 64,
  unavailable: 69,
  rateLimited: RATE_LIMITED_EXIT,
} as const;

const USAGE = `usage: bun triage-apply.ts --plan <file> [--dry-run] [--json]

  --plan <file>  the plan to apply, as triage-plan-<unit>.json
  --dry-run      validate and simulate only; makes no tracker writes
  --json         print the report as JSON`;

export interface Flags {
  plan: string;
  dryRun: boolean;
  json: boolean;
}

export function parseFlags(argv: string[]): { flags: Flags } | { problem: string } {
  let plan: string | null = null;
  let dryRun = false;
  let json = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]!;
    if (arg === "--plan") {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith("--")) return { problem: "--plan needs a file" };
      plan = value;
      at += 1;
    } else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else return { problem: `unknown argument ${arg}` };
  }
  if (plan === null) return { problem: "--plan is required" };
  return { flags: { plan, dryRun, json } };
}

/** How long between writes. `RALPH_TRIAGE_WRITE_SPACING_MS`, default 1500. */
export function writeSpacingMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.RALPH_TRIAGE_WRITE_SPACING_MS?.trim();
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 1500;
}

interface Report {
  unit: number;
  outcome: "applied" | "dry-run" | "refused" | "rate-limited" | "reverted" | "failed";
  writes: number;
  skipped: number;
  refusals: string[];
  created: Record<string, number>;
  problem: string | null;
}

const run = (command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error === undefined ? "" : String(result.error)),
  };
};

const io: ApplyIo = {
  gh: async (args) => run("gh", args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date().toISOString(),
};

/** The rule file's text at `origin/<baseBranch>`, never the working tree. */
const ruleReader =
  (baseBranch: string) =>
  (path: string): string | null => {
    const shown = run("git", ["show", `origin/${baseBranch}:${path}`]);
    return shown.ok ? shown.stdout : null;
  };

const duplicateReader = (issue: number): DuplicateState => {
  const read = run("gh", ["issue", "view", String(issue), "--json", "state,stateReason"]);
  if (!read.ok) return { state: "unknown" };
  try {
    const parsed = JSON.parse(read.stdout) as { state?: string; stateReason?: string | null };
    if (parsed.state === "OPEN") return { state: "open" };
    // GitHub reports a plain close as `COMPLETED`, and older closes as null,
    // which `gh` also shows for "closed before state reasons existed". Both are
    // a real close; only NOT_PLANNED says nothing was done about it.
    return { state: "closed", completed: parsed.stateReason !== "NOT_PLANNED" };
  } catch {
    return { state: "unknown" };
  }
};

/**
 * One issue's comments in full, past the census's 20-comment tail.
 *
 * The rescue cap and window are counted off `op=unblock` markers that may be
 * months old, and a count read off a truncated tail reads as zero — which fails
 * OPEN into a third rescue. One extra read per unblock op, on the pattern
 * `readStuckReasons` already uses for block records. Null on any fault, which
 * `validate.ts` turns into a refusal.
 */
const commentReader = (issue: number): IssueComment[] | null => {
  const read = run("gh", ["issue", "view", String(issue), "--json", "comments"]);
  if (!read.ok) return null;
  try {
    return (JSON.parse(read.stdout) as { comments?: IssueComment[] }).comments ?? [];
  } catch {
    return null;
  }
};

const existingLabels = (): Set<string> => {
  const read = run("gh", ["label", "list", "--limit", "200", "--json", "name"]);
  if (!read.ok) return new Set();
  try {
    return new Set((JSON.parse(read.stdout) as { name: string }[]).map((label) => label.name));
  } catch {
    return new Set();
  }
};

/**
 * Every label the triager role may apply, plus this loop's own claim triple.
 *
 * `roster` reaches Jav, whose route targets are the routable loops, so it must
 * carry the roles: handing it bare names would read every loop as a coder here
 * while the frontier and preflight read the same file with roles, and the
 * triager would go on applying a label no coder takes.
 */
export function allowedLabelsFor(loop: string, roster: JavRoster): Set<string> {
  const jav = javDifficultyLabels(roster);
  const labels = roleLabels("triager", "why" in jav ? [] : jav.labels);
  return new Set([...labels, `${loop}-wip`, `${loop}-blocked`, `${loop}-done`]);
}

/** The project's difficulty labels, or none when the Jav block will not read. */
const javLabelsOf = (roster: JavRoster): string[] => {
  const jav = javDifficultyLabels(roster);
  return "why" in jav ? [] : jav.labels;
};

const stateFromCensus = (raw: readonly RawIssue[]): Map<number, IssueState> =>
  new Map(
    raw.map((issue) => [
      issue.number,
      { body: issue.body, labels: new Set(issue.labels.map((label) => label.name)) },
    ]),
  );

export type FrontierVerdict = "reads" | "unreadable" | "inconclusive";

/**
 * What a `next.ts --dry-run --json` run says about the backlog the apply left.
 *
 * Three answers, not two. A non-zero exit is NOT by itself "the frontier cannot
 * read this": the census is a GitHub read, and a throttled or transiently
 * failing one says nothing about the plan. Reverting on that would undo a
 * correct apply because GitHub was busy — so only a run that got far enough to
 * fail on the BACKLOG counts as `unreadable`.
 */
export function frontierVerdict(result: { ok: boolean; stdout: string; stderr: string }): FrontierVerdict {
  if (result.ok) return "reads";
  const message = `${result.stderr}\n${result.stdout}`;
  if (classifyRateLimit(message) !== null) return "inconclusive";
  // Could not ask the question at all, as opposed to answering it badly.
  if (/could not (read|resolve|reach)|not a git repository|command not found|ENOENT/i.test(message)) {
    return "inconclusive";
  }
  return "unreadable";
}

const frontierReads = (): FrontierVerdict =>
  frontierVerdict(run("bun", [harnessPath("frontier/next.ts"), "--dry-run", "--json"]));

async function main(argv: string[]): Promise<number> {
  const parsedFlags = parseFlags(argv);
  if ("problem" in parsedFlags) {
    console.error(`triage-apply: ${parsedFlags.problem}\n${USAGE}`);
    return EXIT.usage;
  }
  const { flags } = parsedFlags;

  let text: string;
  try {
    text = readFileSync(flags.plan, "utf8");
  } catch (error) {
    console.error(`triage-apply: could not read ${flags.plan}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }

  const parsed = parsePlan(text, flags.plan);
  if ("problems" in parsed) return refuse(parsed.problems, 0, flags);
  const plan = parsed.plan;

  const config = loadProjectConfig();
  if (config.tracker.kind !== "github") return applyKeyed(plan, config, config.tracker.scopeLabel, flags);
  // Names for the plan's own checks, which compare and list them; the roster
  // with its roles for Jav, whose route targets are the routable loops.
  const roster = config.roster.map((entry) => entry.name);
  const { baseBranch } = planLocation();
  const planText = run("git", ["show", `origin/${baseBranch}:${config.plan}`]);
  const fences = parsePlanFences(planText.ok ? planText.stdout : "");

  const census = await readFrontierInputs();
  const tickets: Map<number, Ticket> = buildTickets(
    census.raw,
    census.natives,
    new Set(census.closed.map((issue) => issue.number)),
    census.openPrs,
  );

  const problems = validatePlan({
    plan,
    tickets,
    owner: config.owner,
    roster,
    loop: process.env.RALPH_LOOP_NAME?.trim() || null,
    existingLabels: existingLabels(),
    allowedLabels: allowedLabelsFor(plan.loop, config.roster),
    // An unreadable Jav block yields no difficulty labels, which costs a
    // rescue only the re-ROUTE route: a re-spec still earns an unblock, and a
    // plan that thinks it re-routed is refused for changing nothing. The
    // alternative — failing the whole apply on a Jav fault — would stop every
    // other kind of plan over a knob a rescue may not even use.
    coders: loopsWithRole("coder", config.roster),
    javLabels: javLabelsOf(config.roster),
    fullComments: commentReader,
    fences,
    limits: triageLimits(),
    readRule: ruleReader(baseBranch),
    duplicateTarget: duplicateReader,
  });
  if (problems.length > 0) return refuse(problems, plan.unit, flags);

  const simulation = simulate(census, plan);
  if (!simulation.ok) return refuse(simulation.refusals, plan.unit, flags);

  const steps = orderOps(plan);
  if (flags.dryRun) {
    return report(
      { unit: plan.unit, outcome: "dry-run", writes: 0, skipped: 0, refusals: [], created: {}, problem: null },
      flags,
      `triage-apply: #${plan.unit} would make ${steps.length} writes`,
    );
  }

  const applied = await applySteps({
    plan,
    steps,
    io,
    ledger: ledgerPath(plan.unit),
    spacingMs: writeSpacingMs(),
    state: stateFromCensus(census.raw),
  });
  const created = Object.fromEntries(applied.created);

  if (applied.outcome !== "applied") {
    return report(
      {
        unit: plan.unit,
        outcome: applied.outcome,
        writes: applied.performed,
        skipped: applied.skipped,
        refusals: [],
        created,
        problem: applied.problem,
      },
      flags,
      `triage-apply: ${applied.problem ?? applied.outcome}`,
      applied.outcome === "rate-limited" ? EXIT.rateLimited : EXIT.failed,
    );
  }

  // The frontier is the acceptance test for the whole apply: the simulation
  // predicted it from the census this run read, and anything that changed since
  // could still make it throw. A backlog no loop can select from is the one
  // outcome worth undoing writes for.
  const verdict = frontierReads();
  if (verdict === "unreadable") {
    const restored = await restoreBodies(applied.beforeImages, { io, spacingMs: writeSpacingMs() });
    return report(
      {
        unit: plan.unit,
        outcome: "reverted",
        writes: applied.performed,
        skipped: applied.skipped,
        refusals: [],
        created,
        problem: `the frontier could not read the result; restored ${restored.restored.length} bodies, ${restored.failed.length} failed`,
      },
      flags,
      "triage-apply: reverted — the frontier could not read the result",
      EXIT.reverted,
    );
  }

  const releaseProblems = await release(plan, tickets.get(plan.unit) ?? null);
  if (verdict === "inconclusive") {
    // Said out loud rather than silently treated as green: the writes stand,
    // but nothing has confirmed the backlog still reads.
    releaseProblems.unshift("the frontier check could not run; the result is unverified");
  }

  return report(
    {
      unit: plan.unit,
      outcome: "applied",
      writes: applied.performed,
      skipped: applied.skipped,
      refusals: [],
      created,
      problem: releaseProblems.length === 0 ? null : releaseProblems.join("; "),
    },
    flags,
    `triage-apply: #${plan.unit} applied — ${applied.performed} writes, ${applied.skipped} already done`,
  );
}

/**
 * A Linear or Jira project's plan: the Slack intake, through the tracker seam.
 *
 * Dispatched before the GitHub census is read at all — a keyed project's
 * tickets are not GitHub issues, and `triage/keyed.ts` reads the one issue the
 * plan names instead.
 */
async function applyKeyed(
  plan: TriagePlan,
  config: ProjectConfig,
  scopeLabel: string | null,
  flags: Flags,
): Promise<number> {
  let tracker: Tracker;
  let result: KeyedApplyResult;
  try {
    tracker = createTracker(config, { projectId: currentProjectId(projectRoot()) });
    result = await applyKeyedPlan(plan, {
      tracker,
      rules: { scopeLabel, apps: config.appLabels ?? null, loop: process.env.RALPH_LOOP_NAME?.trim() || null, autoReady: triageRules(config).autoReady },
      dryRun: flags.dryRun,
      releaseLease: (unit) => void run("bun", [harnessPath("claim-lease.ts"), "release", String(unit)]),
      sleep: io.sleep,
      spacingMs: writeSpacingMs(),
    });
  } catch (error) {
    if (!(error instanceof TrackerUnavailableError)) throw error;
    return report(
      { unit: plan.unit, outcome: "failed", writes: 0, skipped: 0, refusals: [], created: {}, problem: error.message },
      flags,
      `triage-apply: the tracker is not connected: ${error.message}`,
      EXIT.unavailable,
    );
  }

  if (result.outcome === "refused") return refuse(result.refusals, plan.unit, flags);
  const body: Report = { unit: plan.unit, ...result, created: {} };
  if (result.outcome === "dry-run") {
    return report(body, flags, `triage-apply: ${tracker.ref(plan.unit)} would make ${result.writes} writes`);
  }
  if (result.outcome !== "applied") {
    return report(
      body,
      flags,
      `triage-apply: ${result.problem ?? result.outcome}`,
      result.outcome === "rate-limited" ? EXIT.rateLimited : EXIT.failed,
    );
  }
  const summary = `triage-apply: ${tracker.ref(plan.unit)} applied — ${result.writes} writes, ${result.skipped} already done`;
  return report(body, flags, result.problem === null ? summary : `${summary}\n  - ${result.problem}`);
}

/**
 * The last three writes: the claim label comes off, the lease is released, and
 * the marker comment records the decision.
 *
 * The marker goes LAST and carries the hash of the body as this apply left it.
 * Hashing the body the triager read would mark a decision as current against
 * text that no longer exists, and `hasCurrentTriage` would then hide the issue
 * from the intake bucket for a body nobody has triaged.
 */
export async function release(
  plan: TriagePlan,
  unit: { labels: ReadonlySet<string> } | null,
  deps: ApplyIo = io,
  spacing: number = writeSpacingMs(),
): Promise<string[]> {
  const problems: string[] = [];
  const wip = `${plan.loop}-wip`;
  if (unit !== null && unit.labels.has(wip)) {
    const removed = await deps.gh(["issue", "edit", String(plan.unit), "--remove-label", wip]);
    // Reported rather than swallowed: a `-wip` still on the issue is a claim
    // nobody holds, and the frontier hides the ticket from every loop.
    if (!removed.ok) problems.push(`could not remove ${wip} from #${plan.unit}: ${removed.stderr.trim()}`);
    await deps.sleep(spacing);
  }
  // Best effort, and deliberately not fatal: the lease has a TTL, so a failed
  // release costs the next claimant a wait, where a failed RELEASE that aborted
  // the apply would leave the `-wip` off and the marker unwritten. Not routed
  // through `deps`, because it is not a GitHub write.
  run("bun", [harnessPath("claim-lease.ts"), "release", String(plan.unit)]);

  const body = await deps.gh(["issue", "view", String(plan.unit), "--json", "body", "--jq", ".body"]);
  const labels = await deps.gh(["issue", "view", String(plan.unit), "--json", "labels", "--jq", ".labels[].name"]);
  const opId = `release-${plan.attempt}`;
  // The marker is a WRITE like any other, and a rerun of an applied plan
  // reaches this line with nothing else to do. Without the lookup every rerun
  // would add another marker comment while reporting `writes: 0`.
  const posted = await deps.gh(["issue", "view", String(plan.unit), "--json", "comments", "--jq", ".comments[].body"]);
  if (posted.ok && carriesOpMarker(posted.stdout, opId)) return problems;

  const marker = formatTriageMarker(
    { attempt: plan.attempt, outcome: plan.outcome, body: triageBodyHash(body.ok ? body.stdout : "") },
    {
      loop: plan.loop,
      unit: plan.unit,
      op: opId,
      labels: labels.ok ? labels.stdout.split("\n").filter((name) => name !== "") : [],
    },
  );
  await deps.sleep(spacing);
  const commented = await deps.gh([
    "issue",
    "comment",
    String(plan.unit),
    "--body",
    `${marker}\n${opMarker(opId)}`,
  ]);
  if (!commented.ok) problems.push(`could not leave the triage marker on #${plan.unit}: ${commented.stderr.trim()}`);
  return problems;
}

function refuse(refusals: string[], unit: number, flags: Flags): number {
  return report(
    { unit, outcome: "refused", writes: 0, skipped: 0, refusals, created: {}, problem: null },
    flags,
    ["triage-apply: refused, nothing written", ...refusals.map((line) => `  - ${line}`)].join("\n"),
    EXIT.refused,
  );
}

function report(body: Report, flags: Flags, human: string, code: number = EXIT.ok): number {
  if (flags.json) console.log(JSON.stringify(body, null, 2));
  else if (code === EXIT.ok) console.log(human);
  else console.error(human);
  return code;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`triage-apply: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT.failed;
    });
}

export { main };
