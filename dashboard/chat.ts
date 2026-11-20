/**
 * The unblocker chat's server half: which session a block belongs to.
 *
 * When a loop halts or a ticket is left `<loop>-blocked`, the agent that hit
 * the block still holds the whole of its reasoning — in a Claude session on
 * this host. The operator's fastest route to "why?" is to resume THAT session
 * rather than brief a cold one. This module answers the only question that
 * stands between the two: given a halted loop or a blocked ticket, which
 * session id was it?
 *
 * READ-ONLY, AND PURE OVER ITS IO — the RESOLUTION half, which is everything
 * above `The turns themselves`. It never spawns, writes, or reads a clock;
 * every filesystem read goes through an injected `ChatIO`, so the whole
 * resolution is exercised against a temp directory in the tests rather than
 * mocked. (`ChatSessions`, below, does all three.) Resuming the session is `startChat`'s job, in the same module but a
 * separate concern; this half must stay safe to call from any read path.
 *
 * WHERE THE SESSION ID ACTUALLY LIVES. Not in the iteration log, which carries
 * only `stream-render.py`'s rendered output. `ralph.sh`'s `say()` writes the
 * `=== <Loop> iteration N/M (<ts>) session <uuid> ===` header to the
 * SUPERVISOR log, `.ralph/logs/supervisor-<run>.log`. The two are joined by
 * `<ts>`, which is also the iteration log's own name (`iter-<ts>.log`) — so
 * resolution is: name an iteration log, take its timestamp, find the header.
 *
 * ONE ITERATION, SEVERAL SESSIONS. A phase retry, a PR wait and a budget
 * handoff each start a fresh session inside the same iteration, and each
 * announces itself with its own header (`ralph.sh:1113`, `:1347`, `:1238`).
 * The session that was alive when the loop stopped is the LAST one named
 * before the next iteration's numbered header — so a resolution that took the
 * first would resume a session that had already handed over. A sigil recovery,
 * a host lease and an ordinary phase boundary RESUME the session instead, so
 * they add no header and need none.
 *
 * ITERATION LOGS ONLY, NOT JOURNAL ENTRIES. #252 names both as sources for a
 * blocked ticket; only the logs are read here, deliberately. A published
 * journal entry lives in the HARNESS repository, not this worktree, and its
 * filename carries a twelve-character session FRAGMENT — which cannot be
 * passed to `--resume`. Joining a journal entry to a full session id would
 * need a mechanism that does not exist yet; until it does, an entry could say
 * which ticket was blocked but not which session to resume, so it would not
 * answer the question this module is asked.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { buildSeed, HANDBACK_DRAFT_PROMPT, modeNotice, NO_EVIDENCE, SEED_LOG_LINES, type ChatEvidence } from "./chat-seed";
import { createRedactor, readLogTail, type OutputIO } from "./iteration-output";

export type ChatIO = Pick<typeof nodeFs, "readdirSync" | "readFileSync">;

const LOGS_DIR = join(".ralph", "logs");

/** `ralph.sh`'s `iter-${ts}.log`; every sidecar beside it carries a pid or a suffix. */
const ITERATION_LOG = /^iter-(\d{8}T\d{6})\.log$/;
const SUPERVISOR_LOG = /^supervisor-.+\.log$/;

/**
 * A header that opens an iteration: `=== Ralph iteration 7/50 (20261007T105001)
 * session <uuid> ===`. It is the only header carrying a timestamp, which is
 * what ties it to an iteration log — every later header in the same iteration
 * names the iteration number alone.
 */
const ITERATION_HEADER = /^=== \S+ iteration (\d+)\/\S+ \((\d{8}T\d{6})\) session (\S+) ===$/;
/** Any header at all, including the mid-iteration ones (`fresh`, `handoff`, PR waits). */
const ANY_SESSION_HEADER = /^=== \S+ iteration (\d+)[:/].* session (\S+?)(?: |$)/;
/**
 * `<Loop>: models — orchestrator <model> on <runner>, mapper …` (`ralph.sh:1497`).
 *
 * The runner ends at a comma OR at whitespace, and that is not pedantry: a
 * one-role lineup has no trailing `, mapper …`, and the line then ends
 * ` on codex (orchestrator effort high)`. Requiring a comma missed every one
 * of the twenty codex announcements in this host's longest supervisor log.
 */
const MODELS_LINE = /\bmodels — .*?\borchestrator \S+ on ([^\s,]+)/;
/** `<Loop> run <id> — usage ledger: …` (`ralph.sh:1443`): one per supervisor start. */
const RUN_BANNER = / run \S+ — usage ledger:/;

/** The loop a chat is about, as the dashboard already knows it. */
export interface ChatLoop {
  name: string;
  worktree: string;
  /** `loop-state.ts`'s `StopReason`, narrowed to what resolution reads. */
  stopReason: { kind: string; why: string; at?: string } | null;
}

export type ChatTarget = { kind: "halt" } | { kind: "ticket"; ticket: number };

/**
 * `log` is the iteration log the block was traced to, whether or not a
 * session came of it: the evidence seed quotes its tail either way (#253).
 */
export type SessionResolution =
  | { session: string; runner: string | null; source: string; why: null; log: string }
  | { session: null; runner: string | null; source: string | null; why: string; log: string | null };

const unresolved = (
  why: string,
  runner: string | null = null,
  source: string | null = null,
  log: string | null = null,
): SessionResolution => ({
  session: null,
  runner,
  source,
  why,
  log,
});

/**
 * A block OF THIS TICKET, on one line.
 *
 * The two halves have to meet on the same line, and this is the whole reason:
 * `blocked:` appears in a rendered iteration log every time an iteration reads
 * or writes code with a `blocked` field in it (`blocked: Ticket[]`,
 * `blocked: string[] = []`). Over the 60 newest real logs on this host, a
 * file-wide search for "#201 somewhere and `blocked:` somewhere" matched ten
 * of them, including iterations that never touched #201. A line is what the
 * loop prompt's §6 actually writes — `blocked: PR #1276 red twice in CI`,
 * `needs-migration: draft PR #1242 ready`, `ticket-blocked:252` — so a line
 * is what is matched. Measured, that took #201 from ten of those sixty logs
 * to one.
 *
 * It NARROWS; it does not isolate. The renderer flattens a whole tool result
 * onto one log line, so a log that merely read this very file, or a fixture
 * quoting a block, still matches — six of sixty for #1276, all false. A wrong
 * answer here costs a chat opened on the wrong iteration, which the operator
 * sees: `source` names the log it came from, and the first turn's answer will
 * not be about their ticket.
 */
const blockOfTicket = (loop: string, ticket: number): RegExp => {
  // The loop name comes off `.ralph/loop-name` on disk, not from a validated
  // write path: a metacharacter there would be a wildcard and a `(` a thrown
  // `SyntaxError` — out of a function whose contract is that a failure is an
  // answer, not an exception.
  const name = loop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = String.raw`(?:blocked:|needs-migration:|ticket-blocked|\b${name}-blocked\b)`;
  return new RegExp(String.raw`^.*${marker}.*#${ticket}\b|^.*#${ticket}\b.*${marker}`, "m");
};

function readText(io: ChatIO, path: string): string | null {
  try {
    return io.readFileSync(path, "utf8") as string;
  } catch {
    return null;
  }
}

function listLogs(io: ChatIO, dir: string, pattern: RegExp): string[] {
  let names: string[];
  try {
    names = io.readdirSync(dir) as unknown as string[];
  } catch {
    return [];
  }
  // Both log families are named with a sortable timestamp, so lexical order is
  // chronological and `.reverse()` is "newest first" without a single `stat`.
  return names.filter((name) => pattern.test(name)).sort().reverse();
}

/** The iteration log a halt points at, by the path `stopReason.why` quotes. */
function haltedLog(loop: ChatLoop): { ts: string; log: string } | string {
  const stop = loop.stopReason;
  if (stop === null) return `loop '${loop.name}' has no stop reason recorded, so no iteration is named to resume`;
  const match = /iter-(\d{8}T\d{6})\.log/.exec(stop.why);
  if (match === null) {
    return `the stop reason for '${loop.name}' names no iteration log (${stop.kind}: ${stop.why})`;
  }
  return { ts: match[1]!, log: `iter-${match[1]!}.log` };
}

/**
 * How many iteration logs a ticket search reads.
 *
 * It reads them whole, on the request thread: a live loop checkout here holds
 * 166 of them and about 20 MB, and a miss would otherwise block the whole
 * dashboard's event loop for every one. A block older than the newest forty
 * iterations is a block from days ago, and the `why` says the search was
 * bounded rather than implying the ticket was never blocked.
 */
const TICKET_SCAN_LOGS = 40;

/** The newest iteration log that names this ticket AND a block of it. */
function blockedLog(io: ChatIO, loop: ChatLoop, ticket: number): { ts: string; log: string } | string {
  const dir = join(loop.worktree, LOGS_DIR);
  const blocked = blockOfTicket(loop.name, ticket);
  const logs = listLogs(io, dir, ITERATION_LOG).slice(0, TICKET_SCAN_LOGS);
  for (const name of logs) {
    const text = readText(io, join(dir, name));
    if (text === null || !blocked.test(text)) continue;
    return { ts: ITERATION_LOG.exec(name)![1]!, log: name };
  }
  return `none of the newest ${logs.length} iteration logs in ${dir} records a block of #${ticket} by '${loop.name}'`;
}

/**
 * Every session the supervisor log names for an iteration opened at `ts`, one
 * per run that opened one, each with the line its header is on.
 *
 * Several, because `iter-<ts>.log` is a PATH: two supervisors that start an
 * iteration in the same second share the file, and on this host that is not
 * hypothetical — a frontier-gated loop restarting on a drained backlog put 558
 * duplicate header timestamps in one log. When they disagree, no reading of
 * the file can say whose session wrote it, so the caller refuses rather than
 * takes the last, which is how a codex iteration came back as claude.
 *
 * The line number is not bookkeeping: a supervisor log can be restarted into
 * (`ralph.sh` appends under one run id) and carry hundreds of `models` lines
 * with DIFFERENT runners — one real log on this host has 1,972 of them, claude
 * for the first 1,836 and codex after. So the runner has to be read relative
 * to this iteration's header, never from the file as a whole.
 */
function sessionsAt(text: string, ts: string): { session: string; header: number }[] {
  const found: { session: string; header: number }[] = [];
  let open: { session: string; header: number } | null = null;
  const lines = text.split("\n");
  for (const [at, line] of lines.entries()) {
    const numbered = ITERATION_HEADER.exec(line);
    if (numbered !== null) {
      // The next iteration's header closes the one being read: its own later
      // sessions belong to it, not to ours.
      if (open !== null) found.push(open);
      open = numbered[2] === ts ? { session: numbered[3]!, header: at } : null;
      continue;
    }
    if (open === null) continue;
    const later = ANY_SESSION_HEADER.exec(line);
    // The LAST session of an iteration is the one that was alive at its end.
    if (later !== null) open = { session: later[2]!, header: open.header };
  }
  if (open !== null) found.push(open);
  return found;
}

/**
 * The runner this iteration's own supervisor announced, or null.
 *
 * Bounded by the run banner above it, not just by the header: one supervisor
 * log is appended to across restarts, so walking back past a banner reaches a
 * PREVIOUS run's lineup. That is worse than knowing nothing — an unreadable
 * line would degrade to a confident, stale `claude` and hand a codex
 * iteration's id to `--resume`, which is the one thing the runner check
 * exists to stop. Null means "not announced", which resolves anyway.
 */
function runnerAt(text: string, header: number): string | null {
  const lines = text.split("\n");
  for (let at = Math.min(header, lines.length - 1); at >= 0; at -= 1) {
    const line = lines[at]!;
    const models = MODELS_LINE.exec(line);
    if (models !== null) return models[1]!;
    if (RUN_BANNER.test(line)) return null;
  }
  return null;
}

/**
 * The session behind a halted loop or a blocked ticket.
 *
 * A failure is an answer, not an exception: every path returns a `why` the
 * caller can show the operator and then start a fresh seeded session instead,
 * which is what spec #251 asks for.
 */
export function resolveSession(loop: ChatLoop, target: ChatTarget, io: ChatIO = nodeFs): SessionResolution {
  const dir = join(loop.worktree, LOGS_DIR);
  const found = target.kind === "halt" ? haltedLog(loop) : blockedLog(io, loop, target.ticket);
  if (typeof found === "string") return unresolved(found);

  for (const name of listLogs(io, dir, SUPERVISOR_LOG)) {
    const text = readText(io, join(dir, name));
    if (text === null) continue;
    const claims = sessionsAt(text, found.ts);
    if (claims.length === 0) continue;
    const source = `${found.log} → ${name}`;
    const distinct = new Set(claims.map((claim) => claim.session));
    if (distinct.size > 1) {
      return unresolved(
        `${distinct.size} runs opened an iteration at ${found.ts} and share ${found.log}, so which session wrote it cannot be told apart`,
        null,
        source,
        found.log,
      );
    }
    const claim = claims.at(-1)!;
    // A log older than the models line resolves anyway: the line was added
    // after the headers were, and refusing every pre-dating session would make
    // the chat useless on exactly the halts that have been sitting longest.
    const runner = runnerAt(text, claim.header);
    if (runner !== null && runner !== "claude") {
      return unresolved(
        `iteration ${found.ts} was orchestrated by ${runner}, and only a claude session can be resumed`,
        runner,
        source,
        found.log,
      );
    }
    return { session: claim.session, runner, source, why: null, log: found.log };
  }
  return unresolved(`no supervisor log in ${dir} names the session of iteration ${found.ts}`, null, null, found.log);
}


/* ------------------------------------------------------------------------- *
 * The turns themselves: fork the loop's session, stream it back redacted.
 * ------------------------------------------------------------------------- */

/**
 * The one command a chat runs besides the redactor.
 *
 * `--fork-session` is what keeps the promise spec #251 makes: the loop's own
 * session file is never written, because the first turn branches the history
 * into a new id and every later turn resumes the branch.
 *
 * The whole argv is pinned by `read-only.test.ts`, which is the only thing
 * stopping a later edit from adding `--dangerously-skip-permissions` or
 * loosening the mode with every test still green.
 */
export const CHAT_COMMAND = {
  bin: "claude",
  /**
   * The flags that are not the session: the operator's text never appears
   * here, because it goes in on STDIN. A message beginning with a dash would
   * otherwise be parsed as an option — "- why did you stop?" exits 0 having
   * printed the version — and operator text reaching a process's argv is a
   * seam this module has no business having.
   */
  args: [
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--setting-sources",
    "",
  ],
  /**
   * Fix mode's flags in place of `args` (#254): the loop's claude EXECUTOR's
   * own, as `delegate.sh` passes them — `--dangerously-skip-permissions`,
   * which approves what the settings do not deny (that a settings deny still
   * bites under it is what `claude-executor-rails-probe.sh` proves),
   * `--strict-mcp-config` and `--setting-sources project`. Its `--settings`
   * are `fixSettings`, the executor's whole deny list and more. This is the
   * only place the bypass is spelt, and only `commandArgs("fix")` reaches it;
   * the route refuses a Fix turn while the loop's supervisor is alive
   * (`chat-fix.ts`).
   */
  fix: [
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--setting-sources",
    "project",
  ],
  resume: "--resume",
  fork: "--fork-session",
} as const;

/**
 * Ask mode: the default. The agent may read the
 * loop's worktree and the harness checkout, run the ticket's read-only
 * commands, and do nothing else.
 *
 * Every layer was probed against the CLI (2.1.292) with `claude -p`, rather
 * than read off its help:
 *
 *   - `--tools` MOUNTS only Read, Grep, Glob and Bash, as `claude-inspect.sh`
 *     does for the loops' own read-only stages. Without it every built-in tool
 *     is mounted, the Agent tool among them, and that one needs no permission.
 *   - The file tools are confined to two ROOTS: the worktree (the turn's cwd)
 *     and `$RALPH_HOME` (`--add-dir`). Under `dontAsk`, a read inside a working
 *     directory needs no rule and one outside it is denied, so the allowlist
 *     carries NO bare `Read`/`Grep`/`Glob`. A bare `Read` rule is what let the
 *     first draft read `/etc/hostname`, and with it `~/.ssh`. That departs from
 *     #253's list, which named them, on purpose.
 *   - `--allowedTools` is the rest of #253's list verbatim: the `gh`, `git` and
 *     `bk-log.ts` prefixes. Anything else is DENIED rather than prompted
 *     (`dontAsk` and `--permission-prompts none` in `CHAT_COMMAND.args`), so
 *     `echo x > f` comes back in the stream's `permission_denials` and the turn
 *     carries on.
 *   - `--disallowedTools` names the editing tools outright.
 *   - `--settings` carries the denies (`askSettings`): every `Read(...)` rule
 *     `claude-executor-settings.json` holds (read at run time, so the two
 *     cannot drift), `CHAT_READ_DENY` for what the executor never had to fear
 *     (a worktree's `.env`, `~/.aws`), and `SHELL_READERS`. A `Read` deny
 *     also filters Grep and Glob, which was probed: a worktree Grep skips
 *     `.env`.
 *
 * WHY THE SHELL READERS ARE DENIED. Claude Code approves a command it deems
 * read-only on its own, allowlist or not, and checks only its literal path
 * arguments against the `Read` denies: `cat .env` is refused, but
 * `grep -r SECRET .` printed `.env` whole. There is no setting that turns the
 * approval off. The OS sandbox (`SANDBOX`, below) now fences it as well; this
 * list stays as the first layer. So every command in the CLI's
 * read-only set that prints a file's CONTENT is denied in Bash, and the agent
 * reads through Read, Grep and Glob, which respect the denies. What is left
 * auto-approved prints names and metadata (`ls`, `stat`, `wc`, checksums).
 * `git show`/`git diff`/`git log -p` stay on the allowlist and can print a
 * TRACKED file, which is in the repository's history already.
 *
 * `$RALPH_HOME` in the ticket's `bun $RALPH_HOME/bk-log.ts` is EXPANDED here:
 * a permission rule is matched against the command as written, and the agent
 * writes the path. The preamble names it the same way (`chat-seed.ts`).
 *
 * This replaces v1's deny-all `--settings` payload (`{"permissions":{"deny":
 * ["*"]}}`), because a deny beats an allow and would refuse the allowlist too.
 * `--setting-sources ""` stays in `CHAT_COMMAND.args`, so the loop worktree's
 * own `.claude/settings.json` still cannot widen any of this.
 */
export const ASK_MODE = {
  tools: "Read,Grep,Glob,Bash",
  allowed: (harness: string): string[] => [
    "Bash(gh issue view:*)",
    "Bash(gh pr view:*)",
    "Bash(gh pr checks:*)",
    "Bash(git log:*)",
    "Bash(git diff:*)",
    "Bash(git show:*)",
    `Bash(bun ${harness}/bk-log.ts:*)`,
    // A Linear or Jira ticket is read through the project's tracker (#339).
    `Bash(bun ${harness}/tracker.ts view:*)`,
  ],
  disallowed: "Edit,Write,NotebookEdit",
} as const;

/** The executor's rails, whose `Read(...)` denies Ask mode reuses. */
export const EXECUTOR_SETTINGS = "claude-executor-settings.json";

/**
 * Read denies the executor never needed: it runs under `env -i` in a
 * worktree with no `.env`, while a chat runs with the dashboard's environment
 * in a checkout that may have one. Everything under `~/.config` (gh, gcloud,
 * doppler's CLI) is the executor's own rule, so it is not repeated here.
 */
export const CHAT_READ_DENY = [
  "Read(**/.env*)",
  "Read(**/.envrc)",
  "Read(~/.aws/**)",
  "Read(~/.docker/**)",
  "Read(~/.kube/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.git-credentials)",
  "Read(~/.npmrc)",
  "Read(**/*.pem)",
  "Read(**/id_rsa*)",
  "Read(**/id_ed25519*)",
  "Read(**/id_ecdsa*)",
] as const;

/**
 * The commands in the CLI's own read-only set (`readOnlyValidation.ts`, read
 * out of the 2.1.292 binary) that print a file's content, and so would read
 * past a `Read` deny on a recursive or directory argument. Each is denied in
 * three spellings, as `claude-executor-settings.json` does: which one a CLI
 * version honours has moved.
 */
export const SHELL_READERS = [
  "cat", "head", "tail", "less", "more", "strings", "od", "hexdump", "xxd", "base64", "nl", "cut", "paste",
  "column", "tac", "rev", "fold", "expand", "unexpand", "fmt", "comm", "cmp", "diff", "sort", "uniq", "grep",
  "egrep", "fgrep", "rg", "sed", "awk", "jq", "xargs", "pr", "find", "fd", "fdfind", "tree",
  "git grep", "git cat-file", "git blame",
] as const;

/**
 * The `Read(...)` denies of the executor's settings, from its text.
 *
 * Throws on anything it cannot vouch for — unparseable, no deny list, not one
 * `Read` rule — because the caller FAILS CLOSED on a throw: an Ask turn
 * without the executor's denies is not run.
 */
export function executorReadDenies(text: string): string[] {
  const parsed = JSON.parse(text) as { permissions?: { deny?: unknown } };
  const deny = parsed.permissions?.deny;
  if (!Array.isArray(deny)) throw new Error(`${EXECUTOR_SETTINGS} has no permissions.deny list`);
  const reads = deny.filter((rule): rule is string => typeof rule === "string" && rule.startsWith("Read("));
  if (reads.length === 0) throw new Error(`${EXECUTOR_SETTINGS} denies no Read path`);
  return reads;
}

/**
 * The executor's WHOLE deny list, from its text: Fix mode's rails.
 *
 * Held to the same standard as `executorReadDenies`, whose checks it runs
 * first — a file that has lost its Read denies has lost something a Fix turn
 * must not run without — and FAILS CLOSED the same way: no list, no turn.
 */
export function executorDenies(text: string): string[] {
  executorReadDenies(text);
  const deny = (JSON.parse(text) as { permissions: { deny: unknown[] } }).permissions.deny;
  return deny.filter((rule): rule is string => typeof rule === "string");
}

/** Every `SHELL_READERS` command, in the three spellings. */
const shellReaderDenies = (): string[] =>
  SHELL_READERS.flatMap((command) => [`Bash(${command} *)`, `Bash(${command}:*)`, `Bash(${command})`]);

/**
 * The write flags of the commands Ask's allowlist approves. `Bash(git log:*)`
 * approves every `git log`, and `git log --output=<file>` WRITES (probed: it
 * wrote into the worktree). The sandbox cannot make the worktree root itself
 * read-only (`sandboxSettings`), so this is the rail that stops it.
 */
export const ASK_WRITE_FLAGS = ["Bash(*--output*)"] as const;

/** The `--settings` payload of an Ask turn: the deny lists, then the sandbox under them. */
export function askSettings(executorReads: readonly string[], roots: SandboxRoots): string {
  return JSON.stringify({
    permissions: {
      deny: [...new Set([...executorReads, ...CHAT_READ_DENY])].concat(shellReaderDenies(), ASK_WRITE_FLAGS),
      // Belt to the roots: a shell read outside the working directories is
      // refused too, not only a file tool's. It is also what masks the home
      // directory from the sandbox (`SANDBOX`).
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: sandboxSettings("ask", roots),
  });
}

/**
 * The `--settings` payload of a Fix turn: the executor's rails, never more.
 *
 * Every rule `claude-executor-settings.json` denies, verbatim — its Bash
 * denies (`git push`, `gh`, `curl`, migrations, …), its Read denies and its
 * tool denies (Agent, WebFetch, Monitor, …) — read at run time so the two
 * cannot drift. Then Ask's own secret-path protections, kept on purpose:
 *
 * - `CHAT_READ_DENY`, because the executor's denies were written for a
 *   process that runs in a worktree with no `.env`, and a chat runs in a
 *   checkout that may have one.
 * - `SHELL_READERS`. The executor rails do NOT cover the hole Ask closed:
 *   they deny no `grep`, `cat` or `find`, so `grep -r SECRET .` would print
 *   a `.env` the Read deny refuses by name. The executor's own output goes to
 *   a log; a Fix turn's goes to a BROWSER. So they stay denied, and the agent
 *   reads through Read, Grep and Glob, which honour the Read denies. Under
 *   the bypass these are tripwires on the obvious spellings, not a boundary —
 *   an interpreter can still open a file — and the boundaries are the
 *   executor's: the cleared environment (`executorEnv`) and, on the way to
 *   the browser, the redactor every chat byte crosses.
 * - `blockReadsOutsideWorkingDirectories`, and no `--add-dir`: the executor
 *   is not given the harness, so a Fix turn is not either.
 */
export function fixSettings(executorDeny: readonly string[], roots: SandboxRoots): string {
  return JSON.stringify({
    permissions: {
      deny: [...new Set([...executorDeny, ...CHAT_READ_DENY])].concat(shellReaderDenies()),
      blockReadsOutsideWorkingDirectories: true,
    },
    // Under the bypass the deny lists are tripwires on spellings; the sandbox
    // is what an interpreter's `open()` meets (`SANDBOX`).
    sandbox: sandboxSettings("fix", roots),
  });
}

/* ------------------------------------------------------------------------- *
 * The OS sandbox: the boundary under both modes' deny lists.
 * ------------------------------------------------------------------------- */

/**
 * What a turn's sandbox is drawn around. Paths are absolute, as the sandbox's
 * own path syntax takes them (`~` is the account's home; `//` means nothing).
 */
export interface SandboxRoots {
  worktree: string;
  harness: string;
  /** The worktree's own git dir and the repository's common one, when it is a linked worktree. */
  gitDirs: { own: string | null; common: string | null };
  /** This chat's private temp dir: `$TMPDIR` inside the sandbox, and nothing else's. */
  tmp: string;
  /** Install roots of the tools a Fix turn's gates run (`~/.bun`), readable and nothing more. */
  tools: readonly string[];
}

/**
 * The OS sandbox both modes run under (Claude Code's `sandbox` settings:
 * bubblewrap and socat on Linux). The deny lists above stay, as the second
 * layer: they refuse by name before a command starts, and the sandbox is what
 * holds when a command reads a file no list names — an interpreter's
 * `open()`, a recursive grep, a test runner.
 *
 * Probed against the CLI (2.1.293) on this host, case by case:
 *
 *   - `failIfUnavailable: true`: with a dependency missing the CLI exits at
 *     startup ("sandbox required but unavailable") instead of running the
 *     turn unsandboxed. `chat.ts` turns that exit into a withheld chat.
 *   - `allowUnsandboxedCommands: false`: the model's
 *     `dangerouslyDisableSandbox` retry is ignored, and a `--settings` false
 *     cannot be loosened by a repository's settings.
 *   - `autoAllowBashIfSandboxed: false`: sandboxed is not approved. Ask keeps
 *     `dontAsk` and its allowlist; Fix is the bypass either way.
 *   - READS. `permissions.blockReadsOutsideWorkingDirectories` (set by both
 *     modes) masks home directories and mounted volumes from sandboxed
 *     commands, keeping the working directories. It does NOT mask `/tmp`: a
 *     `python3` `open()` of a file there printed it, and the CLI's own temp
 *     root (`/tmp/claude-<uid>`, every session's scratch on this host) was
 *     readable. So `/tmp`, `/var/tmp`, `/dev/shm` and `/run/user` (the agent
 *     sockets) are denied too, and `allowRead` re-opens what a turn needs:
 *     the worktree, the harness, the git dirs a linked worktree keeps outside
 *     itself, the chat's private temp dir, and (Fix) the tool roots. A
 *     narrower allow wins over a wider deny, by the CLI's rule. `denyRead: ["/"]`
 *     was tried and breaks bwrap's own setup.
 *   - The permission `Read(...)` denies feed the sandbox too: with them,
 *     `grep -r SECRET .` in a worktree with a `.env` no longer printed it,
 *     and a `python3` read of `.env` failed with EACCES.
 *   - TEMP. `CLAUDE_CODE_TMPDIR` (`sandboxEnv`) moves the sandbox's temp root
 *     to `tmp`, which the CLI creates itself (mode 0700); it is re-opened for
 *     writes as well as reads, because bwrap writes its own mask files there.
 *   - SHELL. The sandbox runs commands in the account's `$SHELL`, here under
 *     `/home/linuxbrew`, which the home mask hides: every command failed with
 *     `execvp … zsh`. `CLAUDE_CODE_SHELL` pins `/bin/bash`.
 *
 * ASK: no writes, in two layers. The sandbox denies writes to the harness,
 * the git dirs and the worktree's `.git` pointer, and allows only the
 * private temp dir — but it cannot deny the worktree ROOT: bwrap writes its
 * own mask files into the working directory, and a read-only one fails every
 * command at setup (probed, in `/tmp` and under `/home` alike). Writes there
 * are the permission layer's: `dontAsk` approves only read-only commands and
 * the allowlist, and `ASK_WRITE_FLAGS` closes the allowlist's one write
 * (`git log --output=`). The network allowlist is EMPTY: `gh` needs its token file
 * (`~/.config/gh`), which the home mask rightly hides from every sandboxed
 * command, so the ticket's three `gh` reads and `bk-log.ts` are
 * `excludedCommands` instead: they run outside the sandbox, still only when
 * the allowlist approves them, and a call chaining anything else onto one
 * stays sandboxed (the CLI's rule: every command in the call must match).
 * Opening `github.com` to every sandboxed command would have meant opening
 * the token file to `python3` as well.
 *
 * FIX: writes in the worktree (the CLI's default for the working directory)
 * and its own git dir (the index), and the private temp dir; nowhere else
 * (probed: a write to another `/tmp` path and to `~` both failed). Reads add
 * the harness — the executor guard's shims lead the turn's `PATH`
 * (`EXECUTOR_ENV.guard`), and a hidden harness skipped them silently — and
 * `tools`. Probed: `bun run typecheck` and a scoped `bunx vitest run` pass
 * in a linked loop worktree with its own `node_modules` (`BUN_TMPDIR` points
 * bun at the private temp dir; without it `bunx` failed with EROFS). No
 * network: a gate that needs a service is a gate the loop runs, not the chat.
 */
export const SANDBOX = {
  base: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false },
  denyRead: ["/tmp", "/var/tmp", "/dev/shm", "/run/user"],
  shell: "/bin/bash",
  /** The line the CLI prints when it refuses to start without its sandbox. */
  unavailable: /sandbox required but unavailable/i,
} as const;

/** Ask's commands that run outside the sandbox, and only these (see `SANDBOX`). */
export const ASK_UNSANDBOXED = (harness: string): string[] => [
  "gh issue view *",
  "gh pr view *",
  "gh pr checks *",
  `bun ${harness}/bk-log.ts *`,
  `bun ${harness}/tracker.ts view *`,
];

/** Where a chat's sandbox keeps its temp files: one directory per chat. */
export const chatTmpDir = (id: string): string => join("/tmp", `ralph-chat-${id}`);

const present = (paths: readonly (string | null)[]): string[] => paths.filter((path): path is string => path !== null);

/** The `sandbox` block of a turn's `--settings`. */
export function sandboxSettings(mode: ChatMode, roots: SandboxRoots): Record<string, unknown> {
  const gitDirs = present([roots.gitDirs.common, roots.gitDirs.own]);
  const readable = [roots.worktree, roots.harness, ...gitDirs, roots.tmp];
  if (mode === "fix") {
    return {
      ...SANDBOX.base,
      filesystem: {
        denyRead: [...SANDBOX.denyRead],
        allowRead: [...readable, ...roots.tools],
        allowWrite: present([roots.gitDirs.own, roots.tmp]),
      },
      network: { allowedDomains: [] },
    };
  }
  return {
    ...SANDBOX.base,
    excludedCommands: ASK_UNSANDBOXED(roots.harness),
    filesystem: {
      denyRead: [...SANDBOX.denyRead],
      allowRead: readable,
      allowWrite: [roots.tmp],
      // Not the worktree root itself: bwrap creates its own mask files there
      // (`.gitconfig`, `.bashrc`, …), and a read-only cwd fails every
      // command at setup (probed). Its writes are the permission layer's to
      // refuse; the `.git` pointer in it is denied here by name.
      denyWrite: [roots.harness, ...gitDirs, join(roots.worktree, ".git")],
    },
    network: { allowedDomains: [] },
  };
}

/** What a turn's `claude` needs in its environment for the sandbox to run as probed. */
export function sandboxEnv(roots: SandboxRoots): Record<string, string> {
  return { CLAUDE_CODE_SHELL: SANDBOX.shell, CLAUDE_CODE_TMPDIR: roots.tmp, BUN_TMPDIR: roots.tmp };
}

/**
 * A linked worktree's git dirs, from its `.git` file: `gitdir: <own>`, and
 * `<own>/commondir` naming the repository's. Both live outside the worktree,
 * where the sandbox would hide them and `git log` would fail. A worktree whose
 * `.git` is a directory needs neither: it is inside the worktree already.
 * Anything unreadable is null, and the sandbox then simply does not open it.
 */
export function gitDirsOf(worktree: string, io: ChatIO = nodeFs): SandboxRoots["gitDirs"] {
  let pointer: string;
  try {
    pointer = io.readFileSync(join(worktree, ".git"), "utf8") as string;
  } catch {
    return { own: null, common: null };
  }
  const own = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
  if (own === undefined) return { own: null, common: null };
  const ownAbs = resolve(worktree, own);
  let common: string | null = null;
  try {
    common = resolve(ownAbs, (io.readFileSync(join(ownAbs, "commondir"), "utf8") as string).trim());
  } catch {
    common = null;
  }
  return { own: ownAbs, common };
}

/**
 * The tool roots a Fix turn's gates need readable: bun's install root, from
 * the bun the dashboard itself runs (`~/.bun/bin/bun` → `~/.bun`).
 */
export function toolRootsOf(bunPath: string): string[] {
  if (!isAbsolute(bunPath)) return [];
  const bin = dirname(bunPath);
  return [basename(bin) === "bin" ? dirname(bin) : bin];
}

/**
 * A chat's mode. Ask is the default and needs nothing of the loop; Fix runs
 * under the loop's executor rails and only while the loop is stopped (#254).
 */
export type ChatMode = "ask" | "fix";
export const CHAT_MODES: readonly ChatMode[] = ["ask", "fix"];

/** The flags that are not the mode's rails: Ask's pinned set, or the executor's for Fix. */
export function commandArgs(mode: ChatMode): readonly string[] {
  return mode === "fix" ? CHAT_COMMAND.fix : CHAT_COMMAND.args;
}

/**
 * The bounds on Unblock & resume's draft turn (#255): the one turn that asks
 * the chat for the operator-decision summary.
 *
 * It runs under the chat's CURRENT session and mode rails — these flags are
 * added after the mode's, never in place of them — and is bounded three ways:
 * `--max-turns 1` is one reply and no tool loop, `--max-budget-usd` caps what
 * resuming a long session may spend, and the turn is killed after
 * `timeoutMs` rather than the ten minutes an operator's own turn gets. What
 * comes back is cut at `maxChars`: it is a summary for a ticket comment, and
 * the operator edits it before anything is posted.
 */
export const CHAT_DRAFT = {
  args: ["--max-turns", "1", "--max-budget-usd", "1"],
  timeoutMs: 3 * 60_000,
  maxChars: 4_000,
} as const;

/**
 * Unblock & resume's steps (#255), as the transcript records them on its
 * `handback` events: `draft` (the summary asked for), `decision` (the summary
 * the operator confirmed), then the confirm sequence's five in order.
 */
export const HANDBACK_STEPS = ["draft", "decision", "worktree", "comment", "label", "journal", "restart"] as const;
export type HandbackStep = (typeof HANDBACK_STEPS)[number];

/**
 * - `asked` / `confirmed` — the draft turn was sent; the operator's summary was taken;
 * - `done` — the step changed what it exists to change;
 * - `already` — an earlier attempt did it (the comment's marker, the label gone);
 * - `skipped` — nothing to do: no ticket, or a running loop's own worktree;
 * - `refused` — the worktree is not in its role's invariant; nothing external ran;
 * - `failed` — the step could not finish; the sequence stops there.
 */
export type HandbackOutcome = "asked" | "confirmed" | "done" | "already" | "skipped" | "refused" | "failed";

/**
 * The executor rules a mode's `--settings` are built from, out of the
 * executor settings' text: the Read denies for Ask, the whole list for Fix.
 * Throws on a file it cannot vouch for, and the caller withholds the turn.
 */
export function rulesFor(mode: ChatMode, executorSettings: string): string[] {
  return mode === "fix" ? executorDenies(executorSettings) : executorReadDenies(executorSettings);
}

/** The mode's flags, after `commandArgs` and before the session; `executor` is `rulesFor(mode, …)`. */
export function modeArgs(mode: ChatMode, harness: string, executor: readonly string[], roots: SandboxRoots): string[] {
  switch (mode) {
    case "fix":
      // Nothing but the settings: no `--tools`, no allowlist and no
      // `--add-dir`, because the executor is given none of them. What it may
      // not do is its deny list's business, as it is in `delegate.sh`.
      return ["--settings", fixSettings(executor, roots)];
    case "ask":
      // One argv element per rule: `--allowedTools` is variadic, and a rule
      // with a space in it (`Bash(gh issue view:*)`) must not be split.
      return [
        "--tools",
        ASK_MODE.tools,
        "--add-dir",
        harness,
        "--allowedTools",
        ...ASK_MODE.allowed(harness),
        "--disallowedTools",
        ASK_MODE.disallowed,
        "--settings",
        askSettings(executor, roots),
      ];
  }
}

/**
 * The environment a Fix turn's `claude` runs in: the executor's, built as
 * `delegate.sh` builds `EXECUTOR_ENV` for the claude runner — cleared, then
 * only these. An Ask turn keeps the dashboard's, which its allowlist needs
 * for `gh`; a Fix turn may run any command its deny list does not name, so it
 * gets no secret to run it with, exactly as the executor gets none.
 */
export const EXECUTOR_ENV = {
  /** Led by the executor guard's shims, which refuse repo-wide verification. */
  guard: "executor-guard/bin",
  defaults: { TERM: "dumb", LANG: "C.UTF-8" },
  passthrough: ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"],
} as const;

export function executorEnv(env: NodeJS.ProcessEnv, harness: string): Record<string, string> {
  const cleared: Record<string, string> = {
    PATH: `${join(harness, EXECUTOR_ENV.guard)}:${env.PATH ?? ""}`,
    HOME: env.HOME ?? "",
    TERM: env.TERM || EXECUTOR_ENV.defaults.TERM,
    LANG: env.LANG || EXECUTOR_ENV.defaults.LANG,
  };
  for (const name of EXECUTOR_ENV.passthrough) {
    const value = env[name];
    if (value !== undefined && value !== "") cleared[name] = value;
  }
  return cleared;
}


/** The harness checkout this module was loaded from: `$RALPH_HOME`. */
const HARNESS_HOME = join(__dirname, "..");

/**
 * How long the first turn waits for its evidence seed to come back out of the
 * redactor. The seed is a few hundred lines, so this is a bound on a wedged
 * filter, not on a slow one.
 */
export const SEED_TIMEOUT_MS = 30_000;

/** A turn whose `claude` never exits is killed rather than pinning the chat. */
export const TURN_TIMEOUT_MS = 10 * 60_000;
/**
 * And then, if the turn STILL has not ended, it is withheld.
 *
 * Killing the child is not enough on its own: a turn ends when the end marker
 * comes back out of the filter, so a filter that wedges or block-buffers
 * leaves the chat at `running` with the child already gone — which `sweep`
 * skips, `release` never reaches, and every later turn 409s against. This is
 * the bound on the turn rather than on the process.
 */
export const TURN_GRACE_MS = 30_000;
/** An idle chat is swept when another starts, so nothing accumulates unwatched. */
export const CHAT_IDLE_MS = 60 * 60_000;

export type ChatStatus = "idle" | "running" | "withheld" | "closed";

export interface ChatEvent {
  /** 1-based and gapless: `?after=<seq>` is "everything newer than this". */
  seq: number;
  at: string;
  /**
   * `seed` is the redacted evidence preamble the first turn sent ahead of the
   * operator's message (`chat-seed.ts`): recorded, so the transcript holds
   * everything the agent was told, and shown, so the operator can see it.
   */
  /**
   * `handback` — Unblock & resume's progress (#255): one per step, carrying
   * `step` and `outcome`. A `draft` event's text is the summary the agent
   * wrote; a `decision` event's is the one the operator confirmed. A retry
   * reads these back: a `journal` already `done` is not published twice.
   */
  /**
   * Fix mode's markers (#254), so the transcript says under which rails every
   * answer was given:
   *
   * - `mode` — the chat changed mode; `mode` is the one now in force and the
   *   text says why (the supervisor's exit, or the operator going back).
   * - `fix-turn` — the turn that follows runs under the executor's rails, in
   *   the loop's worktree. Emitted ahead of that turn's `operator` event, on
   *   every Fix turn and not only the first.
   * - `stop` — Stop & fix's progress: the soft stop sent and the wait for the
   *   iteration boundary, a stop still pending when the window ran out, or a
   *   stop the loop refused. The mode is unchanged by one; a `mode` event
   *   follows when Fix unlocks.
   */
  kind: "operator" | "seed" | "agent" | "turn-end" | "withheld" | "mode" | "fix-turn" | "stop" | "handback";
  text: string;
  /** On `mode`, `fix-turn` and `stop`: the chat's mode once the event has happened. */
  mode?: ChatMode;
  /** On `handback`: which step of Unblock & resume, and how it went. */
  step?: HandbackStep;
  outcome?: HandbackOutcome;
}

export interface StartedChat {
  id: string;
  /** The session this chat forks FROM, or null when it starts fresh. */
  session: string | null;
  source: string | null;
  /** Why there is no session to resume, when there is none. */
  why: string | null;
}

export interface ChatView extends StartedChat {
  loop: string;
  /**
   * The ticket the block is about: the one the chat was opened on, else the
   * halted loop's own. Null for a halt with no ticket — Unblock & resume then
   * has no comment to post and no label to drop.
   */
  ticket: number | null;
  /** An Unblock & resume is running its steps. */
  handingBack: boolean;
  mode: ChatMode;
  /** A Stop & fix is waiting on the loop's iteration boundary. */
  stopping: boolean;
  status: ChatStatus;
  /** The forked session every turn after the first resumes, once it is known. */
  fork: string | null;
  events: ChatEvent[];
  transcript: string;
  /** Set when an append to the transcript failed: the durable half has a gap. */
  transcriptProblem: string | null;
}

export class ChatError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

/**
 * `mode` picks the environment: a Fix turn's is the executor's (`executorEnv`).
 * `env` is laid over it: what the turn's sandbox needs (`sandboxEnv`).
 */
export type SpawnChat = (
  args: string[],
  cwd: string,
  mode: ChatMode,
  env: Record<string, string>,
) => import("node:child_process").ChildProcess;

export interface ChatDeps {
  /** Starts `claude`; the chat owns the argv, the caller owns where it comes from. */
  claude: SpawnChat;
  /** Starts `runner-failure.ts redact` as a stdin → stdout filter, as the live pane does. */
  redactor: () => import("node:child_process").ChildProcess;
  now?: () => Date;
  newId?: () => string;
  turnTimeoutMs?: number;
  graceMs?: number;
  idleMs?: number;
  /** How long the first turn waits on its seed's redaction. */
  seedTimeoutMs?: number;
  /** How long the handback's draft turn runs before it is killed. */
  draftTimeoutMs?: number;
  /** The harness checkout, `$RALPH_HOME`: where Ask mode's `bk-log.ts` lives. */
  harness?: string;
  /** Tool install roots a Fix turn's sandbox may read (`toolRootsOf`); none by default. */
  toolRoots?: readonly string[];
  io?: ChatFileIO;
}

/** Everything a chat reads or writes on disk, injectable for the tests. */
export type ChatFileIO = ChatIO & OutputIO & Pick<typeof nodeFs, "appendFileSync">;

interface ChatRecord {
  id: string;
  /** Which project's handler minted this chat; another project's may not read it. */
  project: string | null;
  loop: ChatLoop;
  base: SessionResolution;
  ticket: number | null;
  mode: ChatMode;
  /** One Unblock & resume at a time: two would both find no comment and both post. */
  handingBack: boolean;
  /** The journal draft's timestamp, fixed at the first confirm so a retry names the same entry. */
  handbackStamp: string | null;
  /**
   * The key of the soft stop this chat's Stop & fix sent, while it waits on
   * the boundary. Held here so a re-issue waits on the SAME stop rather than
   * sending a second; cleared once the wait is settled either way.
   */
  stopKey: string | null;
  /** The mode the agent was last told it is in: the seed says Ask. */
  told: ChatMode;
  /**
   * The evidence preamble, RAW, until the first turn redacts and sends it;
   * null after. It never leaves this record unredacted.
   */
  seed: string | null;
  /** The one-shot filter redacting the seed, while it runs. */
  seeding: import("node:child_process").ChildProcess | null;
  /** The forked session, learned from the stream's `system/init` event. */
  fork: string | null;
  status: ChatStatus;
  events: ChatEvent[];
  transcript: string;
  transcriptProblem: string | null;
  waiters: (() => void)[];
  /** One per TURN, not one per chat: see `endTurn`. */
  filter: import("node:child_process").ChildProcess | null;
  turn: import("node:child_process").ChildProcess | null;
  deadline: ReturnType<typeof setTimeout> | null;
  /** Lines fed to this turn's filter and lines it has returned: they must agree. */
  fed: number;
  out: number;
  carry: string;
  /** The exact line that ends the current turn, or null between turns. */
  endMarker: string | null;
  turns: number;
  touched: number;
}

/**
 * Every live chat on this host.
 *
 * In memory on purpose: a chat is a conversation an operator is having right
 * now, and the durable half is the transcript on disk. A dashboard restart
 * ends them, and so does `close`.
 *
 * NOTHING ACCUMULATES UNWATCHED. A turn's redactor is started and stopped with
 * the turn, so an idle chat holds no process at all; a turn whose `claude`
 * never exits is killed at `TURN_TIMEOUT_MS` rather than pinning the chat at
 * `running` for the dashboard's lifetime; and a chat untouched for
 * `CHAT_IDLE_MS` is dropped when the next one starts. Without those three a
 * single POST would leave a resident Bun process behind until the unit
 * restarted, which is what the first draft of this module did.
 */
export class ChatSessions {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly io: ChatFileIO;
  private readonly harness: string;
  private readonly seedTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly draftTimeoutMs: number;
  private readonly graceMs: number;
  private readonly idleMs: number;
  /**
   * The nonce the end marker is built from: this process, this moment, and
   * chance — never the chat id, which is written into the loop's own worktree
   * as `chat-<id>.jsonl`. Ask mode (#253) gives the agent Read over that
   * worktree, and a marker it could derive from a filename is a marker it
   * could forge: ending a turn early, with a second turn then accepted over
   * the first's still-running process. `iteration-output.ts` guards its resets
   * the same way, for the same reason.
   */
  private readonly nonce = `\u0001ralph-chat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-`;

  constructor(private readonly deps: ChatDeps) {
    this.now = deps.now ?? ((): Date => new Date());
    this.newId = deps.newId ?? ((): string => randomUUID());
    this.io = deps.io ?? nodeFs;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    this.draftTimeoutMs = deps.draftTimeoutMs ?? CHAT_DRAFT.timeoutMs;
    this.graceMs = deps.graceMs ?? TURN_GRACE_MS;
    this.idleMs = deps.idleMs ?? CHAT_IDLE_MS;
    this.seedTimeoutMs = deps.seedTimeoutMs ?? SEED_TIMEOUT_MS;
    this.harness = deps.harness ?? HARNESS_HOME;
  }

  /**
   * What this chat's turns are sandboxed around. Read per turn, like the
   * executor's rails, so a worktree whose `.git` changed is drawn correctly.
   */
  private sandboxRoots(chat: ChatRecord): SandboxRoots {
    return {
      worktree: chat.loop.worktree,
      harness: this.harness,
      gitDirs: gitDirsOf(chat.loop.worktree, this.io),
      tmp: chatTmpDir(chat.id),
      tools: this.deps.toolRoots ?? [],
    };
  }

  /**
   * Open a chat. `evidence` is what the dashboard already read about the
   * block; the seed is built from it here, and redacted on the first turn.
   */
  start(loop: ChatLoop, target: ChatTarget, project: string | null = null, evidence: ChatEvidence = NO_EVIDENCE): StartedChat {
    this.sweep();
    const base = resolveSession(loop, target, this.io);
    const id = this.newId();
    const seed = buildSeed({
      loop: loop.name,
      worktree: loop.worktree,
      harness: this.harness,
      stopReason: loop.stopReason,
      session: base.session,
      source: base.source,
      why: base.why,
      log: base.log,
      tail: base.log === null ? null : readLogTail(loop.worktree, base.log, { lines: SEED_LOG_LINES, io: this.io }),
      evidence,
    });
    this.chats.set(id, {
      id,
      project,
      loop,
      base,
      ticket: target.kind === "ticket" ? target.ticket : evidence.ticket,
      mode: "ask",
      handingBack: false,
      handbackStamp: null,
      stopKey: null,
      told: "ask",
      seed,
      seeding: null,
      fork: null,
      status: "idle",
      events: [],
      transcript: join(loop.worktree, LOGS_DIR, `chat-${id}.jsonl`),
      transcriptProblem: null,
      waiters: [],
      filter: null,
      turn: null,
      deadline: null,
      fed: 0,
      out: 0,
      carry: "",
      endMarker: null,
      turns: 0,
      touched: this.now().getTime(),
    });
    return { id, session: base.session, source: base.source, why: base.why };
  }

  /**
   * The chat, or a 404.
   *
   * `project` is checked, not just the id: one registry serves every project's
   * handler, so without this `GET /api/p/<other>/chat/<id>` would answer with
   * this chat's transcript and `POST .../turn` would continue its session in
   * another project's checkout. Ids are uuids, so this is a boundary rather
   * than a hole being plugged — but the route's claim to refuse an unknown
   * project has to hold for a KNOWN wrong one too.
   */
  private get(id: string, project: string | null = null): ChatRecord {
    const chat = this.chats.get(id);
    if (chat === undefined || (project !== null && chat.project !== null && chat.project !== project)) {
      throw new ChatError(404, "UnknownChat", `no chat '${id}'`);
    }
    return chat;
  }

  view(id: string, project: string | null = null): ChatView {
    const chat = this.touch(this.get(id, project));
    return {
      id: chat.id,
      loop: chat.loop.name,
      ticket: chat.ticket,
      handingBack: chat.handingBack,
      // The base resolution, as `StartedChat` documents it; the fork is its
      // own field rather than quietly replacing this one after a turn.
      session: chat.base.session,
      fork: chat.fork,
      source: chat.base.source,
      why: chat.base.why,
      mode: chat.mode,
      stopping: chat.stopKey !== null,
      status: chat.status,
      events: [...chat.events],
      transcript: chat.transcript,
      transcriptProblem: chat.transcriptProblem,
    };
  }

  /** Everything newer than `after`, and the sequence to ask from next. */
  since(id: string, after: number, project: string | null = null): { events: ChatEvent[]; next: number; status: ChatStatus } {
    const chat = this.touch(this.get(id, project));
    const events = chat.events.filter((event) => event.seq > after);
    // Never backwards: a client that asked from beyond the end would otherwise
    // be told to ask from further back, wake on the next event, and get an
    // empty page again — a spin rather than a wait.
    return { events, next: Math.max(after, chat.events.at(-1)?.seq ?? 0), status: chat.status };
  }

  /**
   * The long poll: the same answer as `since`, but held until there is
   * something in it or the wait runs out. An abandoned page's abort resolves
   * it too, so no waiter outlives its request.
   *
   * A chat closed or swept while a poll is open wakes it and then throws
   * `UnknownChat` from the second `since` — so the page is told at once that
   * the chat is gone, rather than after the full wait.
   */
  async waitSince(
    id: string,
    after: number,
    timeoutMs: number,
    signal?: AbortSignal,
    project: string | null = null,
  ): Promise<{ events: ChatEvent[]; next: number; status: ChatStatus }> {
    const first = this.since(id, after, project);
    // Already gone: the route awaits its body and the roster read before it
    // gets here, and a client that disconnected in that window must not leave
    // a timer behind. `iteration-output.ts` guards the same case.
    if (first.events.length > 0 || signal?.aborted === true) return first;
    const chat = this.get(id, project);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const at = chat.waiters.indexOf(done);
        if (at !== -1) chat.waiters.splice(at, 1);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      chat.waiters.push(done);
    });
    return this.since(id, after, project);
  }

  /**
   * Run one turn. Returns as soon as the process is started — the route
   * answers 202 and the operator reads the stream through `since`.
   */
  send(id: string, text: string, project: string | null = null): void {
    const chat = this.get(id, project);
    this.mayTurn(chat);
    this.begin(chat, text, false);
  }

  /** Refuse a turn the chat cannot take now, with the reason. */
  private mayTurn(chat: ChatRecord): void {
    if (chat.status === "withheld") {
      throw new ChatError(409, "ChatWithheld", "this chat's output was withheld; start a new one");
    }
    if (chat.status === "closed") throw new ChatError(409, "ChatClosed", "this chat was closed");
    if (chat.status === "running") {
      throw new ChatError(409, "TurnInFlight", "this chat is still answering the previous turn");
    }
    // A turn beside an Unblock & resume would be a writer in the worktree
    // the handback is checking and about to start the loop in.
    if (chat.handingBack) throw new ChatError(409, "HandbackInFlight", "this chat is handing the block back to the loop");
  }

  /**
   * Unblock & resume's draft (#255): one bounded turn asking the chat for the
   * operator-decision summary, and the summary it wrote.
   *
   * An ordinary turn in every way that matters — the chat's own session and
   * mode rails, the seed on a first turn, every byte through the redactor and
   * into the transcript — plus `CHAT_DRAFT`'s bounds. The text returned is
   * the redacted stream's: the `result` event's, else the assistant's text.
   * Throws when there is none to return, saying why; the operator can always
   * write the summary themselves.
   */
  async draft(id: string, project: string | null = null): Promise<string> {
    const chat = this.get(id, project);
    this.mayTurn(chat);
    const from = chat.events.length;
    this.emit(chat, "handback", "asked the agent for an operator-decision summary", undefined, { step: "draft", outcome: "asked" });
    this.begin(chat, HANDBACK_DRAFT_PROMPT, true);
    // Bounded by the turn itself: killed at the draft deadline, withheld after
    // the grace if it still has not ended. Every event wakes the waiters.
    while (chat.status === "running") await new Promise<void>((wake) => chat.waiters.push(wake));
    const events = chat.events.slice(from);
    if (chat.status !== "idle") {
      const why = [...events].reverse().find((event) => event.kind === "withheld")?.text ?? `the chat is ${chat.status}`;
      throw new ChatError(409, chat.status === "withheld" ? "ChatWithheld" : "ChatClosed", why);
    }
    const drafted = draftFrom(events);
    if (typeof drafted !== "string") {
      this.emit(chat, "handback", drafted.why, undefined, { step: "draft", outcome: "failed" });
      throw new ChatError(502, "DraftFailed", drafted.why);
    }
    this.emit(chat, "handback", drafted, undefined, { step: "draft", outcome: "done" });
    return drafted;
  }

  /**
   * Claim the chat for one Unblock & resume, or refuse: a turn in flight, or
   * another handback already running. `endHandback` releases it.
   */
  beginHandback(id: string, project: string | null = null): void {
    const chat = this.get(id, project);
    if (chat.status === "running") {
      throw new ChatError(409, "TurnInFlight", "this chat is still answering a turn; hand back once it has finished");
    }
    if (chat.handingBack) throw new ChatError(409, "HandbackInFlight", "this chat is already handing the block back");
    chat.handingBack = true;
    chat.handbackStamp ??= compactStamp(this.now());
  }

  endHandback(id: string, project: string | null = null): void {
    const chat = this.chats.get(id);
    if (chat !== undefined && (project === null || chat.project === null || chat.project === project)) chat.handingBack = false;
  }

  /** The journal draft's timestamp: the first confirm's, so a retry names the same entry. */
  handbackStamp(id: string, project: string | null = null): string {
    const chat = this.get(id, project);
    chat.handbackStamp ??= compactStamp(this.now());
    return chat.handbackStamp;
  }

  /** Record one handback step on the chat's stream and in its transcript. */
  markHandback(id: string, step: HandbackStep, outcome: HandbackOutcome, text: string, project: string | null = null): void {
    const chat = this.get(id, project);
    if (chat.status === "closed") return;
    this.emit(chat, "handback", text, undefined, { step, outcome });
  }

  /** Start one turn: the operator's text (or the draft prompt) behind any seed and mode notice. */
  private begin(chat: ChatRecord, text: string, draft: boolean): void {
    chat.status = "running";
    chat.touched = this.now().getTime();
    chat.fed = 0;
    chat.out = 0;
    chat.carry = "";
    chat.turns += 1;
    chat.endMarker = `${this.nonce}${chat.turns}`;
    // The mode is fixed HERE, for the whole turn: the first turn waits on its
    // seed's redaction, and a switch in that window must not change the rails
    // of a turn already marked with the old ones.
    const mode = chat.mode;
    if (mode === "fix") {
      this.emit(
        chat,
        "fix-turn",
        `Fix turn ${chat.turns}: the loop's executor rails (${EXECUTOR_SETTINGS}, permissions bypassed except what it denies, the executor's environment) in ${chat.loop.worktree}`,
        mode,
      );
    }
    this.emit(chat, "operator", text);
    // The agent is told when its rails changed, ahead of the operator's words:
    // the seed said Ask, and a fork that still believed it was a mere reader
    // would decline the edit it was switched to Fix to make.
    const notice = mode === chat.told ? "" : modeNotice(mode, this.harness);
    chat.told = mode;

    const seed = chat.seed;
    if (seed === null) {
      this.runTurn(chat, `${notice}${text}\n`, mode, draft);
      return;
    }
    // The first turn carries the evidence, and only once it has come back out
    // of the redactor: the seed quotes a log, a stop reason and a ticket
    // comment, any of which can hold a token. Consumed here whatever happens,
    // because a seed that failed redaction withholds the chat for good.
    chat.seed = null;
    const turn = chat.turns;
    const mine = (): boolean => chat.turns === turn && chat.status === "running";
    this.redactSeed(chat, seed).then(
      (redacted) => {
        if (!mine()) return;
        this.emit(chat, "seed", redacted.replace(/\n$/, ""));
        this.runTurn(chat, `${redacted}\n${notice}${text}\n`, mode, draft);
      },
      (error: unknown) => {
        if (mine()) this.withhold(chat, message(error));
      },
    );
  }

  /** Start this turn's filter and its `claude`, with `input` on its stdin. */
  private runTurn(chat: ChatRecord, input: string, mode: ChatMode, draft: boolean): void {
    // Read every turn rather than once, so a fixed file is picked up without
    // a dashboard restart. Fail closed: no executor denies, no turn.
    let executor: string[];
    try {
      executor = rulesFor(mode, this.io.readFileSync(join(this.harness, EXECUTOR_SETTINGS), "utf8") as string);
    } catch (error) {
      const rails = mode === "fix" ? "Fix mode's executor rails" : "Ask mode's read denies";
      this.withhold(chat, `${rails} could not be loaded from ${EXECUTOR_SETTINGS}, so no turn runs: ${message(error)}`);
      return;
    }
    if (this.startFilter(chat) === null) return;

    const resume = chat.fork ?? chat.base.session;
    const roots = this.sandboxRoots(chat);
    const args = ["-p", ...commandArgs(mode), ...modeArgs(mode, this.harness, executor, roots)];
    // The draft's bounds go on after the mode's rails, never in their place.
    if (draft) args.push(...CHAT_DRAFT.args);
    if (resume !== null) {
      args.push(CHAT_COMMAND.resume, resume);
      // Only the first turn forks: after that the fork IS the session, and
      // forking again each turn would strand every answer in its own branch.
      if (chat.fork === null) args.push(CHAT_COMMAND.fork);
    }

    let child: import("node:child_process").ChildProcess;
    try {
      child = this.deps.claude(args, chat.loop.worktree, mode, sandboxEnv(roots));
    } catch (error) {
      this.withhold(chat, `the chat could not start: ${message(error)}`);
      return;
    }
    const { stdin, stdout, stderr } = child;
    if (stdout === null) {
      this.withhold(chat, "the chat has no output to read");
      return;
    }
    chat.turn = child;
    // Gated the same way as the filter's handlers, and for the same reason: a
    // killed child's `close` can land after the next turn has started, and an
    // ungated one would null the new turn's `turn` (leaking its process),
    // feed the old turn's trailing output into the new turn's filter, and end
    // it on the spot with the marker.
    const turn = chat.turns;
    const mine = (): boolean => chat.turns === turn && chat.status === "running";
    // The operator's message (behind the seed, on the first turn), on stdin,
    // where no argv parser can read it as a flag. `claude -p` with no
    // positional prompt takes its prompt from here.
    stdin?.on("error", () => undefined);
    stdin?.end(input);
    const tails = { out: "", err: "" };
    // Set when the CLI refused to start without its sandbox (`SANDBOX`'s
    // `failIfUnavailable`). Read off the raw line, before the filter: what is
    // matched is the CLI's own fixed wording, and nothing of it is shown.
    let sandboxMissing = false;
    const stream = (which: "out" | "err", piece: string, mark: (line: string) => string): void => {
      const lines = (tails[which] + piece).split("\n");
      tails[which] = lines.pop() ?? "";
      for (const line of lines) {
        if (which === "err" && SANDBOX.unavailable.test(line)) sandboxMissing = true;
        this.feed(chat, mark(line));
      }
    };
    const guarded = (run: () => void): void => {
      if (mine()) run();
    };
    stdout.setEncoding("utf8");
    stdout.on("data", (piece: string) => guarded(() => stream("out", piece, (line) => line)));
    // `claude`'s stderr goes through the same filter as its stdout rather than
    // being dropped or shown raw: a crash message is the most useful thing in
    // a failed turn, and it is also the likeliest place for a path or a token
    // to appear. Marked, so the UI does not try to parse it as stream-json.
    stderr?.setEncoding("utf8");
    stderr?.on("data", (piece: string) => guarded(() => stream("err", piece, (line) => `[stderr] ${line}`)));
    child.on("error", (error) => guarded(() => this.withhold(chat, `the chat could not run: ${error.message}`)));
    child.on("close", (code) => {
      if (!mine()) return;
      chat.turn = null;
      if (SANDBOX.unavailable.test(tails.err)) sandboxMissing = true;
      if (sandboxMissing) {
        // Withheld, not reported: the turn did not run, and no later one will
        // until the host has its sandbox back. A chat that answered "status
        // 1" here would invite the operator to keep trying.
        this.withhold(
          chat,
          "the OS sandbox is unavailable on the dashboard's host (bubblewrap and socat must both be installed), so no turn runs; start a new chat once it is back",
        );
        return;
      }
      if (tails.out.trim() !== "") this.feed(chat, tails.out);
      if (tails.err.trim() !== "") this.feed(chat, `[stderr] ${tails.err}`);
      tails.out = "";
      tails.err = "";
      if (code !== 0) this.feed(chat, `[exit] the turn ended with status ${code}`);
      // The end marker goes through the SAME filter as the output, so it comes
      // out behind every line of this turn: that is what makes the count below
      // a complete comparison rather than a race with the filter's buffer.
      if (chat.endMarker !== null) this.feedRaw(chat, chat.endMarker);
    });
    chat.deadline = setTimeout(() => {
      // Killed, not withheld: the partial answer is still the operator's, and
      // the child's `close` carries it through the marker as any turn does.
      chat.turn?.kill("SIGTERM");
      chat.deadline = setTimeout(() => {
        if (chat.status === "running") this.withhold(chat, "output withheld: the turn did not finish, and its output could not be vouched for");
      }, this.graceMs);
    }, draft ? this.draftTimeoutMs : this.turnTimeoutMs);
  }

  /**
   * Switch the chat's mode, and mark the switch in the transcript.
   *
   * This module does not decide whether Fix is allowed — it cannot see the
   * loop's supervisor. The route asks `chat-fix.ts` first, and asks again
   * before every Fix turn. What it does decide: a withheld or closed chat
   * changes nothing, and a turn already in flight keeps the rails it started
   * with (the mode is read when a turn is sent), so going back to Ask is
   * possible at any time without killing an answer half given.
   */
  setMode(id: string, mode: ChatMode, why: string, project: string | null = null): ChatView {
    const chat = this.get(id, project);
    if (chat.status === "withheld") {
      throw new ChatError(409, "ChatWithheld", "this chat's output was withheld; start a new one");
    }
    if (chat.status === "closed") throw new ChatError(409, "ChatClosed", "this chat was closed");
    if (chat.mode !== mode) {
      chat.mode = mode;
      const label = mode === "fix" ? "Fix mode: the loop's executor rails, in its worktree" : "Ask mode: read-only tools";
      this.emit(chat, "mode", `${label} — ${why}`, mode);
    }
    return this.view(id, project);
  }

  /**
   * Begin a Stop & fix: the key of this chat's soft stop, and whether the
   * caller is the one to send it. A chat already waiting on a stop hands back
   * that stop's key with `send: false`, so however often the operator
   * presses, the loop is sent one stop.
   */
  beginStop(id: string, project: string | null = null): { key: string; send: boolean } {
    const chat = this.get(id, project);
    if (chat.status === "withheld") {
      throw new ChatError(409, "ChatWithheld", "this chat's output was withheld; start a new one");
    }
    if (chat.status === "closed") throw new ChatError(409, "ChatClosed", "this chat was closed");
    if (chat.stopKey !== null) return { key: chat.stopKey, send: false };
    // A command id names the inbox file, so it is letters, digits and dashes.
    chat.stopKey = `chat-stop-${this.newId()}`;
    return { key: chat.stopKey, send: true };
  }

  /**
   * Record Stop & fix's progress on the chat's stream. `settled` ends the
   * wait: the stop was refused, or the supervisor exited — after which a
   * later Stop & fix is a new stop for a loop somebody started again.
   */
  markStop(id: string, text: string, settled: boolean, project: string | null = null): void {
    const chat = this.get(id, project);
    if (settled) chat.stopKey = null;
    if (chat.status === "closed") return;
    this.emit(chat, "stop", text, chat.mode);
  }

  /** End a chat and release everything it holds. */
  close(id: string, project: string | null = null): void {
    const chat = this.get(id, project);
    this.release(chat);
    chat.status = "closed";
    this.chats.delete(id);
    chat.waiters.splice(0).forEach((wake) => wake());
  }

  /**
   * Stop everything this registry holds.
   *
   * NOT wired to a shutdown signal: `read-only.test.ts` reserves signalling a
   * process to `interrupt.ts`, so `server.ts` installs no handler. At process
   * exit the children are reaped by their pipes — the redactor reads this
   * process's stdin, `claude` writes to its stdout — and a turn is bounded by
   * `TURN_TIMEOUT_MS` besides.
   */
  stopAll(): void {
    for (const chat of this.chats.values()) {
      this.release(chat);
      // Status too: a chat left at `running` over a process that no longer
      // exists would 409 every later turn about nothing.
      if (chat.status === "running") chat.status = "idle";
      chat.waiters.splice(0).forEach((wake) => wake());
    }
  }

  /** Drop chats nobody has touched for `idleMs`, and nothing that is running. */
  private sweep(): void {
    const cutoff = this.now().getTime() - this.idleMs;
    const stale: string[] = [];
    for (const [id, chat] of this.chats) {
      if (chat.status === "running" || chat.touched > cutoff) continue;
      this.release(chat);
      // Marked, not merely dropped: `withhold`'s guard refuses a closed record,
      // and without it a late handler would push events onto a chat nobody
      // holds and append them to a file in the loop's worktree. The waiters
      // are woken for the same reason `close` wakes them — an open poll would
      // otherwise hang for its full 25 seconds and then 404.
      chat.status = "closed";
      chat.waiters.splice(0).forEach((wake) => wake());
      stale.push(id);
    }
    for (const id of stale) this.chats.delete(id);
  }

  /**
   * Reading a chat IS touching it.
   *
   * Without this an operator who reads a long answer and spends an hour
   * composing a follow-up — their page long-polling the whole time — loses the
   * chat the moment anyone opens another one.
   */
  private touch(chat: ChatRecord): ChatRecord {
    chat.touched = this.now().getTime();
    return chat;
  }

  private release(chat: ChatRecord): void {
    if (chat.deadline !== null) clearTimeout(chat.deadline);
    chat.deadline = null;
    chat.turn?.kill("SIGTERM");
    chat.turn = null;
    chat.filter?.stdin?.end();
    chat.filter?.kill("SIGTERM");
    chat.filter = null;
    chat.seeding?.kill("SIGTERM");
    chat.seeding = null;
    chat.endMarker = null;
  }

  /**
   * The seed, as the redactor returns it, or a rejection saying why not.
   *
   * Its own one-shot filter rather than the turn's: what comes out of the
   * turn's filter goes to the browser, and this goes to `claude` first. The
   * checks are the turn's — fail closed on any stderr, on an early or
   * non-zero exit, and on a line count that does not match — because a
   * filter that is wrong about the seed is wrong about everything else.
   */
  private redactSeed(chat: ChatRecord, raw: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let filter: import("node:child_process").ChildProcess;
      try {
        filter = this.deps.redactor();
      } catch (error) {
        reject(new Error(`the redactor could not start: ${message(error)}`));
        return;
      }
      const { stdin, stdout, stderr } = filter;
      if (stdin === null || stdout === null || stderr === null) {
        filter.kill("SIGTERM");
        reject(new Error("the redactor has no pipes to read from"));
        return;
      }
      chat.seeding = filter;
      let out = "";
      let err = "";
      let settled = false;
      const settle = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chat.seeding === filter) chat.seeding = null;
        run();
      };
      const timer = setTimeout(() => {
        filter.kill("SIGTERM");
        settle(() => reject(new Error("output withheld: the redactor did not return the evidence seed in time")));
      }, this.seedTimeoutMs);
      stdout.setEncoding("utf8");
      stdout.on("data", (piece: string) => {
        out += piece;
      });
      stderr.setEncoding("utf8");
      stderr.on("data", (piece: string) => {
        err += piece;
      });
      filter.on("error", (error) => settle(() => reject(new Error(`the redactor could not run: ${error.message}`))));
      filter.on("close", (code) =>
        settle(() => {
          const given = lineCount(raw);
          const returned = lineCount(out);
          if (err.trim() !== "") reject(new Error(`output withheld: ${err.trim().slice(0, 300)}`));
          else if (code !== 0) reject(new Error(`output withheld: the redactor exited (${code}) on the evidence seed`));
          else if (returned > given) reject(new Error("output withheld: the redactor returned more lines than it was given"));
          else if (returned < given) reject(new Error(`output withheld: the redactor returned ${returned} of ${given} lines of the evidence seed`));
          else resolve(out.endsWith("\n") ? out : `${out}\n`);
        }),
      );
      stdin.on("error", () => undefined);
      stdin.end(raw);
    });
  }

  /**
   * One redactor per turn.
   *
   * Per chat would be cheaper by one spawn, and would leave a Bun runtime
   * resident for every chat an operator ever opened — which is the shape the
   * dashboard cannot afford on the host that also runs the loops and CI.
   */
  private startFilter(chat: ChatRecord): import("node:child_process").ChildProcess | null {
    let filter: import("node:child_process").ChildProcess;
    try {
      filter = this.deps.redactor();
    } catch (error) {
      this.withhold(chat, `the redactor could not start: ${message(error)}`);
      return null;
    }
    const { stdin, stdout, stderr } = filter;
    if (stdin === null || stdout === null || stderr === null) {
      this.withhold(chat, "the redactor has no pipes to read from");
      return null;
    }
    chat.filter = filter;
    stdin.on("error", () => undefined);
    // EVERY handler is gated on the filter still being this chat's. One filter
    // per turn means a released one can still emit — a late stderr line, an
    // `error` after the SIGTERM — and an ungated handler would withhold the
    // NEXT turn, or permanently withhold an idle chat that answered correctly.
    // `iteration-output.ts` carries the same invariant on its single `stopped`
    // flag; per-turn filters need it per filter.
    const mine = (): boolean => chat.filter === filter;
    stdout.setEncoding("utf8");
    stdout.on("data", (piece: string) => {
      if (mine()) this.redacted(chat, piece);
    });
    stderr.setEncoding("utf8");
    // Fail closed, exactly as the live pane does: a redactor that complains is
    // a redactor whose patterns we cannot vouch for, and unvouched-for bytes
    // are not shown.
    stderr.on("data", (piece: string) => {
      if (mine()) this.withhold(chat, `output withheld: ${String(piece).trim().slice(0, 300)}`);
    });
    filter.on("error", (error) => {
      if (mine()) this.withhold(chat, `the redactor could not run: ${error.message}`);
    });
    filter.on("close", (code) => {
      // Expected once the turn has ended — `endTurn` closes it itself.
      if (mine()) this.withhold(chat, `the redactor exited (${code})`);
    });
    return filter;
  }

  private feed(chat: ChatRecord, line: string): void {
    chat.fed += 1;
    this.feedRaw(chat, line);
  }

  private feedRaw(chat: ChatRecord, line: string): void {
    if (chat.status !== "running") return;
    chat.filter?.stdin?.write(`${line}\n`);
  }

  private redacted(chat: ChatRecord, piece: string): void {
    if (chat.status !== "running") return;
    const lines = (chat.carry + piece).split("\n");
    chat.carry = lines.pop() ?? "";
    for (const line of lines) {
      // The WHOLE line, against the one marker this turn issued: a prefix
      // match would end the turn on anything that merely started like it.
      if (line === chat.endMarker) {
        this.endTurn(chat);
        return;
      }
      chat.out += 1;
      if (chat.out > chat.fed) {
        // More lines out than in: the filter is not the pass-through-plus-
        // redaction it is supposed to be, so nothing it says can be trusted.
        this.withhold(chat, "output withheld: the redactor returned more lines than it was given");
        return;
      }
      this.learnFork(chat, line);
      this.emit(chat, "agent", line);
    }
  }

  private endTurn(chat: ChatRecord): void {
    const { fed, out } = chat;
    // Any turn, not just a forking one: a FRESH session announces its own id
    // the same way, and without it turn 2 starts yet another new session and
    // strands this one just as a lost fork would.
    const lostFork = chat.fork === null;
    this.release(chat);
    if (out !== fed) {
      this.withhold(chat, `output withheld: the redactor returned ${out} of ${fed} lines`);
      return;
    }
    if (lostFork) {
      // The session's id is only ever announced once. Without it a later turn
      // would resume the BASE session and fork it again (or start a third
      // fresh one), stranding everything said in this turn in a branch nothing
      // points at — so stop and say so rather than carry on into a
      // conversation that silently forgets.
      this.withhold(chat, "output withheld: the session never announced its id, so later turns could not resume it");
      return;
    }
    chat.status = "idle";
    chat.touched = this.now().getTime();
    this.emit(chat, "turn-end", "");
  }

  /** The forked session's id, as the stream's first event announces it. */
  private learnFork(chat: ChatRecord, line: string): void {
    if (chat.fork !== null) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const fields = event as Record<string, unknown>;
    // `system`/`init` specifically: a real stream emits several events before
    // it, and some of them carry a `session_id` of their own. Latching the
    // first one seen would resume something that is not the fork.
    if (fields.type !== "system" || fields.subtype !== "init") return;
    if (typeof fields.session_id === "string" && fields.session_id !== "") chat.fork = fields.session_id;
  }

  private withhold(chat: ChatRecord, reason: string): void {
    if (chat.status === "withheld" || chat.status === "closed") return;
    const wasRunning = chat.status === "running";
    chat.status = "running";
    // Everything stopped first: output that cannot be shown must not go on
    // spending tokens, and the reason has to reach the operator.
    this.release(chat);
    this.emit(chat, "withheld", reason);
    chat.status = "withheld";
    if (!wasRunning) chat.touched = this.now().getTime();
  }

  private emit(
    chat: ChatRecord,
    kind: ChatEvent["kind"],
    text: string,
    mode?: ChatMode,
    handback?: { step: HandbackStep; outcome: HandbackOutcome },
  ): void {
    const event: ChatEvent = {
      seq: chat.events.length + 1,
      at: this.now().toISOString(),
      kind,
      text,
      ...(mode === undefined ? {} : { mode }),
      ...(handback === undefined ? {} : handback),
    };
    chat.events.push(event);
    // The transcript is the durable half, so a failed append is a fact the
    // operator should see — it is reported on the chat's own view — but it
    // must not take the chat down, which would lose the answer already on
    // screen.
    try {
      this.io.appendFileSync(chat.transcript, `${JSON.stringify(event)}\n`);
    } catch (error) {
      chat.transcriptProblem = `the transcript could not be written: ${message(error)}`;
    }
    chat.waiters.splice(0).forEach((wake) => wake());
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `20261007T150600Z`: the journal's own timestamp shape (`publish-journal.ts`'s `DRAFT_NAME`). */
const compactStamp = (at: Date): string => `${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;

/**
 * The summary a draft turn wrote, out of its redacted stream-json lines, or
 * why there is none.
 *
 * The `result` event is the turn's final answer and is preferred; a turn that
 * ended without one (an older CLI, a cut-off stream) falls back to the
 * assistant's text blocks. A `result` that is an error — the turn bound hit,
 * the budget spent — is a failure, said in the CLI's own words.
 */
export function draftFrom(events: readonly ChatEvent[]): string | { why: string } {
  let result: string | null = null;
  let error: string | null = null;
  const texts: string[] = [];
  for (const event of events) {
    if (event.kind !== "agent") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.text);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const fields = parsed as Record<string, unknown>;
    if (fields.type === "result") {
      if (fields.is_error === true || (typeof fields.subtype === "string" && fields.subtype !== "success")) {
        error = typeof fields.subtype === "string" ? fields.subtype : "the turn ended in an error";
      } else if (typeof fields.result === "string") {
        result = fields.result;
      }
    }
    if (fields.type === "assistant") {
      const content = (fields.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") texts.push(text);
        }
      }
    }
  }
  const text = (result ?? (error === null ? texts.join("\n\n") : "")).trim();
  if (text === "") {
    return { why: error === null ? "the agent wrote no summary" : `the agent wrote no summary (${error}); write the decision yourself` };
  }
  return text.length > CHAT_DRAFT.maxChars ? `${text.slice(0, CHAT_DRAFT.maxChars).trimEnd()}…` : text;
}

/** Lines in a text, a last one without its newline included. */
const lineCount = (text: string): number => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/**
 * The two processes a chat runs, as the server starts them.
 *
 * The redactor is the live pane's own factory, so there is one definition of
 * which filter the dashboard trusts rather than two that can drift. `claude`
 * runs in the loop's checkout with the DASHBOARD's environment for an Ask
 * turn — the loop's own is not ours to reconstruct, and the redactor strikes
 * this process's secret values on the way out, which is the pass the live
 * pane makes too. A Fix turn runs with the executor's cleared environment
 * (`executorEnv`), because the executor's rails assume it: everything a Fix
 * turn may run, the executor may run with no secret in reach.
 */
export function createChatRunner(config: { bunPath: string; cliDir: string; env?: NodeJS.ProcessEnv }): ChatDeps {
  const env = config.env ?? process.env;
  return {
    claude: (args, cwd, mode, sandbox) =>
      spawn(CHAT_COMMAND.bin, args, {
        cwd,
        // stdin is the operator's message; see `CHAT_COMMAND.args`.
        stdio: ["pipe", "pipe", "pipe"],
        // A Fix turn gets the executor's cleared environment, never ours;
        // both get what their sandbox needs laid over it (`sandboxEnv`).
        env: { ...(mode === "fix" ? executorEnv(env, config.cliDir) : env), ...sandbox },
      }),
    redactor: createRedactor({
      bunPath: config.bunPath,
      cliDir: config.cliDir,
      ...(config.env === undefined ? {} : { env: config.env as Record<string, string | undefined> }),
    }),
    // The checkout the redactor runs from is the harness, `$RALPH_HOME`, and
    // so is the `bk-log.ts` Ask mode allows.
    harness: config.cliDir,
    // The bun the dashboard runs is the bun a Fix turn's gates run.
    toolRoots: toolRootsOf(config.bunPath),
  };
}
