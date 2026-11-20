/**
 * The test set as an eval source (#854): the cases committed under
 * `evals/<projectId>/` (`evals-set.ts`) become the sample the existing engine
 * runs, so a run of the set needs no seam of its own. A selected case that
 * cannot run here is reported as skipped with its reason, never dropped.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { configArms, type BacktestConfig, type BacktestSample, type BacktestSkip, type BacktestTicket, type SetSource } from "./backtest";
import { GIT_TIMEOUT_MS } from "./backtest-score";
import { spawnGh } from "./clerk/pulls";
import { readSet, type EvalCase } from "./evals-set";
import { projectIdFor } from "./project-id";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The cases a set source selects, in the order given. A retired case never
 * runs; a saturated one still does — it is kept to catch a regression. A case
 * passes the tag filter on ANY of its tags; with a subset, only listed ids pass.
 */
export function selectCases(cases: readonly EvalCase[], source: Pick<SetSource, "tags" | "cases">): EvalCase[] {
  const tags = new Set(source.tags);
  const ids = new Set(source.cases);
  return cases.filter((c) => c.status !== "retired"
    && (tags.size === 0 || c.tags.some((tag) => tags.has(tag)))
    && (ids.size === 0 || ids.has(c.id)));
}

/**
 * The ticket a trial replays for a case: the inverse of `caseFromTicket`.
 * The graded-only fields stay off it, since a trial is given the ticket.
 */
export function ticketOfCase(c: EvalCase): BacktestTicket {
  return {
    oaKey: c.id, intakeKey: null, movedAt: c.startedAt, repo: c.repo,
    humanPrs: c.prs.map((pr) => ({ ...pr })),
    mergeBase: c.baseCommit, startedAt: c.startedAt, ticketRef: c.ticket.ref,
    comments: { kept: c.ticket.comments.length, dropped: c.ticket.dropped },
    frozen: { title: c.ticket.title, body: c.ticket.body, comments: c.ticket.comments.map((comment) => ({ ...comment })) },
    kind: c.kind,
    reference: c.reference,
  };
}

/** The checkout named for a repo; GitHub's owner/name is case-insensitive, and a case may spell it otherwise than the config. */
function checkoutOf(sources: Record<string, string>, repo: string): string | undefined {
  if (sources[repo] !== undefined) return sources[repo];
  const key = Object.keys(sources).find((name) => name.toLowerCase() === repo.toLowerCase());
  return key === undefined ? undefined : sources[key];
}

export interface SetSampleDeps {
  readSet(): { version: string | null; cases: EvalCase[] };
  /** Why the case cannot run on this host, or null when it can. */
  unrunnable(c: EvalCase, checkout: string | undefined): Promise<string | null>;
}

/**
 * The sample of a set source. An unreadable set throws (a refused run, never
 * a smaller one), and so does an empty selection: a filter that matches
 * nothing is a mistake, not an empty answer.
 */
export async function buildSetSample(config: BacktestConfig, deps: SetSampleDeps): Promise<BacktestSample> {
  const source = config.source;
  if (source?.kind !== "set") throw new Error("eval: the config names no test set source");
  const set = deps.readSet();
  const selected = selectCases(set.cases, source);
  if (selected.length === 0) {
    const filter = [
      source.tags.length === 0 ? null : `tags ${source.tags.join(", ")}`,
      source.cases.length === 0 ? null : `cases ${source.cases.join(", ")}`,
    ].filter((part): part is string => part !== null);
    throw new Error(`eval: the test set selects no case${filter.length === 0 ? " (it has no active or saturated case)" : ` for ${filter.join(" and ")}`}`);
  }
  const tickets: BacktestTicket[] = [];
  const skipped: BacktestSkip[] = [];
  for (const c of selected) {
    let reason: string | null;
    try { reason = await deps.unrunnable(c, checkoutOf(config.sources, c.repo)); }
    catch (error) { reason = message(error); }
    if (reason === null) tickets.push(ticketOfCase(c));
    else skipped.push({ oaKey: c.id, intakeKey: null, reason });
  }
  // A hand-picked id the set no longer offers is said, not dropped: the operator picked it.
  const offered = new Map(set.cases.map((c) => [c.id, c]));
  const missing = source.cases.filter((id) => !selected.some((c) => c.id === id) && (offered.get(id)?.status === "retired" || !offered.has(id)));
  for (const id of missing) skipped.push({ oaKey: id, intakeKey: null, reason: offered.has(id) ? "the case is retired" : "the case is not in the test set" });
  const notes = skipped.length === 0 ? [] : [`${skipped.length} selected case${skipped.length === 1 ? "" : "s"} cannot run; see Unrunnable`];
  // A case's check grades it when no held-out test does (#855), so the report must know which carry one.
  // Left out when none does: a reader takes an absent list as empty.
  // The same test as the Test set screen's grader label (evals-set.ts setView), so the two agree.
  const checked = selected.filter((c) => c.check !== undefined);
  const checks = checked.map((c) => c.id);
  // Scoring runs each check on every agent arm (#857): only the test or command
  // travels, never who accepted it, and the sample is scoring's input, not a trial's.
  const checkRuns = Object.fromEntries(checked.map((c) => [c.id, "test" in c.check! ? { test: c.check!.test } : { command: c.check!.command }]));
  return {
    tickets, skipped, notes, arms: configArms(config),
    set: { version: set.version, selected: selected.map((c) => c.id), ...(checks.length === 0 ? {} : { checks, checkRuns }) },
  };
}

/** The real deps: the project's set in ralph's repo, a checkout per repo from `sources`, and `gh` for each PR. */
export function setSampleDeps(config: BacktestConfig): SetSampleDeps {
  return {
    readSet: () => readSet(projectIdFor(config.project).id),
    async unrunnable(c, checkout) {
      if (checkout === undefined) return `no checkout of ${c.repo} on this host`;
      if (!existsSync(checkout)) return `the checkout of ${c.repo} at ${checkout} does not exist`;
      const git = spawnSync("git", ["-C", checkout, "cat-file", "-e", `${c.baseCommit}^{commit}`], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
      if (git.status !== 0) return `base commit ${c.baseCommit} is not in ${checkout}`;
      for (const pr of c.prs) {
        try { await spawnGh(["pr", "view", String(pr.number), "--repo", c.repo, "--json", "mergedAt"]); }
        catch (error) { return `cannot read ${c.repo}#${pr.number}: ${message(error)}`; }
      }
      return null;
    },
  };
}
