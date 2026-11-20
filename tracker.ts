#!/usr/bin/env bun
/**
 * tracker.ts — the project's issue tracker, for bash and the prompts
 * (felipearos/ralph#330).
 *
 * The one issue interface outside TypeScript: `ralph.sh`, the coder prompts and
 * the dashboard run this instead of `gh issue`, so the same instruction works
 * on a project whose tickets live in GitHub issues, Linear or Jira. It loads
 * the project's config from the current checkout and, for Linear or Jira, the
 * host-side credential itself; the caller never handles a token.
 *
 *   bun tracker.ts list [--limit <n>] [--json]  open issues: ref, title, labels, assignees, one per line
 *                                           (--json: `gh issue list`'s number,title,labels shape)
 *   bun tracker.ts view <n> [--json]        the issue, its labels and every comment
 *   bun tracker.ts comment <n> --body <text> | --body-file <path|->
 *   bun tracker.ts label add|remove <n> <label>...
 *   bun tracker.ts claimed [--loop <name>]  open issues carrying <loop>-wip, one number per line
 *   bun tracker.ts done <n> [--loop <name>] [--pr <url>]     close it, drop its *-wip, add <loop>-done
 *   bun tracker.ts handoff <n> [--loop <name>] [--pr <url>]  leave it open for a person to merge: drop its *-wip and
 *                                                            ready-for-agent, add <loop>-done, move it to the review state
 *   bun tracker.ts blocked <n> [--loop <name>]  drop its *-wip, add <loop>-blocked; then park it as
 *                                           .ralph/logs/block-park.json says, if the session wrote one (#776)
 *   bun tracker.ts ref <n>                  #184, AND-184, OA-410
 *   bun tracker.ts pr-ref <n>               the line a PR body carries for the ticket
 *   bun tracker.ts url <n>
 *   bun tracker.ts connect-test             stdin: {kind, token…, team|project?}; prints what the token can see
 *   bun tracker.ts connect-save --project <id>   stdin: the credential; writes it 0600 on this host
 *
 * The two connect commands are the dashboard's Tracker connector (#338). They
 * read the token from stdin, so it is in no argv and no log, and they need no
 * project checkout: the connector runs them before the project has a tracker.
 *
 * Output is plain and stable, for a model and for `ralph.sh` alike. Exit
 * status: 0 done, 1 failed, 2 usage, 69 tracker not connected (no credential,
 * or no adapter for its kind), 75 throttled (`RATE_LIMITED_EXIT`). A caller
 * that only does bookkeeping treats every non-zero as "no answer" and goes on.
 *
 * `done`, `handoff`, `blocked` and removing this loop's `<loop>-wip` also
 * append to the speed ledger (`speed.ts`, #578), after the tracker write
 * succeeded; `--pr` is the PR that ticket is carried as.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defaultNotify } from "./backoff";
import { recordBlockPark, type BlockParkDeps } from "./block-park";
import { RATE_LIMITED_EXIT, isRateLimited } from "./frontier/github-rate-limit";
import { READY_LABEL, currentLoop, doneLabelFor, stuckLabelFor, wipLabelFor } from "./frontier/next-tasks";
import { projectRoot } from "./paths";
import { configuredParkStorePath } from "./park-store";
import { recordSpeedEvent, type RecordFields, type SpeedKind } from "./speed";
import { loadProjectConfig } from "./project-config";
import { currentProjectId } from "./project-id";
import { testConnection, parseConnectRequest } from "./tracker/connect";
import { credentialProblem, writeCredential, type TrackerCredential } from "./tracker/credentials";
import { createTracker } from "./tracker/index";
import { TrackerUnavailableError, type Tracker } from "./tracker/types";

export const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 69, throttled: RATE_LIMITED_EXIT } as const;

const USAGE = `usage:
  tracker.ts list [--limit <n>] [--json]
  tracker.ts view <n> [--json]
  tracker.ts comment <n> --body <text> | --body-file <path|->
  tracker.ts label add|remove <n> <label>...
  tracker.ts claimed [--loop <name>]
  tracker.ts done <n> [--loop <name>] [--pr <url>]
  tracker.ts handoff <n> [--loop <name>] [--pr <url>]
  tracker.ts blocked <n> [--loop <name>]
  tracker.ts ref <n>
  tracker.ts pr-ref <n>
  tracker.ts url <n>
  tracker.ts connect-test < request.json
  tracker.ts connect-save --project <id> < credential.json`;

export interface CliDeps {
  /** The project's tracker; built from the checkout's config when omitted. */
  tracker?: () => Tracker;
  /** This loop's name; `currentLoop()` when omitted. */
  loop?: () => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  readFile?: (path: string) => string;
  /** The connect commands' stdin. */
  readStdin?: () => string;
  /** The connect test's network. */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /**
   * Appends to the speed ledger once a claim's tracker write succeeded. Absent
   * means nothing is recorded, so an in-process test writes no ledger.
   */
  speed?: (kind: SpeedKind, fields: RecordFields) => void;
  /**
   * Where `blocked` finds the session's park hand-off and records it. Absent
   * means no park handling at all, so an in-process test never reads or
   * writes the host's park store. A thunk, so only `blocked` pays for the
   * git reads that resolve the paths: `connect-test` runs with no checkout.
   */
  blockPark?: () => Omit<BlockParkDeps, "log">;
}

class UsageError extends Error {}

const issueNumber = (raw: string | undefined): number => {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) throw new UsageError(`expected an issue number, got ${JSON.stringify(raw ?? "")}`);
  return Number(raw);
};

/** `--name value` out of `args`, which is left with the positional words. */
function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) throw new UsageError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function onlyPositional(args: string[], count: number, what: string): void {
  const flag = args.find((arg) => arg.startsWith("--"));
  if (flag !== undefined) throw new UsageError(`unknown flag ${flag}`);
  if (args.length !== count) throw new UsageError(what);
}

function defaultTracker(): Tracker {
  const root = projectRoot();
  return createTracker(loadProjectConfig(root), { projectId: currentProjectId(root) });
}

/** The connect commands' JSON request; unreadable stdin is the same refusal as a malformed one. */
function readJsonStdin(deps: CliDeps): unknown {
  try {
    return JSON.parse((deps.readStdin ?? (() => readFileSync(0, "utf8")))());
  } catch {
    return null;
  }
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const [command, ...args] = argv;
  try {
    const tracker = (): Tracker => (deps.tracker ?? defaultTracker)();
    const loopOf = (): string => takeFlag(args, "--loop") ?? (deps.loop ?? (() => currentLoop()))();
    // Bookkeeping about a write that already happened: a recorder that throws
    // must not turn a done ticket into a failed command the caller retries.
    const recordSpeed = (kind: SpeedKind, fields: () => RecordFields | null): void => {
      if (deps.speed === undefined) return;
      try {
        const resolved = fields();
        if (resolved !== null) deps.speed(kind, resolved);
      } catch {
        // swallowed on purpose; see above
      }
    };
    switch (command) {
      case "list": {
        const raw = takeFlag(args, "--limit");
        const json = args.includes("--json");
        if (json) args.splice(args.indexOf("--json"), 1);
        onlyPositional(args, 0, "list takes no issue number");
        const limit = raw === undefined ? 100 : issueNumber(raw);
        const t = tracker();
        const open = (await t.openIssues()).slice(0, limit);
        if (json) {
          // The dashboard's claims read narrows this exactly as it narrows `gh issue list`.
          out(JSON.stringify(open.map((issue) => ({ number: issue.number, title: issue.title, labels: issue.labels.map((name) => ({ name })) }))));
          return EXIT.ok;
        }
        for (const issue of open) {
          const assignees = issue.assignees.length === 0 ? "" : `  (${issue.assignees.join(", ")})`;
          out(`${t.ref(issue.number)}\t${issue.title}\t[${issue.labels.join(", ")}]${assignees}`);
        }
        return EXIT.ok;
      }
      case "pr-ref": {
        onlyPositional(args, 1, "pr-ref takes one issue number");
        const t = tracker();
        const number = issueNumber(args[0]);
        // On GitHub the merge closes the issue; elsewhere the ticket is named
        // with its link, which links the PR in the tracker, and `done` closes it.
        out(t.kind === "github" ? `Closes #${number}` : `Ticket: ${t.ref(number)} ${t.url(number)}`);
        return EXIT.ok;
      }
      case "view": {
        const json = args.includes("--json");
        if (json) args.splice(args.indexOf("--json"), 1);
        onlyPositional(args, 1, "view takes one issue number");
        const t = tracker();
        const issue = await t.issue(issueNumber(args[0]));
        if (json) {
          out(JSON.stringify({ ...issue, ref: t.ref(issue.number) }));
          return EXIT.ok;
        }
        out(`${t.ref(issue.number)}  ${issue.title}`);
        out(`state: ${issue.state}${issue.status.toLowerCase() === issue.state ? "" : ` (${issue.status})`}`);
        out(`labels: ${issue.labels.join(", ") || "(none)"}`);
        out(`assignees: ${issue.assignees.join(", ") || "(none)"}`);
        out(`author: ${issue.author ?? "(unknown)"}`);
        out(`url: ${issue.url}`);
        out("");
        out(issue.body.trimEnd() || "(no description)");
        out("");
        out(`--- comments (${issue.comments.length}) ---`);
        for (const comment of issue.comments) {
          out(`[${comment.createdAt ?? "undated"}]`);
          out(comment.body.trimEnd());
          out("");
        }
        return EXIT.ok;
      }
      case "comment": {
        const body = takeFlag(args, "--body");
        const file = takeFlag(args, "--body-file");
        onlyPositional(args, 1, "comment takes one issue number");
        if ((body === undefined) === (file === undefined)) throw new UsageError("comment needs exactly one of --body or --body-file");
        const text = body ?? (deps.readFile ?? ((path: string) => readFileSync(path === "-" ? 0 : path, "utf8")))(file!);
        if (text.trim() === "") throw new UsageError("refusing to post an empty comment");
        await tracker().comment(issueNumber(args[0]), text);
        return EXIT.ok;
      }
      case "label": {
        const [verb, raw, ...labels] = args;
        if (verb !== "add" && verb !== "remove") throw new UsageError("label takes add or remove");
        if (labels.length === 0) throw new UsageError(`label ${verb} needs at least one label`);
        const number = issueNumber(raw);
        const t = tracker();
        await (verb === "add" ? t.addLabels(number, labels) : t.removeLabels(number, labels));
        // Only this loop's own fence coming off is a release; resolving the
        // loop inside the guarded call keeps an unknown loop name from failing
        // a label write that already succeeded.
        if (verb === "remove") {
          recordSpeed("released", () =>
            labels.includes(wipLabelFor((deps.loop ?? (() => currentLoop()))())) ? { ticket: String(number) } : null,
          );
        }
        return EXIT.ok;
      }
      case "claimed": {
        const loop = loopOf();
        onlyPositional(args, 0, "claimed takes no issue number");
        for (const issue of await tracker().withLabel(wipLabelFor(loop), { state: "open" })) out(String(issue.number));
        return EXIT.ok;
      }
      case "done":
      case "handoff":
      case "blocked": {
        const loop = loopOf();
        // A trailing `--pr` with no value (an empty variable, unquoted) is no
        // PR: the ledger is bookkeeping and must never refuse the hand-off itself.
        if (command !== "blocked" && args.at(-1) === "--pr") args.pop();
        const pr = command === "blocked" ? undefined : takeFlag(args, "--pr");
        onlyPositional(args, 1, `${command} takes one issue number`);
        const number = issueNumber(args[0]);
        const t = tracker();
        const transition =
          command === "done"
            ? await t.done(number, doneLabelFor(loop))
            : command === "handoff"
              ? await t.handoff(number, doneLabelFor(loop))
              : await t.blocked(number, stuckLabelFor(loop));
        // A handed-off ticket stays open until a person merges, so it must
        // leave the queue: once the merge lands the open PR no longer fences
        // it, and a Jira or Linear ticket the merge does not close would be
        // offered as READY NOW again.
        if (command === "handoff") await t.removeLabels(number, [READY_LABEL]);
        recordSpeed(command === "done" ? "merged" : command === "handoff" ? "handed-off" : "blocked", () =>
          command === "blocked" ? { ticket: String(number) } : { ticket: String(number), pr: pr ?? null },
        );
        // After the label swap and the ledger, so a park that fails can never
        // undo either; it reports on stderr and the command still succeeds.
        if (command === "blocked" && deps.blockPark !== undefined) {
          let parkDeps: Omit<BlockParkDeps, "log"> | null = null;
          try { parkDeps = deps.blockPark(); } catch (error) {
            err(`block-park: #${number} not parked, its paths could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (parkDeps !== null) await recordBlockPark({ ticket: number, loop }, { ...parkDeps, log: err });
        }
        out(`${t.ref(number)} ${command}${transition.movedTo === null ? "" : `, moved to ${transition.movedTo}`}`);
        if (transition.warning !== null) err(`tracker: ${t.ref(number)}: ${transition.warning}`);
        return EXIT.ok;
      }
      case "ref":
      case "url": {
        onlyPositional(args, 1, `${command} takes one issue number`);
        const t = tracker();
        const number = issueNumber(args[0]);
        out(command === "ref" ? t.ref(number) : t.url(number));
        return EXIT.ok;
      }
      case "connect-test": {
        onlyPositional(args, 0, "connect-test reads its request from stdin");
        const request = parseConnectRequest(readJsonStdin(deps));
        if (typeof request === "string") {
          out(JSON.stringify({ ok: false, reason: "invalid", message: request }));
          return EXIT.failed;
        }
        const report = await testConnection(request, deps.fetch ?? fetch);
        out(JSON.stringify(report));
        return report.ok ? EXIT.ok : EXIT.failed;
      }
      case "connect-save": {
        const project = takeFlag(args, "--project");
        onlyPositional(args, 0, "connect-save takes --project <id> and the credential on stdin");
        if (project === undefined) throw new UsageError("connect-save needs --project <id>");
        const credential = readJsonStdin(deps);
        const problem = credentialProblem(credential);
        if (problem !== null) {
          out(JSON.stringify({ ok: false, reason: "invalid", message: problem }));
          return EXIT.failed;
        }
        const path = writeCredential(project, credential as TrackerCredential, deps.env ?? process.env);
        out(JSON.stringify({ ok: true, path }));
        return EXIT.ok;
      }
      default:
        throw new UsageError(command === undefined ? "which command?" : `unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`tracker: ${error.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (error instanceof TrackerUnavailableError) {
      err(`tracker: ${error.message}`);
      return EXIT.unavailable;
    }
    if (isRateLimited(error)) {
      err(`tracker: rate limited: ${error.message}`);
      return EXIT.throttled;
    }
    err(`tracker: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.failed;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    // The ledger of the project this command acts on, as the tracker itself
    // is: a session whose shell wandered into another checkout must not file
    // the hand-off in that repository's ledger, leaving the claim open forever.
    speed: (kind, fields) => {
      recordSpeedEvent(kind, fields, { cwd: projectRoot() });
    },
    blockPark: () => ({
      file: join(projectRoot(), ".ralph/logs/block-park.json"),
      storePath: configuredParkStorePath(process.env, projectRoot()),
      // The probe's own bounded push (`backoff.ts`): a stalled push must not
      // hold `blocked` after its label swap, and RALPH_PUSH_CLI lets a test count it.
      push: defaultNotify(process.env, projectRoot()),
    }),
  });
}
