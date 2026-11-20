#!/usr/bin/env bun
/**
 * The claim's other end: how a pr-medic iteration reads the pull request it
 * holds and lets go of it.
 *
 * The intake gate (`pr-medic/gate.ts`) claims an operator's pull request with
 * `<loop>-wip` and leaves the release to the iteration — `-done` at green,
 * `-blocked` when it is stuck or past `prMedic.maxPushes`. Those writes land
 * on somebody else's pull request, so they are made HERE rather than as raw
 * `gh pr edit` lines in the prompt: each re-reads the pull request first, and
 * refuses the write the reading does not support.
 *
 *   bun pr-medic/case.ts status  <pr> [--json]
 *   bun pr-medic/case.ts done    <pr> --comment-file <f>
 *   bun pr-medic/case.ts blocked <pr> --comment-file <f>
 *   bun pr-medic/case.ts handoff <pr> --comment-file <f>
 *   bun pr-medic/case.ts drop    <pr>
 *   bun pr-medic/case.ts handback <pr>
 *
 * - `status` writes nothing: the head, the base, the merge state, the red and
 *   pending required checks, the medic pushes since the operator's last
 *   (`gate.ts`'s `medicPushes`, the count the cap is held to) and the claim.
 * - `done` is the green handover. It refuses unless every required check on
 *   the head is green, none is still running, and GitHub does not call the
 *   branch conflicting — "green, ready for you to merge" on a red head is the
 *   one comment worse than none. Then it comments and swaps `-wip` for
 *   `-done`. It never merges, enqueues or approves anything: nothing here can.
 * - `blocked` is the stuck path. The comment's first line must start
 *   `blocked:`, which is the line the dashboard reads. Then `-wip` → `-blocked`,
 *   which the gate reads as "never offer this pull request again" until a
 *   human lifts it.
 * - `handoff` is the red that is not the branch's: a confirmed flake or an
 *   open infrastructure incident, which is the ci-doctor's. It comments which
 *   case it is and drops `-wip`, and labels nothing — the pull request is left
 *   as the operator had it. The gate's own known-red reading keeps such a red
 *   from being handed over again; where it cannot, `status` reports the
 *   handoff already said on this head (`handed`), so the next iteration ends
 *   at once instead of saying it twice.
 * - `drop` removes this loop's `-wip` and nothing else, with no comment: for a
 *   pull request that was closed, merged or turned back into a draft under the
 *   medic, which is no longer the medic's to say anything on.
 * - `handback` is for an ADOPTED pull request — an unattended roster loop's
 *   red branch the gate claimed for this medic (#425) — whose owner is back.
 *   It says so once (`adoption.ts`'s `handbackComment`), drops `-wip`, labels
 *   nothing and pushes nothing, so the owner resumes its own branch.
 *
 * Every ending releases the ticket's claim lease the gate took when it
 * adopted a loop's pull request; an operator's pull request holds none.
 *
 * Each write is safe to run twice. A comment carries a marker naming the loop,
 * the verb and the head, and is not posted again for that head; a label
 * already swapped is left as it is.
 *
 * Exit: 0 done (or nothing to do), 1 git or gh could not be asked, 3 refused —
 * the reading does not support the write, or this loop is not a medic — 64 bad
 * usage, 75 GitHub throttled.
 *
 * felipearos/ralph#248
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { classifyRateLimit, RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
import { projectRoot } from "../paths";
import { PR_MEDIC_DEFAULTS, loadProjectConfig } from "../project-config";
import { leasePathFromGit } from "../claim-lease";
import { handbackComment, releaseAdoptedLease, said as saidOn, ticketOf } from "./adoption";
import { agentOwner, checksOf, conflicting, labelsOf, medicPushes, type OperatorPr } from "./gate";

const PREFIX = "pr-medic/case";

export const REFUSED_EXIT = 3;
export const USAGE_EXIT = 64;

/** The marker a medic comment ends with, so a second run does not post it again. */
export const marker = (verb: "done" | "blocked" | "handoff" | "adopt" | "handback", loop: string, head: string): string =>
  `<!-- pr-medic:${verb} ${loop} ${head} -->`;

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CaseDeps {
  gh(args: string[]): Ran;
  read(path: string): string;
  /** Release this run's claim lease on an adopted ticket. False when nothing was held. */
  releaseLease(issue: number): boolean;
}

/** What the tool needs to know about the project, read once from its config. */
export interface CaseProject {
  repo: string;
  requiredChecks: readonly string[];
  maxPushes: number;
  /** The roster's pr-medic loops. */
  medics: readonly string[];
  /** Every roster loop: a branch under one's `<loop>/` prefix is that loop's, adopted. */
  loops: readonly string[];
}

/** One pull request, as `gh pr view --json $VIEW_FIELDS` returns it. */
export interface CaseView extends OperatorPr {
  state: string;
  baseRefName: string;
  comments?: { body?: string }[];
}

export const VIEW_FIELDS =
  "number,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,labels,statusCheckRollup,commits,comments";

/** `green`, `red`, `conflicting`, `pending`, `draft` or `closed`: where the pull request stands, in that precedence reversed. */
export type Standing = "closed" | "draft" | "conflicting" | "red" | "pending" | "green";

export interface Reading {
  pr: number;
  state: string;
  draft: boolean;
  branch: string;
  base: string;
  head: string;
  merge: string;
  red: string[];
  pending: string[];
  pushes: number;
  maxPushes: number;
  /** This loop's own labels on the pull request: `-wip`, `-blocked`, `-done`. */
  claim: string[];
  /** Whether this loop already handed this head's red to the doctor (`handoff`). */
  handed: boolean;
  standing: Standing;
}

/** The pull request read against the project's required checks and push cap. Pure. */
export function reading(view: CaseView, project: CaseProject, loop: string): Reading {
  const { red, pending } = checksOf(view, project.requiredChecks);
  const labels = labelsOf(view);
  const standing: Standing =
    view.state !== "OPEN"
      ? "closed"
      : view.isDraft
        ? "draft"
        : conflicting(view)
          ? "conflicting"
          : red.length > 0
            ? "red"
            : pending.length > 0
              ? "pending"
              : "green";
  return {
    pr: view.number,
    state: view.state,
    draft: view.isDraft,
    branch: view.headRefName,
    base: view.baseRefName,
    head: view.headRefOid,
    merge: view.mergeStateStatus ?? "UNKNOWN",
    red,
    pending,
    pushes: medicPushes(view),
    maxPushes: project.maxPushes,
    claim: ["wip", "blocked", "done"].map((suffix) => `${loop}-${suffix}`).filter((label) => labels.includes(label)),
    handed: (view.comments ?? []).some((comment) => (comment.body ?? "").includes(marker("handoff", loop, view.headRefOid))),
    standing,
  };
}

const list = (names: readonly string[]): string => (names.length === 0 ? "none" : names.join(", "));

/** The human-readable `status`, one fact a line. */
export function statusLines(r: Reading): string[] {
  return [
    `${PREFIX}: #${r.pr} is ${r.standing} — ${r.branch} onto ${r.base}`,
    `  head:    ${r.head}`,
    `  merge:   ${r.merge}`,
    `  red:     ${list(r.red)}`,
    `  pending: ${list(r.pending)}`,
    `  pushes:  ${r.pushes} of ${r.maxPushes} medic pushes since the operator's last`,
    `  claim:   ${list(r.claim)}`,
    `  handed:  ${r.handed ? "yes — this head's red was already handed to the ci-doctor" : "no"}`,
  ];
}

export type Verb = "status" | "done" | "blocked" | "handoff" | "drop" | "handback";

export interface CaseRequest {
  verb: Verb;
  pr: number;
  loop: string;
  /** The comment's body, for `done`, `blocked` and `handoff`. */
  comment?: string;
  json?: boolean;
}

export interface Verdict {
  exit: number;
  lines: string[];
}

/** Every reason the reading does not support `verb`. Empty means it does. */
export function refusals(
  verb: Exclude<Verb, "status">,
  r: Reading,
  loop: string,
  comment: string | undefined,
  owner: string | null = null,
  handedBack = false,
): string[] {
  const problems: string[] = [];
  const holds = r.claim.includes(`${loop}-wip`);
  if (verb === "drop") return problems;
  if (r.standing === "closed") problems.push(`it is ${r.state.toLowerCase()}; drop the claim instead — nothing more is said on it`);
  if (r.standing === "draft") problems.push("it is a draft, which the medic never touches; drop the claim instead");
  if (verb === "done") {
    if (r.standing === "conflicting") problems.push("GitHub calls the branch conflicting (DIRTY), so it is not ready to merge");
    if (r.red.length > 0) problems.push(`required checks are red on ${r.head.slice(0, 12)}: ${r.red.join(", ")}`);
    if (r.pending.length > 0) problems.push(`required checks are still running on ${r.head.slice(0, 12)}: ${r.pending.join(", ")}`);
  }
  if (verb === "blocked" && !(comment ?? "").trimStart().startsWith("blocked:")) {
    problems.push("the comment's first line must start `blocked:` — it is the line the dashboard reads");
  }
  if (verb === "handback" && owner === null) {
    problems.push(`${r.branch} is no roster loop's branch, so there is no owner to hand it back to`);
  }
  const released = verb === "handoff" ? r.handed : verb === "handback" ? handedBack : r.claim.includes(`${loop}-${verb}`);
  if (!holds && !released) {
    problems.push(`it carries no ${loop}-wip, so it is not this loop's claim to release`);
  }
  return problems;
}

function throttledOrThrow(ran: Ran, what: string): Verdict {
  const message = `${ran.stderr}\n${ran.stdout}`.trim();
  if (classifyRateLimit(message) !== null) return { exit: RATE_LIMITED_EXIT, lines: [`${PREFIX}: GitHub throttled ${what}: ${message}`] };
  throw new Error(`${what} failed: ${message || `exit ${ran.status}`}`);
}

/** The whole tool. Throws only when gh could not be asked at all. */
export function run(deps: CaseDeps, project: CaseProject, request: CaseRequest): Verdict {
  const { loop, pr } = request;
  if (!project.medics.includes(loop)) {
    return {
      exit: REFUSED_EXIT,
      lines: [`${PREFIX}: '${loop}' is not a pr-medic on this project's roster (${project.medics.length === 0 ? "it has none" : project.medics.join(", ")})`],
    };
  }
  const view = deps.gh(["pr", "view", String(pr), "--repo", project.repo, "--json", VIEW_FIELDS]);
  if (view.status !== 0) return throttledOrThrow(view, `reading #${pr}`);
  const pulled = JSON.parse(view.stdout) as CaseView;
  const r = reading(pulled, project, loop);

  if (request.verb === "status") {
    return { exit: 0, lines: request.json === true ? [JSON.stringify(r)] : statusLines(r) };
  }

  const verb = request.verb;
  const owner = agentOwner(r.branch, project.loops);
  const handedBack = saidOn(pulled.comments, marker("handback", loop, r.head));
  const problems = refusals(verb, r, loop, request.comment, owner, handedBack);
  if (problems.length > 0) {
    return { exit: REFUSED_EXIT, lines: [`${PREFIX}: refused ${verb} on #${pr}:`, ...problems.map((problem) => `  - ${problem}`)] };
  }

  // Only once the labels say the case is over: a write that failed leaves
  // the claim, and the lease that fences the ticket, held for the next run.
  const ticket = owner === null ? null : ticketOf(r.branch, owner);
  const release = (): string => (ticket !== null && deps.releaseLease(ticket) ? `; lease on #${ticket} released` : "");

  const wip = `${loop}-wip`;
  if (verb === "drop") {
    if (!r.claim.includes(wip)) return { exit: 0, lines: [`${PREFIX}: nothing to drop — #${pr} carries no ${wip}${release()}.`] };
    const edited = deps.gh(["pr", "edit", String(pr), "--repo", project.repo, "--remove-label", wip]);
    if (edited.status !== 0) return throttledOrThrow(edited, `removing ${wip} from #${pr}`);
    return { exit: 0, lines: [`${PREFIX}: dropped ${wip} from #${pr}${release()}.`] };
  }

  if (verb === "handback") {
    // `refusals` refused a branch with no owner, so `owner` is set here.
    const back = owner ?? "its owner";
    if (!handedBack) {
      const body = `${handbackComment({ medic: loop, owner: back, head: r.head })}\n`;
      const commented = deps.gh(["pr", "comment", String(pr), "--repo", project.repo, "--body", body]);
      if (commented.status !== 0) return throttledOrThrow(commented, `commenting on #${pr}`);
    }
    if (r.claim.includes(wip)) {
      const edited = deps.gh(["pr", "edit", String(pr), "--repo", project.repo, "--remove-label", wip]);
      if (edited.status !== 0) return throttledOrThrow(edited, `removing ${wip} from #${pr}`);
    }
    return {
      exit: 0,
      lines: [`${PREFIX}: #${pr} handed back to ${back} at ${r.head.slice(0, 12)}; ${wip} dropped${handedBack ? " (its comment was already there)" : ""}${release()}.`],
    };
  }

  // The comment first, then the labels: a run that stops between the two
  // leaves the claim held, so the next iteration resumes it and this command
  // finishes the swap without saying it twice.
  const mark = marker(verb, loop, r.head);
  const said = (pulled.comments ?? []).some((comment) => (comment.body ?? "").includes(mark));
  if (!said) {
    const body = `${(request.comment ?? "").trimEnd()}\n\n${mark}\n`;
    const commented = deps.gh(["pr", "comment", String(pr), "--repo", project.repo, "--body", body]);
    if (commented.status !== 0) return throttledOrThrow(commented, `commenting on #${pr}`);
  }
  if (verb === "handoff") {
    if (r.claim.includes(wip)) {
      const edited = deps.gh(["pr", "edit", String(pr), "--repo", project.repo, "--remove-label", wip]);
      if (edited.status !== 0) return throttledOrThrow(edited, `removing ${wip} from #${pr}`);
    }
    return {
      exit: 0,
      lines: [`${PREFIX}: #${pr}'s red at ${r.head.slice(0, 12)} handed to the ci-doctor; ${wip} dropped${said ? " (its comment was already there)" : ""}${release()}.`],
    };
  }
  const target = `${loop}-${verb}`;
  if (r.claim.includes(wip) || !r.claim.includes(target)) {
    const args = ["pr", "edit", String(pr), "--repo", project.repo, "--add-label", target];
    if (r.claim.includes(wip)) args.push("--remove-label", wip);
    const edited = deps.gh(args);
    if (edited.status !== 0) return throttledOrThrow(edited, `labelling #${pr} ${target}`);
  }
  return {
    exit: 0,
    lines: [`${PREFIX}: #${pr} released to ${target} at ${r.head.slice(0, 12)}${said ? " (its comment was already there)" : ""}${release()}.`],
  };
}

/** The project as this tool reads it. */
export function caseProject(root: string): CaseProject {
  const config = loadProjectConfig(root);
  return {
    repo: config.repo,
    requiredChecks: config.requiredChecks,
    maxPushes: config.prMedic?.maxPushes ?? PR_MEDIC_DEFAULTS.maxPushes,
    medics: config.roster.filter((entry) => entry.role === "pr-medic").map((entry) => entry.name),
    loops: config.roster.map((entry) => entry.name),
  };
}

const USAGE = [
  "usage: bun pr-medic/case.ts status  <pr> [--json]",
  "       bun pr-medic/case.ts done    <pr> --comment-file <f>",
  "       bun pr-medic/case.ts blocked <pr> --comment-file <f>",
  "       bun pr-medic/case.ts handoff <pr> --comment-file <f>",
  "       bun pr-medic/case.ts drop    <pr>",
  "       bun pr-medic/case.ts handback <pr>",
].join("\n");

export function parseArgs(argv: readonly string[]): { verb: Verb; pr: number; commentFile: string | null; json: boolean } | null {
  const [verb, ...rest] = argv;
  if (verb !== "status" && verb !== "done" && verb !== "blocked" && verb !== "handoff" && verb !== "drop" && verb !== "handback") return null;
  let pr: number | null = null;
  let commentFile: string | null = null;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--comment-file" && rest[index + 1] !== undefined) {
      commentFile = rest[index + 1] as string;
      index += 1;
    } else if (arg === "--json" && verb === "status") {
      json = true;
    } else if (/^[1-9]\d*$/.test(arg) && pr === null) {
      pr = Number(arg);
    } else {
      return null;
    }
  }
  if (pr === null) return null;
  const needsComment = verb === "done" || verb === "blocked" || verb === "handoff";
  if (needsComment !== (commentFile !== null)) return null;
  return { verb, pr, commentFile, json };
}

export function liveDeps(cwd: string, env: NodeJS.ProcessEnv = process.env): CaseDeps {
  return {
    gh: (args) => {
      const out = spawnSync("gh", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
      return { status: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? (out.error?.message ?? "") };
    },
    read: (path) => readFileSync(path, "utf8"),
    releaseLease: (issue) => {
      const run = env.RALPH_RUN_ID?.trim() ?? "";
      const loop = env.RALPH_LOOP_NAME?.trim() ?? "";
      if (run === "" || loop === "") return false;
      try {
        // A failed release is not this tool's to retry: the gate's record of
        // the adoption outlives the `-wip` this ending removed, and the gate
        // releases again on its next poll.
        return releaseAdoptedLease(leasePathFromGit(cwd), issue, { run, loop }) === "released";
      } catch {
        return false;
      }
    },
  };
}

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd(), deps?: CaseDeps): number {
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    return USAGE_EXIT;
  }
  const loop = env.RALPH_LOOP_NAME?.trim() ?? "";
  const live = deps ?? liveDeps(cwd, env);
  try {
    let comment: string | undefined;
    if (args.commentFile !== null) {
      comment = live.read(args.commentFile);
      if (comment.trim() === "") {
        console.error(`${PREFIX}: ${args.commentFile} is empty; the comment is the whole value of the release`);
        return USAGE_EXIT;
      }
    }
    const verdict = run(live, caseProject(projectRoot(cwd, env)), { verb: args.verb, pr: args.pr, loop, comment, json: args.json });
    (verdict.exit === 0 ? console.log : console.error)(verdict.lines.join("\n"));
    return verdict.exit;
  } catch (error) {
    console.error(`${PREFIX}: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
