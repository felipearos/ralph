/**
 * The unblocker chat's first turn: the evidence the operator would otherwise
 * read by hand, in front of their first question (#253).
 *
 * The agent that hit the block knows why, but a fork resumed hours later — or
 * a fresh session, when there is nothing to resume — answers "why are you
 * blocked?" best from the record, not from memory. So the first operator turn
 * is prefixed with one fenced preamble that says who is talking, that nothing
 * said here reaches the loop, and then quotes the four places the loop wrote
 * the block down:
 *
 *   - the newest block record on the ticket, as `block-reason.ts` reads it
 *     for the frontier's `stuckReasons`;
 *   - `state.json`'s `stopReason`, as the loop panel carries it;
 *   - the iteration's journal entry, as the adapter lists it;
 *   - the tail of the iteration log, through `iteration-output.ts`.
 *
 * Every one is a reader the dashboard already has; this module adds none. It
 * is PURE — text in, text out — and it is not where redaction happens: the
 * string it returns is raw, and `chat.ts` puts the whole of it through the
 * live pane's redactor before a byte reaches `claude` or the browser.
 */
import type { BlockKind, JournalEntryView } from "./contracts";

/** How much of the iteration log the seed quotes. */
export const SEED_LOG_LINES = 80;
/**
 * And how much of any one line. `stream-render.py` flattens a whole tool
 * result onto a single line, so eighty lines can otherwise be megabytes.
 */
export const SEED_LINE_CHARS = 2_000;

/** The newest block record on the ticket, narrowed from a `StuckReason`. */
export interface SeedBlock {
  kind: BlockKind;
  reason: string | null;
  pr: number | null;
  migration: string | null;
  at: string | null;
}

/** What the dashboard already read about the block, handed to the chat. */
export interface ChatEvidence {
  /** The ticket the block is about: the one asked after, else the loop's own. */
  ticket: number | null;
  /** Null when the frontier holds no block record for the ticket, or was not read. */
  block: SeedBlock | null;
  /** This loop's journal, newest first; null when it could not be read. */
  journal: readonly JournalEntryView[] | null;
}

export const NO_EVIDENCE: ChatEvidence = { ticket: null, block: null, journal: null };

/** The tools Ask mode allows, as the preamble names them to the agent. */
export const ASK_TOOLS_PROSE = (harness: string): string =>
  [
    `Read, Grep and Glob inside this worktree and ${harness} (secrets such as \`.env\` are denied)`,
    "`gh issue view`",
    "`gh pr view`",
    "`gh pr checks`",
    "`git log`",
    "`git diff`",
    "`git show`",
    `\`bun ${harness}/bk-log.ts\``,
    `\`bun ${harness}/tracker.ts view <n>\` (the ticket on a Linear or Jira project)`,
  ].join(", ");

export interface SeedInput {
  loop: string;
  worktree: string;
  /** The harness checkout, `$RALPH_HOME`, for the `bk-log.ts` path. */
  harness: string;
  stopReason: { kind: string; why: string; at?: string } | null;
  /** The session this chat forks, or null when it starts fresh. */
  session: string | null;
  /** Where the session was found, or why there is none. */
  source: string | null;
  why: string | null;
  /** The iteration log the block was traced to, when one was. */
  log: string | null;
  /** That log's raw tail, or null when it could not be read. */
  tail: readonly string[] | null;
  evidence: ChatEvidence;
}

/**
 * The journal entry for this iteration.
 *
 * By session first: an entry's name carries the first twelve characters of
 * the session that wrote it (`prompt.md`'s `${sid:0:12}`), so a resolved
 * session names its own entry exactly. A halted iteration usually published
 * none, and a fresh session has no id to match, so the fallback is the
 * newest entry about the ticket. Never "the newest entry" alone: that is
 * some other iteration's, and quoting it as this one's would mislead.
 */
export function journalEntryFor(
  journal: readonly JournalEntryView[] | null,
  session: string | null,
  ticket: number | null,
): JournalEntryView | null {
  if (journal === null) return null;
  if (session !== null && session.length >= 12) {
    const fragment = `-${session.slice(0, 12)}`;
    const own = journal.find((entry) => entry.name.includes(fragment));
    if (own !== undefined) return own;
  }
  if (ticket === null) return null;
  return journal.find((entry) => entry.issue === ticket) ?? null;
}

const clip = (line: string): string =>
  line.length > SEED_LINE_CHARS ? `${line.slice(0, SEED_LINE_CHARS - 1)}…` : line;

/**
 * A fence no quoted line can close. The log tail is arbitrary text and may
 * well carry a fence of its own; a run of tildes one longer than any in the
 * body keeps the preamble one block whatever it quotes.
 */
/**
 * What the agent is told about its mode. The seed carries Ask's; a turn sent
 * after the operator changes the mode carries the new one (`modeNotice`), so
 * an agent forked under Ask's rails is not left believing it cannot edit, or
 * one sent back to Ask that it still can.
 */
export function modeLine(mode: "ask" | "fix", harness: string): string {
  return mode === "ask"
    ? `Mode: Ask, read-only. Allowed: ${ASK_TOOLS_PROSE(harness)}. Everything else is refused, every edit included: do not try to change the worktree, push, or comment. Shell readers (\`cat\`, \`grep\`, \`sed\` and the like) are refused too; read files with Read and search them with Grep.`
    : "Mode: Fix. The operator stopped the loop and gave you its executor's rails in this worktree: you may edit files and run commands here. What the executor is denied is refused — commits, pushes, `gh`, `curl`, migrations, other agents — and so are secrets such as `.env` and the shell readers (`cat`, `grep`, `sed` and the like); read files with Read and search them with Grep. Leave the changes for the operator to review; nothing reaches the loop unless they hand it back.";
}

/** The fenced note a turn carries when the mode changed since the agent was last told it. */
export function modeNotice(mode: "ask" | "fix", harness: string): string {
  const body = `The operator changed this chat's mode; this replaces any earlier mode line.\n${modeLine(mode, harness)}`;
  const fence = fenceFor(body);
  return `${fence} operator-chat\n${body}\n${fence}\n`;
}

/**
 * What Unblock & resume's draft turn says to the agent (#255): write the
 * operator-decision summary, in the three parts the ticket comment and the
 * journal entry carry. One reply, no tools — the turn is bounded to one
 * (`CHAT_DRAFT` in `chat.ts`), and a tool call would spend it.
 */
export const HANDBACK_DRAFT_PROMPT = ((): string => {
  const body = [
    "The operator is handing this block back to the loop (Unblock & resume). Write the operator-decision summary they will post on the ticket and in the journal, from this conversation alone.",
    "Do not use any tool: this turn allows one reply and nothing else.",
    "",
    "Three short parts, in Markdown, at most 200 words in all:",
    "**What was wrong** — the block, in a sentence or two.",
    "**What was decided** — what the operator decided or did, including anything changed in the worktree.",
    "**What the loop should do next** — concrete instructions for the loop's next iteration on this ticket.",
    "",
    "Reply with the summary only: no preamble and no sign-off.",
  ].join("\n");
  const fence = fenceFor(body);
  return `${fence} operator-chat\n${body}\n${fence}`;
})();

function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/~+/g)].map((run) => run[0].length));
  return "~".repeat(Math.max(4, longest + 1));
}

function blockSection(evidence: ChatEvidence, loop: string): string[] {
  const ticket = evidence.ticket;
  const heading = ticket === null ? "## Block comment" : `## Block comment on #${ticket}`;
  if (ticket === null) return [heading, "No ticket is attached to this halt, so there is no block comment to quote."];
  const block = evidence.block;
  if (block === null) {
    return [heading, `No block record was found on #${ticket} (no \`${loop}-blocked\` comment, or the backlog could not be read).`];
  }
  const facts = [`kind: ${block.kind}`];
  if (block.at !== null) facts.push(`posted ${block.at}`);
  if (block.pr !== null) facts.push(`PR #${block.pr}`);
  if (block.migration !== null) facts.push(`migration ${block.migration}`);
  return [heading, facts.join(" · "), block.reason === null ? "(the record carries no reason line)" : `> ${clip(block.reason)}`];
}

function stopSection(stop: SeedInput["stopReason"]): string[] {
  const heading = "## Stop reason (state.json)";
  if (stop === null) return [heading, "None recorded: the loop has not stopped, or its record names no reason."];
  return [heading, `${stop.kind}${stop.at === undefined ? "" : ` at ${stop.at}`}: ${clip(stop.why)}`];
}

function journalSection(entry: JournalEntryView | null): string[] {
  const heading = "## Journal entry";
  if (entry === null) return [heading, "None found for this iteration or ticket."];
  const lines = [heading, `${entry.name}${entry.title === null ? "" : ` — ${clip(entry.title)}`}`];
  if (entry.outcome !== null) lines.push(`Outcome: ${clip(entry.outcome)}`);
  return lines;
}

function logSection(log: string | null, tail: readonly string[] | null): string[] {
  if (log === null) return ["## Iteration log", "No iteration log was traced for this block."];
  if (tail === null) return [`## Iteration log (${log})`, "The log could not be read."];
  return [`## Iteration log (${log}, last ${tail.length} lines)`, ...tail.map(clip)];
}

/**
 * The preamble, ending in a newline, that goes in front of the first turn.
 *
 * It says plainly which of the two sessions this is: a fork of the loop's
 * own, or a fresh one with only the evidence to go on. An answer from a
 * fresh session that sounded like the loop's memory would be the chat
 * inventing context it does not have.
 */
export function buildSeed(input: SeedInput): string {
  const who = [
    "You are being addressed by the OPERATOR, a person, from the Ralph dashboard's unblocker chat — not by the loop's supervisor and not by a ticket.",
    "",
    input.session !== null
      ? `This is a FORK of the session that hit the block (${input.session}${input.source === null ? "" : `, traced through ${input.source}`}). The loop's own session is untouched, and nothing said here reaches the loop unless the operator hands it back.`
      : `There is NO resumable session for this block: ${input.why ?? "none was found"}. This is a FRESH claude session seeded with the same evidence; it does not hold the loop's own history, so say so when a question needs it. Nothing said here reaches the loop unless the operator hands it back.`,
    "",
    modeLine("ask", input.harness),
    "",
    `Loop: ${input.loop} · worktree: ${input.worktree}${input.evidence.ticket === null ? "" : ` · ticket: #${input.evidence.ticket}`}`,
  ];
  const sections = [
    blockSection(input.evidence, input.loop),
    stopSection(input.stopReason),
    journalSection(journalEntryFor(input.evidence.journal, input.session, input.evidence.ticket)),
    logSection(input.log, input.tail),
  ];
  const body = [...who, ...sections.flatMap((section) => ["", ...section])].join("\n");
  const fence = fenceFor(body);
  return `${fence} operator-chat\n${body}\n${fence}\n`;
}
