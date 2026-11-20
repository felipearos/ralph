#!/usr/bin/env bun
/**
 * A hard token cap on one iteration, enforced from outside the model.
 *
 * The prompt can ask an iteration to stop; only the supervisor can make it.
 * On 2026-09-19 one rulo iteration spent 549M tokens (~$294) on a single
 * ticket while every other iteration of that week stayed under 70M — the
 * prompt's handoff rules were there and were not followed. This watches the
 * iteration's structured events (`iter-*.events.jsonl`, which every session of
 * the iteration appends to) and ends the session when the count passes the cap.
 *
 * TOKENS, not dollars, deliberately. The harness prices nothing (see
 * `dashboard/usage.ts`): a cost is one a runner reported, and a runner reports
 * it only at the end of a session — too late to stop anything. Tokens are in
 * every assistant event as it happens, and they are what cost scales with: an
 * iteration's spend is turns × context, and this counts exactly that product.
 *
 * Counted per API message: every content block of one message repeats its
 * usage, so the id is the unit and the largest figure per field wins. The sum
 * is input + output + cache reads + cache writes.
 *
 *   count --events F [--session S]
 *       print the total, optionally for one session only.
 *   watch --events F --limit N --session S --marker M [--only-session]
 *         [--interval seconds] [--supervisor pid]
 *       tail F; past N, write M (JSON: used, limit, session) and SIGTERM every
 *       process whose command line runs session S (`--session-id S` or
 *       `--resume S`), then SIGKILL what is left 10s later. Exits 3 when it
 *       tripped, 0 when the supervisor it serves is gone. `--only-session`
 *       counts S alone, for a follow-up turn with a cap of its own.
 *
 * A marker the supervisor finds after the turn is the whole interface: the
 * supervisor, not this script, decides what a stopped iteration does next.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Running per-message totals over an events stream fed in chunks. */
export class TokenTally {
  private readonly messages = new Map<string, MessageUsage>();
  private partial = "";

  constructor(private readonly onlySession: string | null = null) {}

  /** Feed raw bytes as they arrive; a trailing partial line waits for the rest. */
  feed(chunk: string): void {
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  line(line: string): void {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type !== "assistant") return;
    if (this.onlySession !== null && event.session_id !== this.onlySession) return;
    const message = event.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const id = typeof message?.id === "string" ? message.id : null;
    if (id === null || usage === undefined) return;
    const seen = this.messages.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.messages.set(id, {
      input: Math.max(seen.input, count(usage.input_tokens)),
      output: Math.max(seen.output, count(usage.output_tokens)),
      cacheRead: Math.max(seen.cacheRead, count(usage.cache_read_input_tokens)),
      cacheWrite: Math.max(seen.cacheWrite, count(usage.cache_creation_input_tokens)),
    });
  }

  get total(): number {
    let sum = 0;
    for (const usage of this.messages.values()) sum += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    return sum;
  }
}

/** Reads whatever was appended to a file since the last call. */
class Tail {
  private offset = 0;

  constructor(private readonly path: string) {}

  read(): string {
    if (!existsSync(this.path)) return "";
    const size = statSync(this.path).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return "";
    const fd = openSync(this.path, "r");
    try {
      const buffer = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
}

/** Pids whose command line runs `session` — `claude --session-id S` or `--resume S`. */
export function sessionPids(session: string, psOutput: string, self: number): number[] {
  const pattern = new RegExp(`(^|\\s)--(session-id|resume)\\s+${session.replace(/[^0-9A-Za-z-]/g, "")}(\\s|$)`);
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (pid !== self && pattern.test(match[2]!)) pids.push(pid);
  }
  return pids;
}

const listProcesses = (): string => spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout ?? "";

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function flag(argv: string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1]! : null;
}

const USAGE =
  "usage: iteration-budget.ts count --events F [--session S]\n" +
  "       iteration-budget.ts watch --events F --limit N --session S --marker M [--only-session] [--interval s] [--supervisor pid]";

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const events = flag(rest, "events");
  if (events === null || (command !== "count" && command !== "watch")) {
    console.error(USAGE);
    return 64;
  }

  if (command === "count") {
    const tally = new TokenTally(flag(rest, "session"));
    tally.feed(new Tail(events).read() + "\n");
    console.log(String(tally.total));
    return 0;
  }

  const limit = Number(flag(rest, "limit"));
  const session = flag(rest, "session");
  const marker = flag(rest, "marker");
  const interval = Number(flag(rest, "interval") ?? "5");
  const supervisor = Number(flag(rest, "supervisor") ?? "0");
  if (!Number.isFinite(limit) || limit <= 0 || session === null || marker === null || !(interval > 0)) {
    console.error(USAGE);
    return 64;
  }

  const tally = new TokenTally(rest.includes("--only-session") ? session : null);
  const tail = new Tail(events);
  for (;;) {
    tally.feed(tail.read());
    if (tally.total > limit) {
      writeFileSync(
        marker,
        JSON.stringify({ session, used: tally.total, limit, at: new Date().toISOString() }) + "\n",
      );
      const pids = sessionPids(session, listProcesses(), process.pid);
      console.error(`iteration-budget: ${tally.total} tokens > ${limit}; stopping session ${session} (pids ${pids.join(" ") || "none"})`);
      signal(pids, "SIGTERM");
      await sleep(10_000);
      signal(sessionPids(session, listProcesses(), process.pid), "SIGKILL");
      return 3;
    }
    if (supervisor > 0 && !alive(supervisor)) return 0;
    await sleep(interval * 1000);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`iteration-budget: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
