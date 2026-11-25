#!/usr/bin/env bun
/**
 * The ci-doctor's intake gate — block until CI has one case worth a model turn.
 *
 * Same contract as `frontier-gate.ts`, and for the same reason: a supervisor
 * that spawns an iteration to be told there is nothing wrong with CI burns a
 * whole fresh-context turn and then stops. The doctor's version of that is
 * worse, because healthy CI is the NORMAL state — most polls of a working
 * project must cost nothing at all. So this file answers the question without
 * a model, and hands over at most one case.
 *
 * Three things bound it, and each exists because the doctor polls forever:
 *
 * 1. A **case lease** (`case-lease.ts`). The case is not a GitHub object — a
 *    confirmed flake has no issue yet — so two doctors on one store would
 *    otherwise be handed the same flake. The lease is taken here, before the
 *    handover, and renewed by the supervisor's heartbeat for as long as the
 *    iteration runs (`role-leases.ts`).
 * 2. A **GitHub budget** (`gh-budget.ts`). Twelve calls per idle hour, spent
 *    through three fifteen-minute cadences, persisted in the store so a
 *    restarted doctor does not get a fresh allowance.
 * 3. **Infra cases start no iteration.** A Buildkite agent that cannot boot, a
 *    build that sat scheduled for half an hour, a required check outside
 *    Buildkite red across the whole repo: the doctor has no operator token and
 *    the spec gives it none. Those are pushed once per signature as
 *    `ci-incident` and recorded in the store, and the gate keeps waiting.
 *
 * READ-ONLY of GitHub and of the repository, as the coder's gate's polls are
 * (it claims only the ticket it reports, #5), with one exception: the retry (`retry.ts`) re-runs one flaky failed job — on
 * Buildkite with the retry token, on a GitHub Actions project (#52) through
 * gh's own auth (`repos/<repo>/actions/jobs/<id>/rerun`), under the same
 * `ciDoctor.retry` ceilings either way. It does write the store — the lease, the scan and the budget are all store writes —
 * because the store is the doctor's own scratch record, not the project.
 *
 * Usage:
 *   ci-doctor/gate.ts <poll-seconds>   wait until there is a case, then exit 0
 *   ci-doctor/gate.ts --once           report the verdict now; 0 case, 1 none
 */
import { execFile } from "node:child_process";

import {
  MANAGED_STATES,
  checkIncidents,
  rejectionStands,
  type CheckReading,
} from "./classify";
import { heldElsewhere, takeCaseLease, type Holder } from "./case-lease";
import {
  PARKED,
  REGISTRY,
  affordable,
  due,
  ledgerAt,
  ledgerOf,
  spend,
  type Cadence,
} from "./gh-budget";
import { readStore, storePathFromGit, subjectOf, utcDay, weigh, withStore, type Case, type CiHealthStore, type GhLedger } from "./store";
import {
  Buildkite,
  configuredPipeline,
  resolveOrg,
  retryTokenFrom,
  tokenFrom,
} from "../bk-log";
import { classifyRateLimit } from "../frontier/github-rate-limit";
import { runGhForLogs } from "../gh-actions-log";
import type { Gh as SyncGh } from "../pr-wait";
import { roleDescriptor } from "../roles";
import { hasPendingControl } from "../control-inbox";
import { projectRoot } from "../paths";
import {
  CI_READ_GH_CALLS,
  leaseInUse,
  readCi,
  readStore as readHostLeaseStore,
  requiredChecksFrom,
  storePathFromGit as hostLeaseStorePath,
} from "../host-lease";
import { loadProjectConfig } from "../project-config";
import { push } from "../push-notification";
import { loopsWithRole } from "../roster";
import { actionsSource, isActionsProject } from "./actions-source";
import { retryOnce, type RetryDeps, type RetryResult } from "./retry";
import { GitFacts, NO_ACTIONS_CHECKS, defaultScanOptions, gitIn, scan } from "./scan";
import {
  controlSliceSeconds,
  formatDuration,
  gateResume,
  secretRereadDue,
  secretRereadLine,
  sleepInSlices,
  supervisorGone,
  supervisorPidFrom,
} from "../frontier-gate";
/**
 * Deliberately `frontier-gate.ts`'s `shepherdable` rather than a second
 * implementation: a doctor that read pull-request ownership differently from
 * the coders' gate would shepherd a coder's PR, or abandon its own.
 */
import { shepherdable } from "../frontier-gate";
import { blockReasonOf, latestBlockReason, type BlockKind, type BlockReason, type IssueComment } from "../block-reason";

/** The doctor's own pull requests and claims, on a cadence of their own. */
export const OWN: Cadence = { key: "own", everySeconds: 900 };

/** A pull request, as the shepherd probe needs it (`frontier-gate.ts`'s shape). */
export interface PullRequest {
  number: number;
  isDraft: boolean;
  body: string | null;
}

/** One `ci-health` issue, as the registry read returns it. */
export interface RegistryIssue {
  number: number;
  state: "OPEN" | "CLOSED" | string;
  labels: string[];
}

/**
 * A coder ticket parked on a flake, as the decision needs it. The block
 * comments it came from are read ONCE per ticket ever — a `gh` call each — so
 * this is persisted as a `parked:<n>` case and re-read from the store on every
 * later poll rather than re-fetched.
 */
export interface ParkedTicket {
  number: number;
  /** The loop whose `-blocked` label it carries. */
  loop: string;
  /** The test id the block record names, when it names one. */
  testId: string | null;
  /**
   * What the ticket is parked ON, as `parkedFrom` reads its newest block
   * record: `"flake"`, `"migration"`, `"other"` or `"unknown"`. A string
   * rather than `BlockKind` because it is not that enum — see `Case.parkedOn`.
   * Absent on a case written before #163, which is why the flake count below
   * falls back to `testId !== null` for one.
   */
  parkedOn?: string;
}

export interface Probes {
  loop: string;
  /**
   * The ci-health store, after this poll's scan. There is deliberately no
   * clock here: freshness is the store's business and holding is the lease's,
   * so a decision made from one store is the same decision at any time.
   */
  store: CiHealthStore;
  /** Open pull requests, or null when they could not be read. */
  prs: PullRequest[] | null;
  /** The `ci-health` registry, or null when it could not be read. */
  registry: RegistryIssue[] | null;
  /** Coder tickets parked on a flake, or null when the search could not be run. */
  parked: ParkedTicket[] | null;
  /** Case keys another doctor holds. */
  held: readonly string[];
  /** GitHub throttled a read this poll. */
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
}

export interface Verdict {
  work: boolean;
  why: string;
  /**
   * The case key to lease before the handover, or null when the case is not a
   * store case: a pull request is claimed by its provenance line and a ticket
   * by its `-wip` label, and leasing either would be a second claim on one
   * thing.
   */
  key: string | null;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
}

// `weigh` and `subjectOf` live in `./store`, beside the `cost72h` and the key
// grammar they read, so `known.ts` can rank cases the same way this gate does
// without importing a module that imports `../bk-log`. Re-exported for this
// module's own callers and tests.
export { subjectOf, weigh } from "./store";

const display = (loop: string): string => `${loop[0]?.toUpperCase() ?? ""}${loop.slice(1)}`;


const openIssues = (registry: readonly RegistryIssue[]): Set<number> =>
  new Set(registry.filter((issue) => issue.state === "OPEN").map((issue) => issue.number));

/** Cases in key order, so two doctors reading one store rank them alike. */
const casesOf = (store: CiHealthStore, kind: Case["kind"]): [string, Case][] =>
  Object.entries(store.cases)
    .filter(([, value]) => value.kind === kind)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Has this `fixed` flake come back since its fix landed?
 *
 * `cost72h` cannot answer on its own: the window still holds the reds from
 * before the fix, and `mergeCases` only zeroes the cost of a managed case that
 * has fallen out of the window entirely. So the boundary is `fixedAt`, and a
 * case without one reads as "not known to have recurred" — see the field's
 * comment in `store.ts` for why that fails closed.
 */
export function recurred(value: Case): boolean {
  if (value.kind !== "flake" || value.state !== "fixed") return false;
  const boundary = value.fixedAt?.build;
  if (typeof boundary !== "number") return false;
  return value.evidence.some((seen) => seen.build > boundary);
}

/** Is this parked ticket something an iteration can act on now? */
export function actionable(ticket: ParkedTicket, store: CiHealthStore): { case: Case; key: string; state: string } | null {
  if (ticket.testId === null) return null;
  const key = `flake:${ticket.testId}`;
  const value = store.cases[key];
  if (value === undefined || value.kind !== "flake") return null;
  // Two openings, both from the spec: the flake it was parked on is FIXED, so
  // the ticket can go back to its loop; or the diagnosis is new, meaning this
  // doctor has confirmed the flake since and has not unparked this ticket for
  // it yet. `unparks` is the record that keeps the second from repeating.
  if (value.state === "fixed") return { case: value, key, state: "fixed" };
  if (value.state === "confirmed" && store.cases[`parked:${ticket.number}`]?.unparks[key] === undefined) {
    return { case: value, key, state: "confirmed" };
  }
  return null;
}

/**
 * The six priorities, first match wins, exactly as the ticket lists them.
 *
 * A probe that could not be read is a WAIT rather than a handover — an
 * iteration could not have done the work either — with two exceptions that
 * mirror `frontier-gate.ts`: an unreadable pull-request list never vetoes a
 * lower priority's positive answer, and neither does an unreadable parked
 * search. An unreadable REGISTRY does veto, because priority 3 outranks
 * everything local and cannot be evaluated without it.
 */
export function decide(probes: Probes): Verdict {
  const { store } = probes;
  // Before the ladder, not after it. A throttled poll starts NO iteration —
  // the spec is unqualified, and it is right: the model would be handed a
  // store whose GitHub half this gate could not refresh, and the priorities
  // most worth having (a regression with no issue, a ticket parked on a flake)
  // are exactly the ones read from GitHub.
  if (probes.rateLimited === true) {
    return {
      work: false,
      why: throttledWhy(probes.retryAfterSeconds ?? null),
      key: null,
      rateLimited: true,
      retryAfterSeconds: probes.retryAfterSeconds ?? null,
    };
  }
  const held = new Set(probes.held);
  const caveats: string[] = [];
  // Which cases were passed over only because somebody else has them. An idle
  // log that said "CI is healthy" while another doctor worked the one open
  // flake would be the single most misleading line this file can print.
  const blocked: string[] = [];
  const skipped = (key: string): boolean => {
    if (!held.has(key)) return false;
    blocked.push(key);
    return true;
  };

  if (probes.prs !== null) {
    const own = shepherdable(probes.prs, probes.loop);
    if (own !== null) return { work: true, why: `${display(probes.loop)} PR #${own.number} to shepherd`, key: null };
  } else {
    caveats.push("open PRs unreadable");
  }

  if (probes.registry === null) {
    return { work: false, why: "the ci-health registry could not be read", key: null };
  }

  const open = openIssues(probes.registry);

  const claim = probes.registry.find(
    (issue) => issue.state === "OPEN" && issue.labels.includes(`${probes.loop}-wip`),
  );
  if (claim !== undefined) {
    return {
      work: true,
      why: `issue #${claim.number} carries this loop's unfinished claim — an iteration resumes it under §0's recovery`,
      key: null,
    };
  }

  for (const [key, value] of casesOf(store, "regression")) {
    if (skipped(key)) continue;
    if (value.state === "fixed" || value.state === "retired" || value.state === "handed-off") continue;
    if (value.issue !== null && open.has(value.issue)) continue;
    return { work: true, why: `regression on main — ${subjectOf(key)} has no open ci-health issue`, key };
  }

  if (probes.parked !== null) {
    for (const ticket of [...probes.parked].sort((a, b) => a.number - b.number)) {
      const act = actionable(ticket, store);
      if (act === null || skipped(`parked:${ticket.number}`)) continue;
      return {
        work: true,
        why: `parked ticket #${ticket.number} — the flake it names (${act.state}) is ${subjectOf(act.key)}`,
        key: `parked:${ticket.number}`,
      };
    }
  } else {
    caveats.push("the parked-ticket search was not run");
  }

  const confirmed = casesOf(store, "flake")
    .filter(([key, value]) => value.state === "confirmed" && !skipped(key))
    .sort(([, a], [, b]) => weigh(b.cost72h) - weigh(a.cost72h));
  const first = confirmed[0];
  if (first !== undefined) {
    return { work: true, why: `confirmed flake ${subjectOf(first[0])} — 72h cost ${weigh(first[1].cost72h)}`, key: first[0] };
  }

  for (const [key, value] of casesOf(store, "flake")) {
    if (!recurred(value) || skipped(key)) continue;
    return { work: true, why: `fixed flake ${subjectOf(key)} recurred after its fix — reopening`, key };
  }

  // A rejected case is inert everywhere, not just at priority 5 — which
  // already skips it, since it filters on `confirmed`. This branch starts no
  // iteration, so the cost is only the line itself, but an operator reading an
  // idle doctor should not be told it is sitting out an incident its own
  // doctor turned down (#240).
  const infra = casesOf(store, "infra").filter(
    // `store.builds` so a step gone green since the boundary lifts the
    // rejection here too, not only at the next scan's fold (#57).
    ([, value]) => !MANAGED_STATES.has(value.state) && !rejectionStands(value, value.evidence, store.builds),
  );
  const note = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";
  if (infra.length > 0) {
    // Named rather than counted: the one thing an operator reading an idle
    // doctor's log needs is WHICH incident it is sitting out. A red run also
    // carries its rule, which names the step and how long it has been red
    // (#57) — the two things that say whether to go and look.
    const named = infra.map(([key, value]) => (value.redRun != null && value.rule ? `${key} (${value.rule})` : key));
    return {
      work: false,
      why: `CI is red on infrastructure this loop cannot fix — ${named.join(", ")}${note}`,
      key: null,
    };
  }
  if (blocked.length > 0) {
    return { work: false, why: `every case is held by another doctor (${[...new Set(blocked)].sort().join(", ")})${note}`, key: null };
  }
  const openCases = Object.values(store.cases).filter((value) => value.state === "candidate").length;
  return {
    work: false,
    why:
      openCases > 0
        ? `nothing confirmed — ${openCases} candidate(s) still short of evidence${note}`
        : `CI is healthy${note}`,
    key: null,
  };
}

export const throttledWhy = (retryAfterSeconds: number | null): string =>
  `GitHub rate-limited the doctor's read${retryAfterSeconds === null ? "" : ` (GitHub asked for ${retryAfterSeconds}s)`}`;

/* --------------------------------------------------------------------------
 * Infrastructure: notified once per signature, never handed to an iteration.
 * ----------------------------------------------------------------------- */

export interface Incident {
  key: string;
  occurrence: string;
  subject: string;
  body: string;
}

/**
 * The infra cases this store has not been notified about yet, as the pushes
 * they become.
 *
 * The occurrence key is `ci-incident:<signature>:<first build>`, and the
 * record that dedupes it lives in the STORE rather than in the push state:
 * `push-notification.ts` dedupes per run, in the worktree, so a doctor
 * restarted mid-incident would page again — and the criterion here is one
 * notification per signature, full stop.
 */
export function incidents(store: CiHealthStore): Incident[] {
  const out: Incident[] = [];
  for (const [key, value] of casesOf(store, "infra")) {
    if (value.notified) continue;
    // Nor one this doctor rejected (#240). `decide` already leaves a rejected
    // case out of the verdict, and paging an operator about an incident the
    // doctor itself turned down would say the opposite of the verdict in the
    // same poll.
    if (rejectionStands(value, value.evidence, store.builds)) continue;
    const first = value.evidence.reduce<number | null>(
      (low, seen) => (low === null || seen.build < low ? seen.build : low),
      null,
    );
    const signature = subjectOf(key);
    const line = value.evidence[0]?.line ?? "";
    out.push({
      key,
      occurrence: `ci-incident:${signature}:${first ?? 0}`,
      subject: `CI infrastructure incident: ${signature}`,
      body:
        `${value.evidence.length} red build(s) since build ${first ?? "?"}. ` +
        `This loop has no operator token and cannot fix it.` +
        // A red run's rule is its step and length (#57): what an operator
        // paged about a dead step needs before the error line.
        (value.redRun != null && value.rule ? `\n${value.rule}` : "") +
        (line === "" ? "" : `\n${line}`),
    });
  }
  return out;
}

/** The readings `checkIncidents` wants, off the PR list the shepherd probe already made. */
export function checkReadings(prs: readonly PullRequestWithChecks[]): CheckReading[] {
  const out: CheckReading[] = [];
  for (const pr of prs) {
    for (const check of pr.statusCheckRollup ?? []) {
      const name = check.name ?? check.context ?? "";
      // Buildkite is the scan's business, and `checkIncidents` drops it by
      // name — filtering here too would be a second copy of that rule.
      if (name === "") continue;
      const state = (check.conclusion ?? check.state ?? "").toLowerCase();
      out.push({
        pr: pr.number,
        name,
        state: state === "failure" || state === "error" ? "failure" : state === "success" ? "success" : state,
        description: check.description ?? check.title ?? "",
      });
    }
  }
  return out;
}

/** A pull request with the check rollup the same `gh pr list` call returns. */
export interface PullRequestWithChecks extends PullRequest {
  statusCheckRollup?: {
    name?: string;
    context?: string;
    state?: string;
    conclusion?: string;
    description?: string;
    title?: string;
  }[];
}

/**
 * The test id a block record names, read from the WHOLE record and not from
 * its first line: `prompt.md` §6 has the coder open with `blocked: …` and
 * quote the failing line from `bk-log.ts` underneath it, which is where the
 * test id actually is. `BlockReason.reason` is the first line alone, so
 * matching against that found nothing on every real record.
 */
export function testIdOf(body: string): string | null {
  // The shape §6 asks for: `<job>: FAIL <file> > <test> — Error: …`.
  const quoted = /(?:FAIL|✕|×)\s+(\S+\.(?:test|spec)\.[jt]sx?)(?:\s*>\s*([^\n]+?))?(?:\s+—|\s*$)/m.exec(body);
  if (quoted !== null) {
    const file = quoted[1]!;
    const title = quoted[2]?.trim();
    return title ? `${file} > ${title}` : file;
  }
  const file = /(\S+\.(?:test|spec)\.[jt]sx?)/.exec(body);
  return file === null ? null : file[1]!;
}

/**
 * Whether a block record QUOTES a CI failure, which is the shape §6 of the
 * coder prompt asks a blocked loop to write: `<job>: FAIL <file> > <test> —
 * Error: …`. Distinct from `testIdOf` returning non-null, whose fallback
 * matches any `*.test.ts` token anywhere in the body — so a record that merely
 * mentions a test file is not evidence of a CI block, and a quoted failure is.
 */
const QUOTED_FAILURE = /(?:FAIL|✕|×)\s+\S+\.(?:test|spec)\.[jt]sx?/m;

/**
 * What a block record says the ticket is parked on, which is broader than
 * `block-reason.ts`'s kind: that module classifies from the record's FIRST
 * LINE alone (`block-reason.ts:152`), so the canonical CI block — `blocked: PR
 * #1681 red twice in CI` with the failing test quoted beneath — comes back
 * `other` even though it is the very ticket `actionable` below picks up. A
 * quoted failure is therefore read as a flake park too.
 *
 * A migration is never a flake park whatever it quotes: a person has to apply
 * it, and no retry of ours changes that.
 */
const parkedOnOf = (kind: BlockKind, body: string): string =>
  kind === "migration" ? "migration" : kind === "ci-flake" || QUOTED_FAILURE.test(body) ? "flake" : kind;

/**
 * Read one parked ticket's block record from its comments: the newest comment
 * that IS a block record, so the reason and the test id come from one record
 * rather than from two different comments.
 */
export const parkedFrom = (
  number: number,
  loop: string,
  comments: readonly IssueComment[],
): { ticket: ParkedTicket; block: BlockReason } => {
  const block = latestBlockReason(comments);
  const record = [...comments].reverse().find((comment) => blockReasonOf(comment) !== null);
  // A ticket waiting on a person to apply a migration is not parked on a
  // flake, whatever test its record happens to mention.
  const testId =
    record === undefined || block.kind === "migration" ? null : testIdOf(record.body);
  const parkedOn = record === undefined ? block.kind : parkedOnOf(block.kind, record.body);
  return { ticket: { number, loop, testId, parkedOn }, block };
};

export { shepherdable };

/* --------------------------------------------------------------------------
 * The reads, each on its cadence and every one charged to the budget.
 * ----------------------------------------------------------------------- */

/** One command's outcome. Failure is "could not tell", never an exception. */
export interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type Gh = (args: string[]) => Promise<Ran>;

/** What the last successful read of each cadence returned, carried between polls. */
export interface Cached {
  prs: PullRequestWithChecks[] | null;
  registry: RegistryIssue[] | null;
  /** The parked SEARCH's answer — which tickets are parked, not what they say. */
  open: { number: number; loop: string }[] | null;
}

export const noCache = (): Cached => ({ prs: null, registry: null, open: null });

export interface Reads extends Cached {
  ledger: GhLedger;
  /** How many `gh` calls this poll made. */
  calls: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  /** Tickets whose block comments were read this poll, to be recorded. */
  read: { ticket: ParkedTicket; block: BlockReason }[];
}

const jsonOf = <T>(ran: Ran): T | null => {
  if (!ran.ok) return null;
  try {
    return JSON.parse(ran.stdout) as T;
  } catch {
    return null;
  }
};

/** The `-blocked` label a search hit carries, and whose loop it is. */
export function blockedLoop(labels: readonly { name: string }[], coders: readonly string[]): string | null {
  for (const label of labels) {
    const loop = /^(.+)-blocked$/.exec(label.name)?.[1];
    if (loop !== undefined && coders.includes(loop)) return loop;
  }
  return null;
}

/**
 * Every GitHub read one poll may make, in budget order.
 *
 * Three cadences and one kind of one-off, and the ORDER is the policy: the
 * standing reads go first because they are what the six priorities are decided
 * from, and the per-ticket block comments come last because a poll that cannot
 * afford them still decides correctly — it just cannot see priority 4 yet.
 *
 * A read that is not due, or not affordable, leaves the cached answer in place.
 * That is the point of the cache: the budget is spent on FRESHNESS, and a
 * registry five minutes old decides the same way as one five seconds old.
 */
export async function readGithub(
  gh: Gh,
  cached: Cached,
  store: CiHealthStore,
  options: { now: number; loop: string; coders: readonly string[]; searchLabels: string },
): Promise<Reads> {
  let ledger: GhLedger = ledgerAt(ledgerOf(store, options.loop), options.now);
  let calls = 0;
  let rateLimited = false;
  let retryAfterSeconds: number | null = null;
  const out: Reads = { ...cached, ledger, calls, rateLimited, retryAfterSeconds, read: [] };

  /**
   * Make one call, if the budget allows it.
   *
   * `cold` is what makes `--once` and a restarted gate work: the cadence marks
   * are in the STORE and the answers are in this process's memory, so a fresh
   * gate within fifteen minutes of the last poll would find nothing due, hold
   * no answer either, and report "the registry could not be read" — which
   * `ralph.sh` stops the loop on. A read with no cached answer is therefore
   * always attempted, and only the twelve-per-hour ceiling refuses it.
   *
   * The cadence is stamped only when the call SUCCEEDS. Stamping it first meant
   * one throttled registry read blinded priority 3 for a full fifteen minutes
   * while the gate went on polling every five.
   */
  const ask = async (args: string[], cadence?: Cadence, cold = false): Promise<Ran | null> => {
    if (!affordable(ledger, 1, options.now)) return null;
    if (cadence !== undefined && !cold && !due(ledger, cadence, options.now)) return null;
    ledger = spend(ledger, 1, options.now);
    calls += 1;
    const ran = await gh(args);
    if (!ran.ok) {
      const signal = classifyRateLimit(ran.stderr || ran.stdout);
      if (signal !== null) {
        rateLimited = true;
        // Only ever null in practice: `classifyRateLimit` reads `retry-after`
        // off response HEADERS, and neither `gh pr list` nor `gh issue list`
        // can be asked for them (`--include` is `gh api`'s). So the wait falls
        // back to five minutes, which is what `throttleWaitSeconds` defaults to.
        retryAfterSeconds = signal.retryAfterSeconds ?? retryAfterSeconds;
      }
      return ran;
    }
    if (cadence !== undefined) ledger = spend(ledger, 0, options.now, cadence);
    return ran;
  };

  const prs = await ask(
    ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,isDraft,body,statusCheckRollup"],
    OWN,
    cached.prs === null,
  );
  if (prs !== null) {
    const parsed = jsonOf<PullRequestWithChecks[]>(prs);
    if (parsed !== null) out.prs = parsed;
  }

  const registry = await ask(
    ["issue", "list", "--label", "ci-health", "--state", "all", "--limit", "200", "--json", "number,state,labels"],
    REGISTRY,
    cached.registry === null,
  );
  if (registry !== null) {
    const parsed = jsonOf<{ number: number; state: string; labels: { name: string }[] }[]>(registry);
    if (parsed !== null) {
      out.registry = parsed.map((issue) => ({
        number: issue.number,
        state: issue.state.toUpperCase(),
        labels: (issue.labels ?? []).map((label) => label.name),
      }));
    }
  }

  const search = await ask(
    ["issue", "list", "--state", "open", "--limit", "100", "--search", options.searchLabels, "--json", "number,labels"],
    PARKED,
    cached.open === null,
  );
  if (search !== null) {
    const parsed = jsonOf<{ number: number; labels: { name: string }[] }[]>(search);
    if (parsed !== null) {
      out.open = parsed
        .map((issue) => ({ number: issue.number, loop: blockedLoop(issue.labels ?? [], options.coders) }))
        .filter((hit): hit is { number: number; loop: string } => hit.loop !== null);
    }
  }

  for (const hit of out.open ?? []) {
    if (store.cases[`parked:${hit.number}`] !== undefined) continue;
    const view = await ask(["issue", "view", String(hit.number), "--json", "comments"]);
    if (view === null) break;
    const parsed = jsonOf<{ comments: IssueComment[] }>(view);
    if (parsed === null) continue;
    out.read.push(parkedFrom(hit.number, hit.loop, parsed.comments ?? []));
  }

  return { ...out, ledger, calls, rateLimited, retryAfterSeconds };
}

/**
 * The parked tickets the decision sees: this poll's search answer, each
 * ticket's diagnosis taken from the `parked:<n>` case its comments were
 * recorded in. A ticket the search still lists but whose case is gone was
 * never readable, and is left out rather than guessed at.
 */
export function parkedTickets(
  store: CiHealthStore,
  open: readonly { number: number; loop: string }[] | null,
): ParkedTicket[] | null {
  if (open === null) return null;
  const out: ParkedTicket[] = [];
  for (const hit of open) {
    const value = store.cases[`parked:${hit.number}`];
    if (value === undefined) continue;
    // No cast: the store is JSON on disk and `parkedOn` is whatever is
    // written there, which is why neither it nor `Case.parkedOn` claims to be
    // a `BlockKind`. `parkedOnFlake` compares it to one literal and an
    // unrecognised value is simply not that literal.
    const parkedOn = value.parkedOn ?? undefined;
    out.push({
      number: hit.number,
      loop: hit.loop,
      testId: value.rule ?? null,
      ...(parkedOn === undefined ? {} : { parkedOn }),
    });
  }
  return out;
}

/**
 * The `parked:<n>` case a block record becomes. `rule` is the flake it names,
 * `parkedOn` what the record says it waits on — the latter only so the per-day
 * `parkedOnFlake` metric (#163) can count the tickets parked on a flake
 * without a second `gh` call on every poll.
 */
export const parkedCase = (testId: string | null, parkedOn?: string): Case => ({
  kind: "parked",
  state: "candidate",
  evidence: [],
  cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  rule: testId,
  ...(parkedOn === undefined ? {} : { parkedOn }),
});

/**
 * How many of these tickets are parked on a flake: the metric #163 measures
 * the doctor by, read off the parked search the gate already ran rather than
 * from a call of its own.
 *
 * A ticket counts when `parkedOn` says `"flake"` — which `parkedOnOf` above
 * decides from the record's lead line OR a quoted CI failure, so both the
 * canonical CI block and a flake block that names no test file are caught, and
 * a record that merely mentions a `*.test.ts` path is not.
 *
 * A case written before #163 has no `parkedOn`, and for one the test id alone
 * is the best the store can answer. It is the looser test — `testIdOf`'s
 * fallback matches any test-file token — so it over-counts a little rather
 * than silently reading every pre-#163 park as "not a flake", which would put
 * a visible step in the trend on the day this shipped.
 */
export const parkedOnFlake = (parked: readonly ParkedTicket[]): number =>
  parked.filter((ticket) => (ticket.parkedOn === undefined ? ticket.testId !== null : ticket.parkedOn === "flake"))
    .length;

/* --------------------------------------------------------------------------
 * One poll.
 * ----------------------------------------------------------------------- */

export interface PollDeps {
  gh: Gh;
  /**
   * One CI poll into the store. False means the CI could not be read.
   * `ghCalls` is what the poll spent of the gate's GitHub allowance (an
   * Actions scan reads runs, jobs and logs over gh; Buildkite's spends none),
   * absent meaning none.
   */
  scan: () => Promise<ScanResult>;
  notify: (incident: Incident) => void;
  now: () => number;
  storePath: string;
  loop: string;
  run: string;
  coders: readonly string[];
  /**
   * One retry of a candidate flake's failed job, or ABSENT when the doctor has
   * no retry token.
   *
   * Absent is the ordinary shape: `RALPH_BUILDKITE_RETRY_TOKEN` is a gate-only
   * secret the supervisor exports only once its check has passed, so a project
   * that has not stored one — or whose token is wider than `write_builds` —
   * leaves this undefined and the doctor runs on natural reruns alone, which is
   * exactly how it behaved before #161.
   *
   * `afford` is this poll's remaining GitHub allowance: the idle read the retry
   * makes is on the gate's budget like every other, and is not made when there
   * is no room for it.
   */
  retry?: (budget: { afford: (calls: number) => boolean }) => Promise<RetryResult>;
  /** Injected so the race test can fake a live holder. */
  alive?: (holder: { pid: number; host: string }) => boolean;
}

export interface ScanResult {
  ok: boolean;
  why: string;
  ghCalls?: number;
}

export interface Polled {
  verdict: Verdict;
  cached: Cached;
  /** `gh` calls this poll made, for the counting shim. */
  calls: number;
  /** What the retry did this poll, or null when the doctor holds no retry token. */
  retried: RetryResult | null;
}

/** `label:ralph-blocked,rafa-blocked,…` — one search over every coder's label. */
export const searchLabels = (coders: readonly string[]): string =>
  `label:${coders.map((loop) => `${loop}-blocked`).join(",")}`;

/**
 * The check names the scan already reads as jobs: GitHub names an Actions
 * job's check after the job, and the scan records those names on the build
 * (`jobNames`) rather than leaving them to be cut out of a `<workflow>/<job>`
 * step key, which a `/` in either name breaks. Their reds are the scan's
 * evidence, so `checkIncidents` must not count them again.
 */
export function scannedJobNames(store: CiHealthStore): Set<string> {
  const names = new Set<string>();
  for (const build of store.builds) for (const name of build.jobNames ?? []) names.add(name);
  return names;
}

/**
 * Read, decide, and — when there is a case — take its lease before handing it
 * over.
 *
 * The lease is the last thing that happens, and a lost race for it re-decides
 * rather than waits: the second doctor's next-best case is very often free, and
 * sleeping a whole interval to find that out is the stall this gate exists to
 * prevent. Bounded by the number of cases, so it cannot spin.
 */
export async function poll(deps: PollDeps, cached: Cached): Promise<Polled> {
  const now = deps.now();
  const scanned = await deps.scan();
  const scanGhCalls = scanned.ghCalls ?? 0;
  if (!scanned.ok) {
    // A failed Actions scan may still have spent gh calls (the list pages and
    // jobs reads before the one that failed): they go on the ledger too, or a
    // scan failing every poll would spend outside the allowance unseen. A
    // ledger write that fails is not a reason to stop the gate.
    if (scanGhCalls > 0) {
      try {
        await withStore(deps.storePath, (open) => {
          open.gh = { ...open.gh, [deps.loop]: spend(ledgerAt(ledgerOf(open, deps.loop), now), scanGhCalls, now) };
        });
      } catch {
        // Degrade: the next poll's spend is still recorded.
      }
    }
    return { verdict: { work: false, why: scanned.why, key: null }, cached, calls: 0, retried: null };
  }

  const snapshot = readStore(deps.storePath);
  const reads = await readGithub(deps.gh, cached, snapshot, {
    now,
    loop: deps.loop,
    coders: deps.coders,
    searchLabels: searchLabels(deps.coders),
  });

  // The retry, BEFORE the one store write below, so the GitHub calls its idle
  // read makes land on the same ledger as the rest of this poll's. It is
  // deliberately not part of the verdict: a retried job is evidence the NEXT
  // scan reads (`classify.ts:250-263` turns a pass into "same tree, both
  // colours"), so it must not change what this poll hands over. It costs no
  // model turn and throws nothing — `retryOnce` reports a Buildkite fault
  // rather than raising it, because a 500 must not stop a gate.
  const retried =
    deps.retry === undefined
      ? null
      : await deps.retry({ afford: (calls) => affordable(reads.ledger, calls, now) });

  // One write for everything this poll learned: the budget it spent, the block
  // records it read, and the infrastructure incidents the PR checks showed.
  const checks = reads.prs === null ? {} : checkIncidents(checkReadings(reads.prs), undefined, scannedJobNames(snapshot));
  const store = await withStore(deps.storePath, (open) => {
    open.gh = { ...open.gh, [deps.loop]: spend(reads.ledger, scanGhCalls + (retried?.ghCalls ?? 0), now) };
    for (const { ticket } of reads.read)
      open.cases[`parked:${ticket.number}`] = parkedCase(ticket.testId, ticket.parkedOn);
    for (const [key, value] of Object.entries(checks)) {
      const prev = open.cases[key];
      // Only what this read actually learned. Rewriting the case from the
      // proposal — as a shorter merge here used to — dropped the `issue` a
      // filed incident carries, and `notified` with it; `mergeCases` preserves
      // exactly this set, and the two must not disagree.
      open.cases[key] =
        prev === undefined ? value : { ...prev, evidence: value.evidence, cost72h: value.cost72h, rule: value.rule };
    }
    // The day's parked-on-a-flake count, from the search this poll already
    // ran (#163). The HIGHEST count the day saw, not the latest: a ticket
    // unparked at noon still cost the loops its morning, and a poll that could
    // not run the search must not read as a quiet day — which is why a null
    // search writes nothing at all.
    const parked = reads.open === null ? null : parkedTickets(open, reads.open);
    if (parked !== null) {
      const day = utcDay(now);
      const existing = open.metrics[day] ?? { knownFlakeReds: 0, parkedOnFlake: 0 };
      open.metrics[day] = {
        ...existing,
        parkedOnFlake: Math.max(existing.parkedOnFlake, parkedOnFlake(parked)),
      };
    }
    return structuredClone(open);
  });

  // Infra is answered here and nowhere else: one push per signature, recorded
  // in the store, and no iteration. The doctor has no operator token.
  const raised = incidents(store);
  if (raised.length > 0) {
    for (const incident of raised) deps.notify(incident);
    await withStore(deps.storePath, (open) => {
      for (const incident of raised) {
        const value = open.cases[incident.key];
        if (value !== undefined) value.notified = incident.occurrence;
      }
    });
  }

  const holder: Holder = { run: deps.run, loop: deps.loop };
  const skip = new Set(heldElsewhere(store.leases, holder, now, deps.alive));
  const next: Cached = { prs: reads.prs, registry: reads.registry, open: reads.open };

  for (let round = 0; round <= Object.keys(store.cases).length; round++) {
    const verdict = decide({
      loop: deps.loop,
      store,
      prs: reads.prs,
      registry: reads.registry,
      parked: parkedTickets(store, reads.open),
      held: [...skip],
      rateLimited: reads.rateLimited,
      retryAfterSeconds: reads.retryAfterSeconds,
    });
    if (!verdict.work || verdict.key === null) return { verdict, cached: next, calls: reads.calls, retried };
    const taken = await takeCaseLease(deps.storePath, verdict.key, holder, { nowMs: now, alive: deps.alive });
    if (taken.taken) return { verdict, cached: next, calls: reads.calls, retried };
    // Another doctor got there between the read and the write. Its case is off
    // the table; ask again for the next one.
    skip.add(verdict.key);
  }
  return {
    verdict: { work: false, why: `every case is held by another doctor (${[...skip].sort().join(", ")})`, key: null },
    cached: next,
    calls: reads.calls,
    retried,
  };
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

const PREFIX = "ci-doctor-gate";

/** The line `ralph.sh` reads a case off. Its prefix is role-agnostic there. */
export const verdictLine = (verdict: Verdict): string =>
  `${PREFIX}: ${verdict.work ? "work available" : "nothing to do"} — ${verdict.why}`;

export const workLine = (verdict: Verdict): string => `${PREFIX}: work available — ${verdict.why}`;

/** What the retry did, on the supervisor log. Never carries a token. */
export const retryLine = (result: RetryResult): string => `${PREFIX}: retry ${result.outcome} — ${result.why}`;

/** Matched by `ralph.sh`, which goes back to its control checkpoint instead of spawning. */
export const CONTROL_PENDING_LINE = `${PREFIX}: control command waiting — handing back to the supervisor`;

export function waitingLine(
  verdict: Verdict,
  state: { poll: number; waitingSince: Date; now: Date; waitSeconds: number },
): string {
  const idle = Math.max(0, Math.round((state.now.getTime() - state.waitingSince.getTime()) / 1000));
  const at = state.now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${PREFIX}: ${verdict.why} at ${at} — waiting ${state.waitSeconds}s (poll ${state.poll}, idle ${formatDuration(idle)})`;
}

/** The doctor's poll interval: what the project configured, else the supervisor's, else 300s. */
export function pollSeconds(config: unknown, argv: string | undefined): number {
  const configured = (config as { ciDoctor?: { pollSeconds?: unknown } } | null)?.ciDoctor?.pollSeconds;
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  // `project-config.ts` validates the block (#158), so a config this harness
  // loaded has a whole `pollSeconds` of at least 1; this reads it leniently
  // because `main` hands it in as `unknown`.
  if (argv !== undefined && /^\d+$/.test(argv) && Number(argv) >= 1) return Number(argv);
  return DEFAULT_POLL_SECONDS;
}

/**
 * From the role descriptor, not a literal: `roles.ts` is where a role says how
 * long its gate waits, and a second copy of the number here would be the one
 * that silently won.
 */
export const DEFAULT_POLL_SECONDS = roleDescriptor("ci-doctor").pollSeconds;

/**
 * ±20% jitter on every wait. Four loops throttled together on 2026-09-28 came
 * back together on one 300s beat; the doctor is the loop most likely to be
 * running beside its own coders, so its polls have to drift off theirs.
 */
export const jittered = (seconds: number, random: () => number = Math.random): number =>
  Math.max(1, Math.round(seconds * (0.8 + random() * 0.4)));

/**
 * The wait after a throttled poll: what GitHub asked for, or five minutes.
 * No iteration is started from a throttled poll at all — a doctor that spawned
 * one would hand a model a store it could not refresh.
 */
export const throttleWaitSeconds = (retryAfterSeconds: number | null): number =>
  Math.max(1, retryAfterSeconds ?? 300);

/**
 * The real `gh`. The 32 MB buffer is not generosity: a registry search asks
 * for fifty issue bodies at once.
 *
 * Exported because the doctor's CLIs run the same `gh` — `ci-doctor/unpark.ts`
 * imports it rather than keeping a third copy of these six lines.
 */
export const ghRunner: Gh = (args) =>
  new Promise<Ran>((resolve) => {
    execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout, stderr });
    });
  });

/**
 * What the scan and the retry both read about the project: its required
 * checks (which say whose CI it is), its repository and base branch, and its
 * config. Read leniently: a missing config leaves the env's answers, and the
 * caller decides what an empty one means.
 */
function projectCi(root: string, env: NodeJS.ProcessEnv): { required: string[]; repo: string | null; baseBranch: string; config: unknown } {
  let config: unknown = null;
  let repo: string | null = env.RALPH_PROJECT_REPO?.trim() || null;
  let baseBranch = env.RALPH_BASE_BRANCH?.trim() || "";
  // `host-lease.ts`'s own reader, not a second copy of the split: the two
  // copies disagreed by a `.trim()`, and `readCi` matches a check name exactly.
  let required: string[] = requiredChecksFrom(env);
  try {
    const loaded = loadProjectConfig(root);
    config = loaded;
    repo ??= loaded.repo;
    if (baseBranch === "") baseBranch = loaded.baseBranch;
    if (required.length === 0) required = [...loaded.requiredChecks];
  } catch {
    // Read leniently, as `pollSeconds` does: a project without a readable
    // config still gets the ceilings `retry.ts` clamps to.
  }
  // One fallback for the scan and the retry: an env-only project (no readable
  // config, no RALPH_BASE_BRANCH) must not get a scan on `main` and no retry.
  if (baseBranch === "") baseBranch = "main";
  return { required, repo, baseBranch, config };
}

/** The poll, wired as `ci-doctor/scan.ts`'s own CLI wires it: Buildkite builds, or GitHub Actions runs. */
export async function scanOnce(
  storePath: string,
  root: string,
  env: NodeJS.ProcessEnv,
  gh: SyncGh = runGhForLogs,
): Promise<ScanResult & { ghCalls: number }> {
  const project = projectCi(root, env);
  const baseBranch = project.baseBranch;
  if (isActionsProject(project.required, env)) {
    const repo = project.repo;
    if (repo === null) return { ok: false, why: "no repository to read GitHub Actions from", ghCalls: 0 };
    const workflow = env.RALPH_ACTIONS_WORKFLOW?.trim() || null;
    if (project.required.length === 0 && workflow === null) return { ok: false, why: NO_ACTIONS_CHECKS, ghCalls: 0 };
    const [owner = repo, name = repo] = repo.split("/");
    // Every list page, jobs read and log read is a gh call on the gate's
    // allowance, counted here so `poll` charges it to the ledger.
    let ghCalls = 0;
    const counted: SyncGh = (args) => {
      ghCalls += 1;
      return gh(args);
    };
    try {
      const source = actionsSource(counted, repo, { workflow, required: project.required });
      await scan(source, new GitFacts(gitIn(root), baseBranch), storePath, defaultScanOptions(owner, name, { baseBranch }));
      return { ok: true, why: "", ghCalls };
    } catch (error) {
      return {
        ok: false,
        why: `GitHub Actions could not be read (${error instanceof Error ? error.message : String(error)})`,
        ghCalls,
      };
    }
  }
  const token = tokenFrom(env);
  if (token === null) return { ok: false, why: "no Buildkite token — RALPH_BUILDKITE_READ_TOKEN is not set", ghCalls: 0 };
  const pipeline = configuredPipeline(env);
  if (pipeline === null) return { ok: false, why: "no Buildkite pipeline configured", ghCalls: 0 };
  const api = new Buildkite(token);
  try {
    const org = await resolveOrg(api, env, pipeline);
    await scan(api, new GitFacts(gitIn(root), baseBranch), storePath, defaultScanOptions(org, pipeline, { baseBranch }));
    return { ok: true, why: "", ghCalls: 0 };
  } catch (error) {
    return { ok: false, why: `Buildkite could not be read (${error instanceof Error ? error.message : String(error)})`, ghCalls: 0 };
  }
}

/**
 * The retry, wired, or null when this doctor cannot make one.
 *
 * Null covers every way the exception can be closed — no token, no pipeline, no
 * repo to ask about CI — and in each of them `poll` simply does not call it, so
 * the doctor behaves exactly as it did on natural reruns alone (#161 AC 6).
 * The token is read here and handed on as a BOUND `put`: nothing downstream of
 * this function is given the value.
 */
export function retryDep(root: string, env: NodeJS.ProcessEnv): NonNullable<PollDeps["retry"]> | undefined {
  const wired = retryDepsFrom(root, env);
  // `afford` is deliberately absent from `wired` rather than a placeholder in
  // it: only this poll's ledger can answer it, and a placeholder would be a
  // trap for a direct caller.
  return wired === undefined ? undefined : ({ afford }) => retryOnce({ ...wired, afford });
}

/**
 * Everything a retry needs but the poll's allowance, or undefined when this
 * gate cannot make one (see `retryDep`). Exported for the pr-medic's gate
 * (felipearos/ralph#246), whose one retry per head commit is the same write
 * under the same fences and must not be wired a second way.
 */
export function retryDepsFrom(root: string, env: NodeJS.ProcessEnv): Omit<RetryDeps, "afford"> | undefined {
  const project = projectCi(root, env);
  if (isActionsProject(project.required, env)) return actionsRetryDeps(root, project);
  const token = retryTokenFrom(env);
  const readToken = tokenFrom(env);
  const pipeline = configuredPipeline(env);
  // The READ token is required as well, and not only because the scan needs
  // it: `resolveOrg` asks `/builds` and `/organizations`, and a token whose
  // scope list is exactly `write_builds` — which is the only kind
  // `--check-retry-token` accepts — can read neither. Resolving the org with
  // the retry token therefore threw on every poll, so the feature never fired
  // unless `RALPH_BUILDKITE_ORG` happened to be set, and printed a `fault`
  // line each time. Both review axes found it independently.
  if (token === null || readToken === null || pipeline === null) return undefined;
  const { config, repo, baseBranch, required } = project;
  if (repo === null || baseBranch === "") return undefined;
  const writer = new Buildkite(token);
  const reader = new Buildkite(readToken);
  const git = gitIn(root);
  // Resolved at most once per process, and only when there is a retry to make:
  // `resolveOrg` is itself one or two Buildkite reads unless
  // `RALPH_BUILDKITE_ORG` is set, so the eager version paid them on every poll
  // whatever the fences said — and on a project whose organization is
  // ambiguous it logged a `fault` every five minutes with no candidate in
  // sight. Asked with the READER: a token whose scope list is exactly
  // `write_builds` can answer neither of its probes.
  let org: Promise<string> | null = null;
  const deps: Omit<RetryDeps, "afford"> = {
    storePath: storePathFromGit(root),
    org: () => (org ??= resolveOrg(reader, env, pipeline)),
    pipeline,
    baseBranch,
    config,
    now: () => Date.now(),
    put: (path) => writer.put(path),
    readCi: () => readCi(repo, baseBranch, required),
    hostLeaseBusy: () => leaseInUse(readHostLeaseStore(hostLeaseStorePath(root)), Date.now()),
    ciReadCalls: CI_READ_GH_CALLS,
    branchHead: (branch) => {
      const out = git(["ls-remote", "--heads", "origin", branch]);
      const sha = out === null ? null : /^([0-9a-f]{40})\s/.exec(out)?.[1];
      return sha ?? null;
    },
  };
  return deps;
}

/** `git ls-remote` for one branch's head, or null. */
const headOf =
  (root: string) =>
  (branch: string): string | null => {
    const out = gitIn(root)(["ls-remote", "--heads", "origin", branch]);
    const sha = out === null ? null : /^([0-9a-f]{40})\s/.exec(out)?.[1];
    return sha ?? null;
  };

/**
 * The retry for a GitHub Actions project: one job re-run through gh's own
 * auth, so no token of ours is needed. The organization and pipeline retry.ts
 * passes along are the repo itself; the job id is all the path needs.
 */
function actionsRetryDeps(root: string, project: ReturnType<typeof projectCi>): Omit<RetryDeps, "afford"> | undefined {
  const { config, repo, baseBranch, required } = project;
  if (repo === null || baseBranch === "") return undefined;
  return {
    storePath: storePathFromGit(root),
    org: async () => repo,
    pipeline: repo,
    retryPath: (_org, _pipeline, _build, job) => `repos/${repo}/actions/jobs/${job}/rerun`,
    // The re-run is itself a `gh api` POST, charged to the gate's allowance.
    putGhCalls: 1,
    baseBranch,
    config,
    now: () => Date.now(),
    // A failed POST rejects with gh's own words, so retry.ts reports a `fault`.
    put: async (path) => {
      const ran = await ghRunner(["api", "-X", "POST", path]);
      if (!ran.ok) throw new Error((ran.stderr || ran.stdout || "gh api failed").trim());
    },
    readCi: () => readCi(repo, baseBranch, required),
    hostLeaseBusy: () => leaseInUse(readHostLeaseStore(hostLeaseStorePath(root)), Date.now()),
    ciReadCalls: CI_READ_GH_CALLS,
    branchHead: headOf(root),
  };
}

function deps(root: string, loop: string): PollDeps {
  return {
    gh: ghRunner,
    scan: () => scanOnce(storePathFromGit(root), root, process.env),
    retry: retryDep(root, process.env),
    notify: (incident) =>
      push(root, {
        kind: "ci-incident",
        occurrence: incident.occurrence,
        subject: incident.subject,
        body: incident.body,
        priority: "high",
        ticket: null,
      }),
    now: () => Date.now(),
    storePath: storePathFromGit(root),
    loop,
    run: process.env.RALPH_RUN_ID?.trim() || "adhoc",
    coders: loopsWithRole("coder"),
  };
}

async function main(): Promise<void> {
  // Anchored like `frontier-gate.ts`, and for its reason: unanchored, every
  // `gh` and `git` probe answers for whatever directory this was invoked from.
  process.chdir(projectRoot());
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const loop = process.env.RALPH_LOOP_NAME?.trim() || "ralph";
  const wired = deps(root, loop);

  if (argv.includes("--once")) {
    const { verdict, retried } = await poll(wired, noCache());
    if (retried !== null) console.log(retryLine(retried));
    console.log(verdictLine(verdict));
    process.exitCode = verdict.work ? 0 : 1;
    return;
  }

  let config: unknown = null;
  try {
    config = loadProjectConfig(root);
  } catch {
    config = null;
  }
  const interval = pollSeconds(config, argv[0]);
  const { waitingSince, firstPoll } = gateResume(process.env, new Date());
  const supervisorPid = supervisorPidFrom(process.env, process.ppid);
  const slice = controlSliceSeconds(process.env.RALPH_CONTROL_POLL_SECONDS);
  let cached = noCache();
  let lastRetry: string | null = null;

  for (let count = firstPoll; ; count++) {
    const polled = await poll(wired, cached);
    cached = polled.cached;
    // `none` is the steady state and would be a line every poll; the four
    // outcomes that are not say something an operator reading the log wants.
    // Only when the answer CHANGES. `none` was the steady state before the
    // fences were reordered and `busy` is one now — a quiet host with nothing
    // to retry says `none` for ever, a busy one says `busy` for ever — and
    // either repeated every five minutes buries the lines that matter.
    const line = polled.retried === null ? null : retryLine(polled.retried);
    if (line !== null && line !== lastRetry) console.log(line);
    lastRetry = line;
    if (polled.verdict.work) {
      console.log(workLine(polled.verdict));
      return;
    }
    const wait =
      polled.verdict.rateLimited === true
        ? throttleWaitSeconds(polled.verdict.retryAfterSeconds ?? null)
        : jittered(interval);
    console.log(waitingLine(polled.verdict, { poll: count, waitingSince, now: new Date(), waitSeconds: wait }));
    // No sleep here: the supervisor re-reads its unread secrets (#759), then runs the gate again.
    if (secretRereadDue(process.env, count)) {
      console.log(secretRereadLine(PREFIX, wait, count));
      return;
    }
    const woke = await sleepInSlices(wait, slice, () => {
      if (supervisorGone(supervisorPid)) return "orphaned" as const;
      return hasPendingControl(root) ? ("control" as const) : null;
    });
    if (woke === "orphaned") {
      console.log(`${PREFIX}: supervisor ${supervisorPid} is gone — stopping.`);
      return;
    }
    if (woke === "control") {
      console.log(CONTROL_PENDING_LINE);
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
