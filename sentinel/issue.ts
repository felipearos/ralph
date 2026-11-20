#!/usr/bin/env bun
/**
 * The session's end of a sentinel issue (felipearos/ralph#681, spec #678):
 * read what the gate stored for the issue it handed over, and record the
 * ticket the session drafted for it.
 *
 * The gate gathers because the reporter token is the gate's alone; the
 * session never holds it, so everything it writes the ticket from is what the
 * gate wrote on the record.
 *
 *   bun sentinel/issue.ts show  [<case>] [--json]
 *   bun sentinel/issue.ts draft [<case>] --title <title> --body-file <file> [--json]
 *
 * `<case>` defaults to `$RALPH_INTAKE_CASE`, the line the gate answered with.
 *
 * It writes ONLY the issue store: the draft, and the issue's lease dropped in
 * the same critical section, since the supervisor's heartbeat would otherwise
 * renew it for the rest of the run. It imports no tracker and no reporter and
 * reads no token: the session's rails allow exactly this command, so nothing
 * it does may reach the network. In file mode the draft is still only
 * recorded here: the gate files it on the tracker on its next poll
 * (felipearos/ralph#682), since only the gate holds a tracker.
 *
 * Exit: 0 shown or drafted, 1 the store could not be written, 2 bad usage or
 * no sentinel rules, 3 nothing to show or draft (no such issue, no evidence
 * handed over, held by another run, already filed, or the sentinel disabled
 * in config), 4 a bad title or body.
 */
import { readFileSync } from "node:fs";

import { projectRoot } from "../paths";
import { freshestConfig } from "../live-rules";
import { sentinelRules, type SentinelRules } from "../project-config";
import { parseCase } from "./gate";
import { readStore, recordDraft, storePathFromGit, TITLE_MAX_CHARS, withStore, type IssueRecord } from "./store";

const PREFIX = "sentinel-issue";

export const STORE_EXIT = 1;
export const USAGE_EXIT = 2;
export const NOTHING_EXIT = 3;
/**
 * The session's own title or body is wrong: its own to fix and run `draft`
 * again. Not 2, which the prompt reads as a broken harness and ends the loop on.
 */
export const DRAFT_EXIT = 4;

// Defined beside the record it caps, so the templated fallback in `file.ts`
// holds the same limit without importing this CLI.
export { TITLE_MAX_CHARS } from "./store";

const USAGE = [
  "usage: bun sentinel/issue.ts show  [<case>] [--json]",
  "       bun sentinel/issue.ts draft [<case>] --title <title> --body-file <file> [--json]",
  "  <case> (default $RALPH_INTAKE_CASE): \"sentinel issue <reporter>:<id> — <title>\"",
].join("\n");

export interface IssueDeps {
  storePath: string;
  /** The project's sentinel rules; null when its config has no sentinel block. */
  rules: SentinelRules | null;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

type Verb = "show" | "draft";

interface Args {
  verb: Verb;
  caseText: string | null;
  title: string | null;
  bodyFile: string | null;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Args | null {
  const [verb, ...rest] = argv;
  if (verb !== "show" && verb !== "draft") return null;
  let caseText: string | null = null;
  let title: string | null = null;
  let bodyFile: string | null = null;
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    const value = rest[index + 1];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--title" && verb === "draft" && value !== undefined) {
      title = value;
      index += 1;
    } else if (arg === "--body-file" && verb === "draft" && value !== undefined) {
      bodyFile = value;
      index += 1;
    } else if (!arg.startsWith("--") && caseText === null) {
      caseText = arg;
    } else {
      return null;
    }
  }
  if (verb === "draft" && (title === null || bodyFile === null)) return null;
  return { verb, caseText, title, bodyFile, json };
}

const ok = (stdout: string): Ran => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
const fail = (code: number, stderr: string): Ran => ({ code, stdout: "", stderr: `${stderr}\n` });

const orNone = (value: string | null | undefined): string => (value === null || value === undefined || value === "" ? "none" : value);

function showText(key: string, record: IssueRecord, language: string): string {
  const { candidate } = record;
  const evidence = record.evidence!;
  const lines = [
    `${key}: ${candidate.title}`,
    `culprit: ${orNone(candidate.culprit)}`,
    `level ${candidate.level}, status ${candidate.status}${candidate.regressed ? ", regressed" : ""}`,
    `first seen ${candidate.firstSeen}, last seen ${candidate.lastSeen}`,
    `inside the lookback: ${candidate.events} events, ${candidate.users} users`,
    `permalink: ${orNone(candidate.permalink)}`,
    `release: ${orNone(evidence.release)}`,
    `environment: ${orNone(evidence.environment)}`,
  ];
  const tags = Object.entries(evidence.tags).filter(([, value]) => value !== undefined && value !== "");
  lines.push(tags.length === 0 ? "tags: none" : `tags: ${tags.map(([name, value]) => `${name}=${value}`).join(", ")}`);
  lines.push(evidence.frames.length === 0 ? "frames: none" : "frames:");
  for (const frame of evidence.frames) {
    lines.push(`  ${frame.file}${frame.line === null ? "" : `:${frame.line}`} ${frame.function}${frame.inApp ? " [in-app]" : ""}`);
  }
  if (evidence.framesOmitted > 0) lines.push(`  ${evidence.framesOmitted} more frames omitted`);
  lines.push(evidence.breadcrumbs.length === 0 ? "breadcrumbs: none" : "breadcrumbs:");
  for (const crumb of evidence.breadcrumbs) {
    lines.push(`  ${crumb.at} ${crumb.category} ${crumb.level} ${crumb.message}`);
  }
  if (evidence.breadcrumbsOmitted > 0) lines.push(`  ${evidence.breadcrumbsOmitted} more breadcrumbs omitted`);
  lines.push(`state ${record.state}, attempts ${record.attempts}, mode ${record.mode}`);
  if (record.draft !== null) lines.push(`drafted at ${record.draft.at}: ${record.draft.title}`);
  // The prompt writes the ticket in this language, so it must come from the rules, not a guess.
  lines.push(`language: ${language}`);
  return lines.join("\n");
}

function draftLine(key: string, record: IssueRecord): string {
  return record.mode === "observe"
    ? `${PREFIX}: drafted ${key} (observe mode: recorded what would have been filed; nothing written to the tracker)`
    // The session holds no tracker: the gate files the draft (felipearos/ralph#682).
    : `${PREFIX}: drafted ${key} (file mode: recorded; the gate files it on the tracker on its next poll, labelled ready-for-human)`;
}

export async function run(argv: readonly string[], deps: IssueDeps): Promise<Ran> {
  const args = parseArgs(argv);
  if (args === null) return fail(USAGE_EXIT, USAGE);
  const text = args.caseText ?? deps.env.RALPH_INTAKE_CASE?.trim() ?? "";
  const key = text === "" ? null : parseCase(text);
  if (key === null) {
    return fail(USAGE_EXIT, `${PREFIX}: ${text === "" ? "no case given and RALPH_INTAKE_CASE is not set" : `not a sentinel case: ${JSON.stringify(text)}`}\n${USAGE}`);
  }
  const rules = deps.rules;
  if (rules === null) return fail(USAGE_EXIT, `${PREFIX}: the project's .ralph/config.json has no 'sentinel' block`);

  if (args.verb === "show") {
    const record = readStore(deps.storePath).issues[key];
    if (record === undefined) return fail(NOTHING_EXIT, `${PREFIX}: no sentinel issue record for ${key}`);
    if (record.evidence === null) return fail(NOTHING_EXIT, `${PREFIX}: nothing to show for ${key}: the gate has not handed its evidence over`);
    return ok(args.json ? JSON.stringify({ record, language: rules.language }, null, 2) : showText(key, record, rules.language));
  }

  // Defence in depth for the switch (#789): a gate whose rules say off hands
  // nothing over, but a session already running when the sentinel was
  // switched off must not record a draft the gate would file once it is on
  // again. Exit 3, "nothing to draft": the session ends and the gate, once
  // re-enabled, hands the issue over afresh. `show` stays: it writes nothing.
  if (rules.enabled === false) return fail(NOTHING_EXIT, `${PREFIX}: nothing to draft for ${key}: the sentinel is disabled in config ('sentinel.enabled' is false)`);

  // Checked before the lock: a bad title or body is the session's to fix, and must leave the store as it was.
  const title = (args.title as string).replace(/\s+/g, " ").trim();
  if (title === "") return fail(DRAFT_EXIT, `${PREFIX}: the title is empty`);
  if (title.length > TITLE_MAX_CHARS) {
    return fail(DRAFT_EXIT, `${PREFIX}: the title is ${title.length} characters; keep it to ${TITLE_MAX_CHARS}`);
  }
  const bodyFile = args.bodyFile as string;
  let body: string;
  try {
    body = readFileSync(bodyFile, "utf8");
  } catch (error) {
    return fail(DRAFT_EXIT, `${PREFIX}: cannot read the body file ${bodyFile}: ${(error as Error).message}`);
  }
  if (body.trim() === "") return fail(DRAFT_EXIT, `${PREFIX}: the body file ${bodyFile} is empty`);

  type Outcome = { kind: "drafted"; record: IssueRecord } | { kind: "nothing"; why: string };
  const now = deps.now();
  let outcome: Outcome;
  try {
    outcome = await withStore(deps.storePath, (store): Outcome => {
      const record = store.issues[key];
      if (record === undefined) return { kind: "nothing", why: `no sentinel issue record for ${key}` };
      if (record.evidence === null) return { kind: "nothing", why: `nothing to draft for ${key}: the gate has not handed its evidence over` };
      // A lease another run holds means this session's own lapsed and another
      // session has the issue now: its draft must not take that lease away.
      const lease = store.leases[key];
      const run = deps.env.RALPH_RUN_ID?.trim();
      const loop = deps.env.RALPH_LOOP_NAME?.trim();
      if (lease !== undefined && run && loop && (lease.run !== run || lease.loop !== loop)) {
        return { kind: "nothing", why: `${key} is held by ${lease.loop} (run ${lease.run}) now; this session's draft is not recorded` };
      }
      if (record.state === "filed") {
        return { kind: "nothing", why: `${key} is already filed${record.ticket ? ` as ${record.ticket}` : ""}; its draft is not replaced` };
      }
      // A record already drafted takes the new draft: a resumed session may
      // improve on what it wrote, and nothing has been filed from it yet.
      const drafted = recordDraft(store, key, { title, body, at: now.toISOString() }, rules.mode, now);
      return { kind: "drafted", record: drafted };
    });
  } catch (error) {
    return fail(STORE_EXIT, `${PREFIX}: could not record the draft for ${key}: ${(error as Error).message}`);
  }
  if (outcome.kind === "nothing") return fail(NOTHING_EXIT, `${PREFIX}: ${outcome.why}`);
  return ok(args.json ? JSON.stringify(outcome.record, null, 2) : draftLine(key, outcome.record));
}

async function main(): Promise<number> {
  const root = projectRoot();
  let rules: SentinelRules | null;
  try {
    // What the gate that handed this case over last read from origin (#788),
    // so the draft is recorded in the mode the gate files it under.
    rules = sentinelRules(freshestConfig(root, "sentinel").config);
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
