#!/usr/bin/env bun
/**
 * The session's end of a verifier check-in (felipearos/ralph#565, spec #560):
 * read the evidence the gate stored on the check-in it handed over, and
 * decide and record the verdict.
 *
 * The gate gathers because the Sentry token is the gate's alone; the session
 * never holds it, so everything it judges by is what the gate wrote on the
 * check-in. The decision is `verdict.ts#decideVerdict`, unchanged: this CLI
 * only builds its input from the store and the project's rules. The verdict
 * runs in the mode the watch was stamped with when it opened.
 *
 *   bun verifier/checkin.ts show   [<case>] [--json]
 *   bun verifier/checkin.ts decide [<case>] [--acceptance <file>] [--json]
 *
 * `<case>` defaults to `$RALPH_INTAKE_CASE`, the line the gate answered with.
 *
 * It writes ONLY the watch store: the decision, and the check-in's lease
 * dropped in the same critical section, since the supervisor's heartbeat
 * would otherwise renew it for the rest of the run. No tracker and no `gh`:
 * report mode's tracker writes (#567) are the gate's, which announces and
 * settles every non-observe watch from the store on its next poll, so this
 * module does not import the tracker at all.
 *
 * The acceptance check runs once per watch (#566): the session runs it at the
 * first check-in it can and passes `--acceptance`, which is stored on that
 * check-in with its decision; later check-ins are judged with the stored
 * results and refuse a second `--acceptance`. A watch cannot end `verified`
 * without one that ran: `show` says when it is due.
 *
 * `decide` is safe to run twice: a check-in already decided prints the
 * decision it has and changes nothing, so a resumed session cannot decide it
 * again.
 *
 * Exit: 0 shown or decided, 1 the store could not be written, 2 bad usage
 * or no verifier rules, 3 nothing to decide (no such watch or check-in, no
 * evidence handed over, or the verifier disabled in config), 4 a bad
 * acceptance file or a second acceptance check.
 */
import { readFileSync } from "node:fs";

import { projectRoot } from "../paths";
import { freshestConfig } from "../live-rules";
import { verifierRules, type VerifierRules } from "../project-config";
import { parseCase } from "./gate";
import { decideVerdict, type AcceptanceResult, type AcceptanceResultKind, type VerdictInput } from "./verdict";
import {
  checkInKey,
  moreCheckInsAfter,
  readStore,
  recordDecision,
  recordedAcceptance,
  storePathFromGit,
  withStore,
  type AcceptanceRecord,
  type CheckIn,
  type CheckInDecision,
  type CheckInResult,
  type Watch,
} from "./watches";

const PREFIX = "verifier-checkin";

export const USAGE_EXIT = 2;
export const NOTHING_EXIT = 3;
/**
 * The session's own acceptance file is wrong — unreadable, malformed, or a
 * second check: its own to fix and run `decide` again. Not 2, which the prompt
 * reads as a broken harness and ends the loop on.
 */
export const ACCEPTANCE_EXIT = 4;

const USAGE = [
  "usage: bun verifier/checkin.ts show   [<case>] [--json]",
  "       bun verifier/checkin.ts decide [<case>] [--acceptance <file>] [--json]",
  "  <case> (default $RALPH_INTAKE_CASE): \"verifier check-in +<hours>h of PR #<n> (<ticket>), deploy <id>\"",
].join("\n");

export interface CheckinDeps {
  storePath: string;
  /** The project's verifier rules; null when its config has no verifier block. */
  rules: VerifierRules | null;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

type Verb = "show" | "decide";

interface Args {
  verb: Verb;
  caseText: string | null;
  acceptance: string | null;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args | null {
  const [verb, ...rest] = argv;
  if (verb !== "show" && verb !== "decide") return null;
  let caseText: string | null = null;
  let acceptance: string | null = null;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--acceptance" && verb === "decide" && rest[index + 1] !== undefined) {
      acceptance = rest[index + 1] as string;
      index += 1;
    } else if (!arg.startsWith("--") && caseText === null) {
      caseText = arg;
    } else {
      return null;
    }
  }
  return { verb, caseText, acceptance, json };
}

const ok = (stdout: string): Ran => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
const fail = (code: number, stderr: string): Ran => ({ code, stdout: "", stderr: `${stderr}\n` });

const ACCEPTANCE_KINDS: readonly AcceptanceResultKind[] = ["passed", "failed", "hard-break", "not-verifiable"];

/**
 * The acceptance check in `text` — an array of results, or
 * `{"inconclusive": "<reason>"}` when the session could not run it — or what
 * is wrong with it: a malformed file must not read as "nothing failed".
 */
export function parseAcceptance(text: string): AcceptanceRecord | { why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { why: `not JSON: ${(error as Error).message}` };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { inconclusive } = value as Record<string, unknown>;
    if (typeof inconclusive !== "string" || inconclusive.trim() === "") {
      return { why: "an object must be {\"inconclusive\": \"<reason>\"} with a non-empty reason" };
    }
    return { inconclusive };
  }
  if (!Array.isArray(value)) return { why: "not a JSON array of acceptance results" };
  const results: AcceptanceResult[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { why: `entry ${index} is not an object` };
    const { criterion, result, detail, evidence } = entry as Record<string, unknown>;
    if (typeof criterion !== "string" || criterion.trim() === "") return { why: `entry ${index} has no 'criterion' string` };
    if (typeof result !== "string" || !ACCEPTANCE_KINDS.includes(result as AcceptanceResultKind)) {
      return { why: `entry ${index}'s 'result' is ${JSON.stringify(result)}, expected one of ${ACCEPTANCE_KINDS.join(", ")}` };
    }
    if (detail !== undefined && typeof detail !== "string") return { why: `entry ${index}'s 'detail' is not a string` };
    if (evidence !== undefined && typeof evidence !== "string") return { why: `entry ${index}'s 'evidence' is not a string` };
    // A result the session saw needs what it saw; only "not-verifiable" may have none.
    if (result !== "not-verifiable" && (typeof evidence !== "string" || evidence.trim() === "")) {
      return { why: `entry ${index} is '${result}' with no 'evidence' (a screenshot path or a response excerpt)` };
    }
    results.push({
      criterion,
      result: result as AcceptanceResultKind,
      ...(detail !== undefined ? { detail } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }
  return { results };
}

/** The one line a decision is reported as, whether decided now or found decided. */
export function decisionLine(watch: Watch, offsetHours: number, decision: CheckInDecision): string {
  // The session performs nothing itself: the gate writes a decision to the
  // tracker on its next poll, but only one that ends the watch.
  const acted = !decision.act
    ? "observe: nothing performed"
    : watch.verdict !== null
      ? "the gate writes it to the tracker on its next poll"
      : `${watch.mode}: more check-ins due, nothing written yet`;
  const would = decision.wouldHaveBeen !== undefined ? `, would have been ${decision.wouldHaveBeen}` : "";
  const ended = watch.verdict !== null ? `; watch ended ${watch.verdict.verdict}` : "";
  return `${PREFIX}: PR #${watch.pr} +${offsetHours}h → ${decision.verdict} (${acted}${would}) — ${decision.reason}${ended}`;
}

const list = (items: string[]): string => (items.length === 0 ? "none" : items.join(", "));

/** Is the acceptance check still to run, at this check-in? Only an undecided one can still take it. */
const acceptanceDue = (watch: Watch, result: CheckInResult): boolean =>
  result.decision === null && recordedAcceptance(watch) === null;

function acceptanceLines(watch: Watch, result: CheckInResult): string[] {
  const recorded = recordedAcceptance(watch);
  if (recorded === null) {
    return [acceptanceDue(watch, result)
      ? "acceptance: due at this check-in — run it and pass the results with --acceptance <file>"
      : "acceptance: not run"];
  }
  if ("inconclusive" in recorded) return [`acceptance: inconclusive at +${recorded.offsetHours}h — ${recorded.inconclusive}`];
  const counts = ACCEPTANCE_KINDS
    .map((kind) => [kind, recorded.results.filter((r) => r.result === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return [
    `acceptance: recorded at +${recorded.offsetHours}h — ${counts.length === 0 ? "no criteria" : counts.join(", ")}`,
    ...recorded.results.map((r) => `  - ${r.result}: ${r.criterion}${r.detail ? ` — ${r.detail}` : ""}${r.evidence ? ` (evidence: ${r.evidence})` : ""}`),
  ];
}

function showText(watch: Watch, checkIn: CheckIn, result: CheckInResult): string {
  const { evidence } = result;
  const more = moreCheckInsAfter(watch, checkIn.offsetHours);
  const lines = [
    `PR #${watch.pr} (${watch.ticketRef}), deploy ${watch.deployId} at ${watch.deployedAt}`,
    `mode ${watch.mode}, round ${watch.round}, check-in +${checkIn.offsetHours}h (${more ? "more check-ins follow" : "the last check-in"})`,
    `evidence gathered at ${evidence.gatheredAt}`,
  ];
  const { health, traffic } = evidence;
  if (!health.reachable) {
    lines.push(`health: Sentry unreachable${health.why ? ` (${health.why})` : ""}`);
  } else {
    lines.push(`health: Sentry reachable, ${health.issues.length} issue${health.issues.length === 1 ? "" : "s"} seen since the deploy`);
    for (const issue of health.issues) {
      lines.push(`  - ${issue.id} "${issue.title}"${issue.link ? ` ${issue.link}` : ""}`);
      lines.push(`    first seen ${issue.firstSeen}; rate ${issue.preDeployRate} before, ${issue.postDeployRate} after; ${issue.events} events, ${issue.distinctUsers} users`);
      lines.push(`    frame files: ${list(issue.frameFiles)}; routes: ${list(issue.routes)}`);
    }
  }
  lines.push(traffic.reachable
    ? `traffic: reachable, ${traffic.hits} hits on the changed routes`
    : `traffic: unreachable${traffic.why ? ` (${traffic.why})` : ""}`);
  lines.push(`PR #${evidence.pr.number} files: ${list(evidence.pr.files)}`);
  lines.push(`PR #${evidence.pr.number} routes: ${list(evidence.pr.routes)}`);
  lines.push(evidence.otherPrs.length === 0
    ? "other PRs in the deploy: none"
    : `other PRs in the deploy: ${evidence.otherPrs.map((other) => `#${other.number} (${list(other.files)})`).join("; ")}`);
  lines.push(...acceptanceLines(watch, result));
  lines.push(result.decision !== null ? `decided: ${decisionLine(watch, checkIn.offsetHours, result.decision)}` : "decided: not yet");
  return lines.join("\n");
}

/**
 * The verdict's decision, with two supervisor rules on top. A check-in that
 * could not see a source the verdict needed is recorded "inconclusive" rather
 * than "pending", so the record says it was blind, not clean;
 * `recordDecision` keeps the watch open for it while later check-ins remain.
 * And a PR with no route to measure traffic on is judged on its health alone
 * — the verdict is called with the floor off, so an issue in its `lib/` file
 * is still judged — but cannot be `verified` while the floor is on: nothing
 * showed the change was exercised, so that is "inconclusive" too. Nor can a
 * watch be `verified` when its acceptance check could not run or never ran:
 * nothing showed the change does what the ticket asked.
 */
function decide(
  input: VerdictInput,
  acceptance: AcceptanceRecord | null,
  floor: { on: boolean; measurable: boolean },
  health: { reachable: boolean; why?: string },
  traffic: { reachable: boolean; why?: string },
  now: Date,
): CheckInDecision {
  const verdict = decideVerdict(input);
  const observe = input.mode === "observe";
  const inconclusive = (reason: string): CheckInDecision => ({
    decidedAt: now.toISOString(),
    verdict: "inconclusive",
    reason,
    act: !observe,
    priority: "normal",
    // Observe records the would-be outcome of every non-pending verdict, as decideVerdict does;
    // report acts on it (the gate settles the ticket), so there is nothing it only would have been.
    ...(observe ? { wouldHaveBeen: "inconclusive" as const } : {}),
  });
  const blind: string[] = [];
  if (!health.reachable) blind.push(`Sentry unreachable${health.why ? ` (${health.why})` : ""}`);
  if (floor.on && floor.measurable && !traffic.reachable) blind.push(`traffic unreachable${traffic.why ? ` (${traffic.why})` : ""}`);
  if (verdict.verdict === "pending" && blind.length > 0) {
    return inconclusive(`${blind.join(" and ")}; the watch waits for its next check-in`);
  }
  if (verdict.verdict === "verified" && floor.on && !floor.measurable) {
    return inconclusive("nothing wrong, but there is no changed route to measure traffic on, so the traffic floor could not be judged");
  }
  if (verdict.verdict === "verified") {
    if (acceptance === null) return inconclusive("nothing wrong, but the acceptance check never ran");
    if ("results" in acceptance && acceptance.results.length === 0) {
      return inconclusive("nothing wrong, but the acceptance check recorded no criterion");
    }
    if ("inconclusive" in acceptance) return inconclusive(`nothing wrong, but the acceptance check was inconclusive: ${acceptance.inconclusive}`);
  }
  return {
    decidedAt: now.toISOString(),
    verdict: verdict.verdict,
    reason: verdict.reason,
    act: verdict.act,
    priority: verdict.priority,
    ...(verdict.wouldHaveBeen !== undefined ? { wouldHaveBeen: verdict.wouldHaveBeen } : {}),
  };
}

export async function run(argv: readonly string[], deps: CheckinDeps): Promise<Ran> {
  const args = parseArgs(argv);
  if (args === null) return fail(USAGE_EXIT, USAGE);
  const text = args.caseText ?? deps.env.RALPH_INTAKE_CASE?.trim() ?? "";
  const target = text === "" ? null : parseCase(text);
  if (target === null) {
    return fail(USAGE_EXIT, `${PREFIX}: ${text === "" ? "no case given and RALPH_INTAKE_CASE is not set" : `not a verifier case: ${JSON.stringify(text)}`}\n${USAGE}`);
  }
  const { pr, offsetHours } = target;
  const key = checkInKey(pr, offsetHours);

  // Unlocked: only building the input. The write below re-checks under the lock.
  const store = readStore(deps.storePath);
  const watch = store.watches[String(pr)];
  if (watch === undefined) return fail(NOTHING_EXIT, `${PREFIX}: no verifier watch for PR #${pr}`);
  const checkIn = watch.checkIns.find((c) => c.offsetHours === offsetHours);
  if (checkIn === undefined) return fail(NOTHING_EXIT, `${PREFIX}: PR #${pr} has no +${offsetHours}h check-in`);
  const result = checkIn.result;
  if (result === null) return fail(NOTHING_EXIT, `${PREFIX}: no evidence recorded for ${key}: the gate has not handed it over`);

  if (args.verb === "show") {
    return ok(args.json ? JSON.stringify({ watch, checkIn, acceptanceDue: acceptanceDue(watch, result) }, null, 2) : showText(watch, checkIn, result));
  }

  if (result.decision !== null) {
    return ok(args.json ? JSON.stringify({ decision: result.decision, watch }, null, 2) : decisionLine(watch, offsetHours, result.decision));
  }

  // Defence in depth for the switch (#789): a decision is what the gate's
  // report pass turns into tracker writes, so a session already running when
  // the verifier was switched off records none. Exit 3, as for a hand-over
  // that did not land: the check-in stays undecided, and the gate hands it
  // over again once it is on. Read from the CLI's rules, before the
  // acceptance file, so nothing is judged that will not be recorded.
  if (deps.rules?.enabled === false) {
    return fail(NOTHING_EXIT, `${PREFIX}: nothing to decide for ${key}: the verifier is disabled in config ('verifier.enabled' is false)`);
  }

  const earlier = recordedAcceptance(watch);
  if (earlier !== null && args.acceptance !== null) {
    return fail(ACCEPTANCE_EXIT, `${PREFIX}: PR #${pr}'s acceptance check was already recorded at +${earlier.offsetHours}h; later check-ins do not repeat it`);
  }
  let fresh: AcceptanceRecord | null = null;
  if (args.acceptance !== null) {
    let raw: string;
    try {
      raw = readFileSync(args.acceptance, "utf8");
    } catch (error) {
      return fail(ACCEPTANCE_EXIT, `${PREFIX}: cannot read the acceptance file ${args.acceptance}: ${(error as Error).message}`);
    }
    const parsed = parseAcceptance(raw);
    if ("why" in parsed) return fail(ACCEPTANCE_EXIT, `${PREFIX}: the acceptance file ${args.acceptance} is invalid: ${parsed.why}`);
    fresh = parsed;
  }
  // The earlier record judges this check-in too; with none, this one's (if any) is the record.
  const acceptance = earlier ?? fresh;
  const acceptanceResults: AcceptanceResult[] = acceptance !== null && "results" in acceptance ? acceptance.results : [];

  const rules = deps.rules;
  if (rules === null) return fail(USAGE_EXIT, `${PREFIX}: the project's .ralph/config.json has no 'verifier' block`);

  const { evidence } = result;
  // With no changed route, `readTraffic` answers unreachable; that is not an
  // outage, and read as one it would keep every Sentry issue from being judged.
  const measurable = evidence.pr.routes.length > 0;
  const input: VerdictInput = {
    acceptance: acceptanceResults,
    health: { reachable: evidence.health.reachable, issues: evidence.health.issues },
    traffic: { reachable: evidence.traffic.reachable, hits: evidence.traffic.hits },
    deployedAt: watch.deployedAt,
    pr: evidence.pr,
    otherPrs: evidence.otherPrs,
    thresholds: { rateFactor: rules.revert.rateFactor, minEvents: rules.revert.minEvents, minDistinctUsers: rules.revert.minUsers },
    trafficFloor: rules.trafficFloor && measurable,
    moreCheckInsDue: moreCheckInsAfter(watch, offsetHours),
    round: watch.round,
    // The watch's stamped mode, so a later config change does not rewrite
    // what it may do: an act watch's revert stays a revert, which the gate's
    // report pass carries out (#568).
    mode: watch.mode,
  };
  const decision = decide(input, acceptance, { on: rules.trafficFloor, measurable }, evidence.health, evidence.traffic, deps.now());

  let recorded: { decision: CheckInDecision; watch: Watch };
  try {
    recorded = await withStore(deps.storePath, (s) => {
      // A racing session decided it between the read and the lock: its decision stands.
      const current = s.watches[String(pr)]?.checkIns.find((c) => c.offsetHours === offsetHours)?.result?.decision;
      if (current != null) {
        // Done either way: a lease left behind would be renewed by the heartbeat for the rest of the run.
        delete s.leases[key];
        return { decision: current, watch: s.watches[String(pr)] as Watch };
      }
      const updated = recordDecision(s, pr, offsetHours, decision, fresh ?? undefined);
      delete s.leases[key];
      return { decision, watch: updated };
    });
  } catch (error) {
    return fail(1, `${PREFIX}: could not record the decision on ${key}: ${(error as Error).message}`);
  }
  return ok(args.json ? JSON.stringify(recorded, null, 2) : decisionLine(recorded.watch, offsetHours, recorded.decision));
}

async function main(): Promise<number> {
  const root = projectRoot();
  let rules: VerifierRules | null;
  try {
    // What the gate that handed this check-in over last read from origin (#788).
    rules = verifierRules(freshestConfig(root, "verifier").config);
  } catch (error) {
    console.error(`${PREFIX}: ${(error as Error).message}`);
    return USAGE_EXIT;
  }
  const ran = await run(process.argv.slice(2), {
    storePath: storePathFromGit(root),
    rules,
    env: process.env,
    now: () => new Date(),
  });
  process.stdout.write(ran.stdout);
  process.stderr.write(ran.stderr);
  return ran.code;
}

if (import.meta.main) process.exitCode = await main();
