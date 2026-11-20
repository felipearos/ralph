/**
 * The recommended-runs inbox CLI (#872): list, add, start or dismiss eval run
 * plans waiting for the operator. The dashboard shells out to it and never
 * imports it.
 *
 * `add` takes a plan on stdin, as `experiments.ts start --json` does, and
 * stores it only when it passes a start's own checks. Only `start` runs a
 * plan: it takes the entry out first, so one recommendation launches one
 * run, and puts it back if the start is refused.
 */
import { userInfo } from "node:os";
import { resolve } from "node:path";

import { addEntry, inboxView, readInbox, removeEntry, restoreEntry } from "./eval-inbox";
import { checkStart, startRun } from "./eval-runs";
import { projectRoot } from "./paths";
import { buildRedactor } from "./runner-failure";

export interface EvalsInboxDeps {
  now: () => string;
  /** Who recommends when `--by` is not given: the loop's name, or the OS user. */
  user: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The plan on stdin, for `add`. */
  stdin: () => Promise<string>;
  /** Start a run of the plan; throws, with its reason, on one that would not start. Only `start` calls it. */
  start: (project: string, plan: Record<string, unknown>) => { id: string };
  /** Throws, in the plan parser's words, on a plan that would not run. */
  check: (project: string, plan: Record<string, unknown>) => void;
}

const USAGE = [
  "usage: evals-inbox.ts list [--project <path>]",
  "       evals-inbox.ts add --reason <text> [--by <name>] [--agent] [--project <path>]   (plan JSON on stdin)",
  "       evals-inbox.ts start <id> [--project <path>]",
  "       evals-inbox.ts dismiss <id> [--project <path>]",
].join("\n");

class UsageError extends Error {}

/** Flags that take no value. */
const SWITCHES = new Set(["agent"]);
const FLAGS: Record<string, readonly string[]> = {
  list: ["project"],
  add: ["project", "reason", "by", "agent"],
  start: ["project"],
  dismiss: ["project"],
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
    if (SWITCHES.has(name)) { flags.set(name, ""); continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
    flags.set(name, value);
    index += 1;
  }
  return { positional, flags };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Exit status: 0 done, 1 refused or failed, 64 bad usage. */
export async function runEvalsInbox(argv: string[], deps: EvalsInboxDeps): Promise<number> {
  const [command, ...rest] = argv;
  const print = (value: unknown) => deps.out(JSON.stringify(value));
  const refuse = (why: string): number => { deps.err(`evals-inbox: ${buildRedactor()(why)}`); return 1; };
  try {
    if (command === undefined || !(command in FLAGS)) throw new UsageError(command === undefined ? "no command" : `unknown command ${command}`);
    const { positional, flags } = parseArgs(command, rest);
    const project = resolve(flags.get("project") ?? projectRoot());

    if (command === "list") {
      if (positional.length > 0) throw new UsageError("list takes no arguments");
      print({ version: 1, entries: inboxView(readInbox(project)) });
      return 0;
    }

    if (command === "add") {
      if (positional.length > 0) throw new UsageError("add takes no arguments; the plan comes on stdin");
      const reason = flags.get("reason");
      if (reason === undefined || reason.trim() === "") throw new UsageError("add needs --reason <text>");
      const by = flags.get("by");
      if (by !== undefined && by.trim() === "") throw new UsageError("--by needs a name");
      let plan: unknown;
      try { plan = JSON.parse(await deps.stdin()); } catch (error) { return refuse(`the plan on stdin is not JSON: ${message(error)}`); }
      if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return refuse("the plan on stdin must be an object");
      const given = plan as Record<string, unknown>;
      // A recommendation the operator could not start is noise: refused before anything is stored.
      try { deps.check(project, given); } catch (error) { return refuse(message(error)); }
      const entry = await addEntry(project, {
        plan: given,
        recommendedBy: { kind: flags.has("agent") ? "agent" : "person", name: by ?? deps.user() },
        reason,
      }, deps.now());
      print({ version: 1, entry: inboxView([entry])[0] });
      return 0;
    }

    if (positional.length !== 1) throw new UsageError(`${command} takes one inbox entry id`);
    const id = positional[0]!;

    if (command === "start") {
      // The entry is taken out before the run starts, under the inbox's lock:
      // a second Start of the same row (the local and the remote page both
      // offer one) finds nothing, so one recommendation launches one run, and
      // a run that started is never reported as not started by a later write.
      const entry = await removeEntry(project, id);
      if (entry === null) return refuse(`no inbox entry ${id}`);
      let run: { id: string };
      try { run = deps.start(project, entry.plan); } catch (error) {
        // A refused start puts the entry back: the recommendation is still the operator's to decide on.
        try { await restoreEntry(project, entry); } catch (restore) {
          return refuse(`${message(error)}; the entry could not be put back (${message(restore)})`);
        }
        return refuse(message(error));
      }
      print({ version: 1, run: { id: run.id }, removed: entry.id });
      return 0;
    }

    // dismiss
    const removed = await removeEntry(project, id);
    if (removed === null) return refuse(`no inbox entry ${id}`);
    print({ version: 1, removed: removed.id });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.err(`evals-inbox: ${error.message}`);
      deps.err(USAGE);
      return 64;
    }
    return refuse(message(error));
  }
}

export function realEvalsInboxDeps(): EvalsInboxDeps {
  return {
    now: () => new Date().toISOString(),
    user: () => process.env.RALPH_LOOP_NAME?.trim() || userInfo().username,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    stdin: () => Bun.stdin.text(),
    start: (project, plan) => startRun(project, plan),
    check: (project, plan) => { checkStart(project, plan); },
  };
}

if (import.meta.main) {
  try {
    process.exitCode = await runEvalsInbox(process.argv.slice(2), realEvalsInboxDeps());
  } catch (error) {
    console.error(`evals-inbox: ${buildRedactor()(String(error))}`);
    process.exitCode = 1;
  }
}
