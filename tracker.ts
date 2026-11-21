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
 *   bun tracker.ts create --title <text> (--body <text> | --body-file <path|->) [--label <name>]...
 *                                           open one issue; prints `<ref>\t<url>`
 *   bun tracker.ts label add|remove <n> <label>...
 *   bun tracker.ts claimed [--loop <name>]  open issues carrying <loop>-wip, one number per line
 *   bun tracker.ts done <n> [--loop <name>] [--pr <url>]     close it, drop its *-wip, add <loop>-done
 *   bun tracker.ts handoff <n> [--loop <name>] [--pr <url>]  leave it open for a person to merge: drop its *-wip and
 *                                                            ready-for-agent, add <loop>-done, move it to the review state
 *   bun tracker.ts blocked <n> [--loop <name>]  drop its *-wip, add <loop>-blocked; then park it as
 *                                           .ralph/logs/block-park.json says, if the session wrote one (#776)
 *   bun tracker.ts ref <n>                  #184, AND-184, OA-410
 *   bun tracker.ts pr-ref <n> [--criteria]  the line a PR body carries for the ticket
 *                                           (--criteria: also its link and its acceptance criteria section)
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
import { sectionIfPresent } from "./sections";
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
  tracker.ts create --title <text> (--body <text> | --body-file <path|->) [--label <name>]...
  tracker.ts label add|remove <n> <label>...
  tracker.ts claimed [--loop <name>]
  tracker.ts done <n> [--loop <name>] [--pr <url>]
  tracker.ts handoff <n> [--loop <name>] [--pr <url>]
  tracker.ts blocked <n> [--loop <name>]
  tracker.ts ref <n>
  tracker.ts pr-ref <n> [--criteria]
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

/**
 * The lines under the body's `## Acceptance criteria` heading, up to the next
 * `## ` heading (a `### ` sub-heading stays inside), verbatim but without the
 * blank lines around them; null when there is no such section or it is empty.
 * The anchor is `sections.ts`'s, so this finds the section exactly where the
 * frontier sizing a ticket and the triager rewriting one find it.
 */
export function acceptanceCriteria(body: string): string[] | null {
  const text = sectionIfPresent(body, "Acceptance criteria");
  if (text === null) return null;
  const section = text.split(/\r?\n/);
  while (section.length > 0 && section[0]!.trim() === "") section.shift();
  while (section.length > 0 && section.at(-1)!.trim() === "") section.pop();
  return section.length === 0 ? null : section;
}

/**
 * Copied lines with every ticket reference wrapped as code: `#12`,
 * `owner/repo#12` and, on a keyed tracker, `KEY-12`. A PR body is read for
 * what it carries — GitHub closes a `Closes #12` on merge, and the frontier
 * fences a ticket a body names — and a criterion that mentions a sibling
 * ticket must do neither. Neither reads inside code (`markdown-code.ts`). Lines in
 * a fenced block and spans already in backticks are left as they are.
 */
export function inertReferences(lines: readonly string[], key: string | null): string[] {
  const keyed = key === null ? "" : `|\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\b`;
  const reference = new RegExp(`(?:\\b[\\w.-]+\\/[\\w.-]+)?#\\d+\\b${keyed}`, "g");
  // A URL or markdown link is one token: wrapping a reference inside it would
  // break the link, so one that names a ticket (an issue URL closes on merge
  // like `#12` does) is quoted whole, and any other is left alone.
  const link = /(\[[^\]\n]*\]\([^)\s]*\)|https?:\/\/[^\s)>\]]+)/;
  const namesTicket = (token: string): boolean => new RegExp(reference.source).test(token) || /\/(?:issues|pull)\/\d+/.test(token);
  let fence: string | null = null;
  const out = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      // Only a bare marker closes a fence: a ```js line inside one is content.
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) fence = null;
      return line;
    }
    if (marker !== undefined) {
      fence = marker;
      return line;
    }
    return line
      .split(/(`[^`\n]*`)/)
      .map((part, at) => {
        if (at % 2 === 1) return part;
        return part
          .split(link)
          .map((piece, index) => {
            if (index % 2 === 0) return piece.replace(reference, (ref) => `\`${ref}\``);
            return namesTicket(piece) ? `\`${piece}\`` : piece;
          })
          .join("");
      })
      .join("");
  });
  // A section cut short inside a fenced block would turn the rest of the PR
  // body into code; close it where the copy ends.
  if (fence !== null) out.push(fence);
  return out;
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
        const criteria = args.includes("--criteria");
        if (criteria) args.splice(args.indexOf("--criteria"), 1);
        onlyPositional(args, 1, "pr-ref takes one issue number");
        const t = tracker();
        const number = issueNumber(args[0]);
        // Only the flag reads the issue, so the plain line costs no tracker call.
        // It is read before anything prints: a failed read leaves no half a PR body.
        const issue = criteria ? await t.issue(number) : null;
        // On GitHub the merge closes the issue; elsewhere the ticket is named
        // with its link, which links the PR in the tracker, and `done` closes it.
        out(t.kind === "github" ? `Closes #${number}` : `Ticket: ${t.ref(number)} ${t.url(number)}`);
        if (issue === null) return EXIT.ok;
        // A keyed tracker's link line already names the ticket with its URL.
        // The issue read's own URL, which is right on any GitHub host.
        if (t.kind === "github") out(`Ticket: ${issue.url}`);
        out("");
        out("### Acceptance criteria");
        out("");
        const lines = acceptanceCriteria(issue.body);
        // A ticket without the section still gets its PR: say so instead of failing.
        if (lines === null) out("_The ticket has no acceptance criteria section._");
        else {
          // A keyed tracker spells its tickets `KEY-n`; GitHub's `#n` is fenced either way.
          const key = t.kind === "github" ? null : (/^(.+)-\d+$/.exec(t.ref(number))?.[1] ?? null);
          // The boxes are the PR author's to tick: one ticked in the ticket starts unticked here.
          const unticked = lines.map((line) => line.replace(/^(\s*[-*+]\s+)\[[xX]\]/, "$1[ ]"));
          for (const line of inertReferences(unticked, key)) out(line);
        }
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
      case "create": {
        const title = takeFlag(args, "--title");
        const body = takeFlag(args, "--body");
        const file = takeFlag(args, "--body-file");
        const labels: string[] = [];
        for (let label = takeFlag(args, "--label"); label !== undefined; label = takeFlag(args, "--label")) {
          // GitHub's adapter hands gh the labels comma-joined, so `a,b` would
          // make a label named `a,b` and then ask for `a` and `b`.
          if (label.includes(",")) throw new UsageError(`a label cannot contain a comma: ${JSON.stringify(label)}; repeat --label instead`);
          // A repeated label would be created twice and reported missing the second time.
          if (!labels.includes(label)) labels.push(label);
        }
        onlyPositional(args, 0, "create takes no issue number");
        if (title === undefined || title.trim() === "") throw new UsageError("create needs a non-empty --title");
        if ((body === undefined) === (file === undefined)) throw new UsageError("create needs exactly one of --body or --body-file");
        // Read before the tracker is built, so an empty file is a usage error
        // that never reaches the tracker.
        const text = body ?? (deps.readFile ?? ((path: string) => readFileSync(path === "-" ? 0 : path, "utf8")))(file!);
        if (text.trim() === "") throw new UsageError("refusing to open an issue with an empty body");
        const t = tracker();
        // GitHub and Linear refuse an unknown label on create; checking first
        // means a label we cannot make leaves no half-labelled issue behind.
        const { missing } = await t.ensureLabels(labels);
        if (missing.length > 0) {
          err(`tracker: cannot create label(s) ${missing.join(", ")}; nothing was opened`);
          return EXIT.failed;
        }
        const created = await t.create({ title, body: text, labels });
        out(`${t.ref(created.number)}\t${created.url}`);
        if (created.warning !== null) err(`tracker: ${t.ref(created.number)}: ${created.warning}`);
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
