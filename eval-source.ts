/**
 * The single-PR source (#801): one case built from merged PRs an operator
 * names — the A/B on a PR. It freezes the case the way a clerk backtest does
 * (#532): the merge-base of the earliest-opened PR's first commit, and the
 * ticket's comments before that PR opened. The reference may be a person's
 * work or a loop's; either is what actually merged.
 */
import type { BacktestConfig, BacktestSample, BacktestTicket, BacktestTicketRead, GhPrView } from "./backtest";
import { backtestDeps, buildBacktestSample, configArms, isLoopPr, trackerTickets, viewPr } from "./backtest";
import { spawnGh, type GhRunner } from "./clerk/pulls";
import { buildSetSample, setSampleDeps } from "./eval-set-source";
import { fetchIssue } from "./issue-spec";
import { projectRosterEntries } from "./roster";
import { keyedProjectTracker } from "./tracker/project";
import type { Tracker } from "./tracker/types";

export interface PrSampleDeps {
  gh: GhRunner;
  loopNames: readonly string[];
  /** The ticket by its reference: `#12` is a GitHub issue of the source repo, `OA-12` a key of the project's tracker. */
  readTicket(ref: string): Promise<BacktestTicketRead>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The key the trial's local tracker files the ticket under: `OA-12` stays, GitHub's `#12` becomes `GH-12`. */
export function caseKey(ref: string): string {
  const github = /^#(\d+)$/.exec(ref);
  return github ? `GH-${github[1]}` : ref;
}

/**
 * The one-case sample of a PR source. Every refusal throws before any model
 * runs: a PR that is not merged, PRs in another repo, a ticket that cannot be
 * read or named.
 */
export async function buildPrSample(config: BacktestConfig, deps: PrSampleDeps): Promise<BacktestSample> {
  const source = config.source;
  if (source?.kind !== "pr") throw new Error("eval: the config names no PR source");
  const views: GhPrView[] = [];
  for (const number of source.prs) {
    let view: GhPrView;
    try { view = await viewPr(deps.gh, source.repo, number, `https://github.com/${source.repo}/pull/${number}`); }
    catch (error) { throw new Error(`eval: cannot read ${source.repo}#${number}: ${message(error)}`); }
    if (view.mergedAt === "") throw new Error(`eval: ${source.repo}#${number} is not merged; only merged work is a reference`);
    views.push(view);
  }
  const ms = (iso: string): number => Date.parse(iso) || 0;
  views.sort((a, b) => ms(a.mergedAt) - ms(b.mergedAt) || a.number - b.number);
  // Work began when the first PR was OPENED; every comment after it can describe the answer.
  const first = [...views].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.number - b.number)[0]!;

  let mergeBase: string;
  try {
    // From the PR's first commit, not its final head: a branch later updated
    // from the base would move the merge-base past work merged in between.
    const from = first.firstCommit || first.headRefOid;
    mergeBase = (await deps.gh(["api", `repos/${source.repo}/compare/${first.baseRefOid}...${from}`, "--jq", ".merge_base_commit.sha"])).trim();
  } catch (error) {
    throw new Error(`eval: no merge-base for ${source.repo}#${first.number}: ${message(error)}`);
  }
  if (mergeBase === "") throw new Error(`eval: no merge-base for ${source.repo}#${first.number}`);

  let ref = source.ticket;
  if (ref === null) {
    // The issue the PR closes: GitHub keeps the link even after the branch is gone.
    let closing: number[] = [];
    try {
      const out = JSON.parse(await deps.gh(["pr", "view", String(first.number), "--repo", source.repo, "--json", "closingIssuesReferences"])) as { closingIssuesReferences?: { number?: unknown }[] };
      closing = (out.closingIssuesReferences ?? []).map((issue) => issue.number).filter((n): n is number => typeof n === "number");
    } catch (error) {
      throw new Error(`eval: cannot read which issue ${source.repo}#${first.number} closes: ${message(error)}`);
    }
    if (closing.length !== 1) {
      throw new Error(`eval: ${source.repo}#${first.number} closes ${closing.length === 0 ? "no issue" : `${closing.length} issues`}; name the ticket it resolved as source.ticket`);
    }
    ref = `#${closing[0]}`;
  }
  const fetched = await deps.readTicket(ref);
  if (!fetched.ok) throw new Error(`eval: cannot read ticket ${ref}: ${fetched.reason}`);
  const cutoff = Date.parse(first.createdAt);
  const kept = fetched.comments.filter((comment) => Date.parse(comment.createdAt) < cutoff);
  const loop = views.filter((view) => isLoopPr(view, deps.loopNames)).length;

  const ticket: BacktestTicket = {
    kind: "coder", oaKey: caseKey(fetched.ref), intakeKey: null, movedAt: first.createdAt, repo: source.repo,
    humanPrs: views.map(({ number, url, createdAt, mergedAt, headRefName, firstCommit, headRefOid }) => ({ number, url, createdAt, mergedAt, headRefName, firstCommit, headRefOid })),
    mergeBase, startedAt: first.createdAt, ticketRef: fetched.ref,
    comments: { kept: kept.length, dropped: fetched.comments.length - kept.length },
    frozen: { title: fetched.title, body: fetched.body, comments: kept },
    reference: loop === 0 ? "person" : loop === views.length ? "loop" : "mixed",
  };
  const notes = ticket.reference === "person" ? [] : [`the reference is ${ticket.reference === "loop" ? "a loop's" : "partly a loop's"} merged work, not a person's`];
  return { tickets: [ticket], skipped: [], notes, arms: configArms(config) };
}

/** The real deps: `gh`, the project's roster for loop branches, and its tracker or GitHub for the ticket. */
export function prSampleDeps(config: BacktestConfig): PrSampleDeps {
  const source = config.source;
  if (source?.kind !== "pr") throw new Error("eval: the config names no PR source");
  const loopNames = [...new Set([...projectRosterEntries(config.project).map((entry) => entry.name), "ralph"])];
  return {
    gh: spawnGh,
    loopNames,
    async readTicket(ref) {
      const github = /^#(\d+)$/.exec(ref);
      if (github) {
        const fetched = fetchIssue(github[1]!, source.repo);
        if (!fetched.ok) return { ok: false, reason: fetched.error };
        return {
          ok: true, ref, title: fetched.issue.title, body: fetched.issue.body,
          comments: fetched.issue.comments.map((comment) => ({ author: comment.author?.login ?? null, createdAt: comment.createdAt, body: comment.body })),
        };
      }
      let tracker: Tracker | null;
      try { tracker = keyedProjectTracker(config.project); }
      catch (error) { return { ok: false, reason: `cannot open the project's tracker: ${message(error)}` }; }
      if (tracker === null) return { ok: false, reason: `${ref} is a tracker key, but this project's issues are on GitHub; name the issue as #<number>` };
      return trackerTickets(tracker).read(ref, null);
    },
  };
}

/** The sample a config replays: the test set's cases, the PRs its source names, or the clerk's moves. */
export async function sampleFor(config: BacktestConfig): Promise<BacktestSample> {
  if (config.source?.kind === "set") return buildSetSample(config, setSampleDeps(config));
  return config.source !== undefined
    ? buildPrSample(config, prSampleDeps(config))
    : buildBacktestSample(config, await backtestDeps(config));
}
