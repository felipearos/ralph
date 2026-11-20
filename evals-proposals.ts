/**
 * The improver's proposals CLI (#874): list every proposal with where it
 * stands. The dashboard shells out to it and never imports it.
 *
 * `list` first advances the proposals: a subset run that finished promising
 * earns its one full-set recommendation here, so the page that shows the
 * proposal is also what moves it on. A failed advance is a problem printed
 * beside the rows, never a failed list.
 *
 * Rows carry the rationale and answers only on a project that relays eval
 * patches (`relayEvalPatches`), as `evals-set.ts view` does for reason and
 * notes; never the content, overlay paths or diffs.
 *
 * `open-pr <proposal-id>` opens the PR a passed proposal stands for (#875).
 * It recomputes the proposal's state on this machine rather than trusting
 * the page that asked, and opens nothing unless that state is "passed". It
 * never advances: opening a PR must not also recommend runs.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { improverAutoMerge } from "./eval-improver";
import { openProposalPr, type OpenedProposalPr, type OpenProposalPrInput } from "./eval-open-pr";
import { advanceProposals, proposalStatus, proposalView, proposalViews, readProposals, realProposalDeps, type AdvanceDeps } from "./eval-proposals";
import { relaysPatches } from "./eval-runs";
import { RALPH_HOME, projectRoot } from "./paths";
import { loadProjectConfig, type ProjectConfig } from "./project-config";
import { buildRedactor } from "./runner-failure";
import type { Gh } from "./verifier/deploys";
import { realGit } from "./verifier/revert";

export interface EvalsProposalsDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  /** The readers and writers the advance and the status read go through. */
  advance: (project: string) => AdvanceDeps;
  /** Whether rows may carry rationale and answers. */
  details: (project: string) => boolean;
  /** Opens the PR for a proposal whose passed state this CLI just recomputed. */
  openPr: (input: OpenProposalPrInput) => Promise<OpenedProposalPr>;
  /** The project's config, read only to report `evalsImprover.autoMerge`. */
  config: (project: string) => Pick<ProjectConfig, "evalsImprover">;
}

const USAGE = "usage: evals-proposals.ts list [--project <path>] | open-pr <proposal-id> [--project <path>]";

class UsageError extends Error {}

const FLAGS: Record<string, readonly string[]> = {
  list: ["project"],
  "open-pr": ["project"],
};

/** `--flag value` pairs and positionals; an unknown flag or a missing value is a usage error, not a guess. */
function parseArgs(command: string, rest: string[]): { positional: string[]; flags: Map<string, string> } {
  const allowed = FLAGS[command] ?? [];
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown flag ${arg} for ${command}`);
    if (flags.has(name)) throw new UsageError(`${arg} given twice`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    flags.set(name, value);
    index += 1;
  }
  return { positional, flags };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Exit status: 0 listed or opened, 1 nothing could be read or no PR was opened, 64 bad usage. */
export async function runEvalsProposals(argv: string[], deps: EvalsProposalsDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || !(command in FLAGS)) throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
    const { positional, flags } = parseArgs(command, rest);
    if (command === "open-pr") {
      if (positional.length !== 1) throw new UsageError(positional.length === 0 ? "open-pr needs a proposal id" : "open-pr takes one proposal id");
      const project = resolve(flags.get("project") ?? projectRoot());
      try {
        return await openPr(positional[0]!, project, deps);
      } catch (error) {
        // Relayed to the remote page like list's problems: name files from the project or harness, never the host's paths.
        throw new Error(message(error).split(`${project}/`).join("").split(`${RALPH_HOME}/`).join("").split(tmpdir()).join("<tmp>"));
      }
    }
    if (positional.length > 0) throw new UsageError("list takes no arguments");
    const project = resolve(flags.get("project") ?? projectRoot());

    const advance = deps.advance(project);
    // Advance before reading, so the rows already show a full-set run it just recommended.
    const { problems } = await advanceProposals(project, advance);
    const read = readProposals(project);
    // advanceProposals read the same files under its lock: their problems are already in `problems`.
    for (const problem of read.problems) if (!problems.includes(problem)) problems.push(problem);
    const runs = advance.runs();
    // A hand-edited inbox that no longer parses must not hide every proposal: its read is a problem beside the rows.
    let inbox: ReturnType<typeof advance.readInbox> = [];
    try { inbox = advance.readInbox(project); } catch (error) {
      const said = `the inbox could not be read: ${message(error)}`;
      if (!problems.includes(said)) problems.push(said);
    }
    const details = deps.details(project);
    const rows = read.proposals.map((stored) =>
      proposalView(stored, proposalStatus(stored, runs, { readReport: advance.readReport, thresholds: advance.thresholds, inbox }), details));
    // The page relays these remotely: name files from the project, never the host's home, and redact as an error would be.
    const redact = buildRedactor();
    const shown = problems.map((problem) => redact(problem.split(`${project}/`).join("")));
    deps.out(JSON.stringify({ version: 1, details, proposals: proposalViews(rows), problems: shown }));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`evals-proposals: ${error.message}`);
      deps.err(USAGE);
      return 64;
    }
    deps.err(`evals-proposals: ${buildRedactor()(message(error))}`);
    return 1;
  }
}

async function openPr(id: string, project: string, deps: EvalsProposalsDeps): Promise<number> {
  const stored = readProposals(project).proposals.find((proposal) => proposal.id === id);
  if (stored === undefined) throw new Error(`no proposal ${id}`);
  const advance = deps.advance(project);
  const runs = advance.runs();
  // Recomputed here, never taken from the page: a stale or forged "passed" must not open a PR.
  const state = proposalStatus(stored, runs, { readReport: advance.readReport, thresholds: advance.thresholds, inbox: advance.readInbox(project) });
  if (state.status !== "passed") throw new Error(`proposal ${id} is ${state.status}: only a passed proposal opens a PR`);
  const run = runs.find((entry) => entry.id === state.runs.full);
  if (run === undefined) throw new Error(`proposal ${id}'s full-set run ${state.runs.full ?? "(none)"} is not among the runs`);
  // Reported, never acted on: no merge path exists, so a person merges whatever the switch says until a later ticket wires it.
  const autoMerge = improverAutoMerge(deps.config(project));
  const opened = await deps.openPr({ proposal: stored, state, run });
  deps.out(JSON.stringify({ version: 1, kind: opened.kind, number: opened.number, url: opened.url, proposal: id, autoMerge }));
  return 0;
}

/** gh in the harness repo, bounded like `realGit` so a hung call is a failed open rather than a hung page. */
const harnessGh: Gh = (args) =>
  new Promise((done) => {
    execFile("gh", args, { cwd: RALPH_HOME, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: error === null, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
    });
  });

export function realEvalsProposalsDeps(): EvalsProposalsDeps {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    advance: (project) => realProposalDeps(project),
    details: (project) => relaysPatches(project),
    // The PR changes the harness's own prompts or lineup, so it goes to ralph itself (RALPH_HOME, base main), never to the loop's project.
    openPr: (input) => openProposalPr({ git: realGit, gh: harnessGh, harnessRoot: RALPH_HOME, baseBranch: "main" }, input),
    config: (project) => loadProjectConfig(project),
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await runEvalsProposals(process.argv.slice(2), realEvalsProposalsDeps());
  } catch (error) {
    console.error(`evals-proposals: ${buildRedactor()(String(error))}`);
    process.exitCode = 1;
  }
}
