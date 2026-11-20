#!/usr/bin/env bun
/**
 * Phase control: an iteration yields to the supervisor at each phase boundary.
 *
 * An iteration used to be one opaque model turn. The supervisor could act only
 * between iterations, because `claude -p` (or `codex exec`) holds the whole
 * ticket — select, build, verify, review, ship — inside a single session it
 * neither reads nor interrupts. So the orchestrator now ends its session at
 * each boundary between two phases with `<ralph>PHASE <next> <n></ralph>`, the
 * same way `AWAIT_PR` hands the CI wait back. The supervisor records the
 * boundary and RESUMES THE SAME SESSION: the context carries over, so the
 * normal path costs one short extra turn per boundary and nothing else.
 *
 * This module is the one place the phase vocabulary lives, and it owns what a
 * boundary leaves on disk:
 *
 * - the roster, in `prompt.md`'s section order (`PHASES`);
 * - the sigil and its precedence against every other ending (`sessionSignal`);
 * - the per-phase handoff note the orchestrator writes (`notePath`);
 * - the per-ticket phase ledger the supervisor appends to (`ledgerPath`);
 * - the short message a resumed session is handed (`resumePrompt`).
 *
 * What survives a boundary is the branch, the briefs, the handoff note and the
 * ledger. The model's in-context reasoning is allowed to be lost — nothing here
 * depends on the session being resumable, only on the notes being written.
 *
 * `phase_checkpoint` in `ralph.sh` is where a control acts on a boundary: a
 * pause or stop sent with `"scope": "phase"` holds or ends the iteration there,
 * and a `retry-phase` sent while it is held runs the phase just finished again
 * in a fresh session (`ralph/controls.ts`, `ralph/phase-prompt.ts`). A gate
 * armed before the next phase holds it there for approval.
 *
 * The ledger is also how an iteration interrupted between phases is picked up:
 * each line records the branch and the head it was written on, and the next
 * iteration that resumes the claim starts a fresh session at the phase after
 * the last one finished, once the worktree still agrees with the ledger
 * (`resumePoint` in `ralph/phase-prompt.ts`). The ticket's iteration finishing
 * — DONE, a release, an abandon — clears it (`clearLedger`).
 *
 * Kept free of other ralph imports so `loop-state.ts`, the supervisor tests'
 * scratch harness and the per-phase prompt builder (`phase-prompt.ts`) can all
 * load it alone.
 *
 * Usage:
 *   ralph/phase.ts boundary --from <phase> --next <phase> [--ticket N] [--iteration I] [--retry]
 *                           [--branch B] [--head SHA]
 *     Appends the finished phase to the ticket's ledger (when the ticket is
 *     known) and prints the prompt the resumed session is handed. `--retry`
 *     says the phase that finished was an operator's retry of it; `--branch`
 *     and `--head` are the checkout the phase finished on.
 *   ralph/phase.ts clear --ticket N
 *     Removes the ticket's ledger and handoff notes: its iteration finished.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The five phases, in the order `prompt.md` walks them. A phase may be skipped
 * (a shepherded PR goes from `select` straight to `finish`) but never reordered
 * here without moving the prompt's boundaries with it.
 */
export const PHASES = ["select", "implement", "verify", "review", "finish"] as const;
export type Phase = (typeof PHASES)[number];

export const isPhase = (value: unknown): value is Phase =>
  typeof value === "string" && (PHASES as readonly string[]).includes(value);

/** Where each phase lives in `prompt.md`, for the resumed session and for a per-phase prompt builder. */
export const PHASE_SECTIONS: Record<Phase, string> = {
  select: "§0–§2 and the reading at the top of §3: orient, take one task, claim it, and map it",
  implement: "§3: brief, delegate, review the diff, and commit, one slice at a time",
  verify: "§4: run the local gates and fix what they find",
  review: "§5.1–§5.2: the two-axis local review, then the claim re-check",
  finish: "§5.3 onward and §6: PR, CI, merge, cleanup, and the journal",
};

/**
 * The phase sigil, as a regular expression source both readers share.
 * `ralph.sh` carries the same text as `PHASE_SIGIL`; `phase.test.ts` fails if
 * the two drift. The ticket is optional in the grammar so a sigil that omits it
 * still yields — the supervisor then asks the tracker for this loop's claim.
 */
export const PHASE_SIGIL_SOURCE = `<ralph>PHASE (${PHASES.join("|")})( #?[0-9]+)?</ralph>`;

/**
 * The terminal sigils, in the precedence `ralph.sh` settles them: a fault
 * outranks everything, an external block outranks the rest, and DONE is last.
 */
export const STOP_SIGILS = ["NEEDS_TRIAGE", "RETRY_LATER", "COMPLETE", "ALL_BLOCKED", "DONE"] as const;
export type StopSigil = (typeof STOP_SIGILS)[number];

export type SessionSignal =
  | { kind: "stop"; sigil: StopSigil }
  | { kind: "host"; ticket: number }
  | { kind: "await"; pr: number; mode: "ci" | "merge" }
  | { kind: "phase"; next: Phase; ticket: number | null }
  | { kind: "none" };

const AWAIT = /<ralph>AWAIT_PR ([0-9]+)(?: (ci|merge))?<\/ralph>/g;
const HOST = /<ralph>AWAIT_HOST #?([0-9]+)<\/ralph>/g;

/**
 * How the supervisor reads a session's final message, in one precedence order:
 *
 *   1. a terminal sigil ends the iteration, whatever else the message carries;
 *   2. `AWAIT_HOST` asks for a quiet host (`host-lease.ts`), and the SAME
 *      session resumes with the answer;
 *   3. `AWAIT_PR` hands the wait to the supervisor and a FRESH session;
 *   4. a valid `PHASE` sigil yields at a boundary and the SAME session resumes;
 *   5. anything else, a malformed `PHASE` included, is no sigil at all, which
 *      is the missing-sigil recovery's to handle — never a hang.
 *
 * Within one kind the last occurrence wins, as `ralph.sh`'s `tail -n 1` does.
 * The greps there are unanchored, so this is too.
 */
export function sessionSignal(final: string): SessionSignal {
  for (const sigil of STOP_SIGILS) {
    if (final.includes(`<ralph>${sigil}</ralph>`)) return { kind: "stop", sigil };
  }
  const lastHost = [...final.matchAll(HOST)].at(-1);
  if (lastHost) return { kind: "host", ticket: Number(lastHost[1]) };
  const awaits = [...final.matchAll(AWAIT)];
  const lastAwait = awaits.at(-1);
  if (lastAwait) {
    return { kind: "await", pr: Number(lastAwait[1]), mode: lastAwait[2] === "merge" ? "merge" : "ci" };
  }
  const phases = [...final.matchAll(new RegExp(PHASE_SIGIL_SOURCE, "g"))];
  const lastPhase = phases.at(-1);
  if (lastPhase && isPhase(lastPhase[1])) {
    const ticket = lastPhase[2] ? Number(lastPhase[2].replace(/[ #]/g, "")) : null;
    return { kind: "phase", next: lastPhase[1], ticket };
  }
  return { kind: "none" };
}

/** The handoff note the orchestrator writes as it finishes `phase` of ticket `ticket`. */
export const notePath = (ticket: number, phase: Phase): string => `.ralph/logs/phase-${ticket}-${phase}.md`;

/**
 * The per-ticket ledger: one JSON line per finished phase, appended, never
 * rewritten. A phase that finishes again — retried by an operator, or run again
 * by a later iteration — gets a new line with the next `attempt`, which
 * SUPERSEDES the earlier ones without removing them: `readLedger` answers with
 * the latest attempt of each phase, `readLedgerHistory` with every attempt.
 */
export const LEDGER_DIR = ".ralph/logs/phases";
export const ledgerPath = (ticket: number): string => `${LEDGER_DIR}/${ticket}.jsonl`;

export interface LedgerEntry {
  version: 1;
  ticket: number;
  /** The phase that just finished. */
  phase: Phase;
  /** The phase the sigil named, which the resumed session starts. */
  next: Phase;
  /** The finished phase's handoff note, relative to the worktree; null when it was not written. */
  note: string | null;
  at: string;
  run: string | null;
  iteration: number | null;
  session: string | null;
  /**
   * Which time this phase finished on this ticket, from 1. A line written
   * before attempts were counted reads as 1. The latest line of a phase is the
   * one that counts; the earlier ones are superseded.
   */
  attempt: number;
  /** True when an operator's `retry-phase` ordered this attempt. */
  retry: boolean;
  /**
   * The branch and the commit the checkout was on when the phase finished,
   * which is what a resume checks the worktree against. Absent when they were
   * not known — a detached HEAD, or a line written before they were recorded —
   * and a line without both cannot be resumed from.
   */
  branch?: string;
  head?: string;
}

/** A ledger line as the audit history reads it: whether a later attempt of its phase replaced it. */
export interface LedgerRow extends LedgerEntry {
  superseded: boolean;
}

/**
 * Append one finished phase. Append-only on purpose: the ledger is how an
 * interrupted iteration will be resumed, and a rewrite interrupted halfway is
 * a ledger with nothing in it. A single `appendFileSync` of one line is one
 * `O_APPEND` write, which a concurrent reader never sees torn.
 */
export function appendLedger(root: string, entry: LedgerEntry): void {
  const path = join(root, ledgerPath(entry.ticket));
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Every well-formed entry of one ticket's ledger, oldest first, each marked
 * with whether a later line of the same phase superseded it. This is the audit
 * history: a retried phase shows every attempt. Malformed lines are skipped.
 */
export function readLedgerHistory(root: string, ticket: number): LedgerRow[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, ledgerPath(ticket)), "utf8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<LedgerEntry>;
      if (value.version === 1 && value.ticket === ticket && isPhase(value.phase) && isPhase(value.next)) {
        const attempt = Number.isSafeInteger(value.attempt) && value.attempt! > 0 ? value.attempt! : 1;
        const { branch, head, ...rest } = value as LedgerEntry;
        entries.push({
          ...rest,
          attempt,
          retry: value.retry === true,
          ...(typeof branch === "string" && branch.trim() !== "" ? { branch: branch.trim() } : {}),
          ...(typeof head === "string" && head.trim() !== "" ? { head: head.trim() } : {}),
        });
      }
    } catch {
      // A line cut short by a kill is not a ledger.
    }
  }
  // Position decides, not the recorded number: the ledger is append-only, so
  // a later line is a later finish whatever attempt it carries.
  return entries.map((entry, at) => ({
    ...entry,
    superseded: entries.slice(at + 1).some((later) => later.phase === entry.phase),
  }));
}

/**
 * The ledger as it stands: the latest attempt of each phase, in the order the
 * attempts were written, with every superseded one left out. Its last entry is
 * where the ticket's work got to.
 */
export function readLedger(root: string, ticket: number): LedgerEntry[] {
  return readLedgerHistory(root, ticket)
    .filter((row) => !row.superseded)
    .map(({ superseded: _superseded, ...entry }) => entry);
}

/**
 * Forget a ticket's phases: its ledger and every handoff note. Called when the
 * ticket's iteration has finished — DONE, a release, an abandon — so a later
 * claim of the same ticket starts from the top rather than resuming work that
 * is merged or given up. Best effort: a file that cannot be removed is left,
 * and a resume from it is still checked against the worktree first.
 */
export function clearLedger(root: string, ticket: number): void {
  for (const path of [ledgerPath(ticket), ...PHASES.map((phase) => notePath(ticket, phase))]) {
    try {
      rmSync(join(root, path), { force: true });
    } catch {
      // Left behind; see above.
    }
  }
}

export interface Boundary {
  from: Phase;
  next: Phase;
  ticket: number | null;
  /** The finished phase's note when it exists on disk, else null. */
  note: string | null;
}

/**
 * What a resumed session is told. Short on purpose: it is one more turn on a
 * context that already holds this prompt, so it says only what changed.
 */
export function resumePrompt(boundary: Boundary): string {
  const { from, next, ticket } = boundary;
  const ref = ticket === null ? "<n>" : String(ticket);
  const expected = ticket === null ? `.ralph/logs/phase-<n>-${from}.md` : notePath(ticket, from);
  const note =
    boundary.note !== null
      ? `Your \`${from}\` handoff note is \`${boundary.note}\`.`
      : `No \`${from}\` handoff note was found at \`${expected}\`: write it now, before anything else.`;
  const following = PHASES[PHASES.indexOf(next) + 1];
  return [
    `Phase boundary recorded${ticket === null ? "" : ` for #${ticket}`}: \`${from}\` → \`${next}\`. The supervisor resumed this same session, so your context carries over. ${note}`,
    "",
    `Continue with the \`${next}\` phase — ${PHASE_SECTIONS[next]}.`,
    following
      ? `At its end, write its note and end with \`<ralph>PHASE ${following} ${ref}</ralph>\` (or name the phase you actually go to next), exactly as §Phases says.`
      : "There are no more boundaries: finish the iteration and end with one of the endings in §6, per the HARD RAIL.",
  ].join("\n");
}

/* --------------------------------------------------------------------------
 * CLI.
 * ----------------------------------------------------------------------- */

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
}

const USAGE = [
  "usage: phase.ts boundary --from <phase> --next <phase> [--ticket N] [--iteration I] [--retry] [--branch B] [--head SHA]",
  "       phase.ts clear --ticket N",
].join("\n");

const positive = (raw: string | undefined): number | null =>
  raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;

export function main(argv: string[], root: string, env: Record<string, string | undefined>, now: Date): { code: number; out: string } {
  const [mode, ...rest] = argv;
  if (mode === "boundary") {
    const from = flag(rest, "from");
    const next = flag(rest, "next");
    if (!isPhase(from) || !isPhase(next)) return { code: 64, out: USAGE };
    const ticket = positive(flag(rest, "ticket"));
    const expected = ticket === null ? null : notePath(ticket, from);
    const note = expected !== null && existsSync(join(root, expected)) ? expected : null;
    // A ledger that cannot be written costs the record, never the resume: the
    // session is waiting on this prompt either way.
    if (ticket !== null) {
      try {
        appendLedger(root, {
          version: 1,
          ticket,
          phase: from,
          next,
          note,
          at: now.toISOString(),
          run: env.RALPH_RUN_ID?.trim() || null,
          iteration: positive(flag(rest, "iteration")),
          session: env.RALPH_SESSION_ID?.trim() || null,
          attempt: readLedgerHistory(root, ticket).filter((entry) => entry.phase === from).length + 1,
          retry: rest.includes("--retry"),
          ...(flag(rest, "branch")?.trim() ? { branch: flag(rest, "branch")!.trim() } : {}),
          ...(flag(rest, "head")?.trim() ? { head: flag(rest, "head")!.trim() } : {}),
        });
      } catch (error) {
        console.error(`phase: could not append to ${ledgerPath(ticket)}: ${String(error)}`);
      }
    }
    return { code: 0, out: resumePrompt({ from, next, ticket, note }) };
  }
  if (mode === "clear") {
    const ticket = positive(flag(rest, "ticket"));
    if (ticket === null) return { code: 64, out: USAGE };
    clearLedger(root, ticket);
    return { code: 0, out: `cleared the phase ledger of #${ticket}` };
  }
  return { code: 64, out: USAGE };
}

if (import.meta.main) {
  const { code, out } = main(process.argv.slice(2), process.cwd(), process.env, new Date());
  if (code === 0) process.stdout.write(`${out}\n`);
  else console.error(out);
  process.exitCode = code;
}
