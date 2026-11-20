/**
 * The loop page's live pane: what the loop is printing, as it prints it.
 *
 * The source is the rendered iteration log, `.ralph/logs/iter-<ts>.log` — what
 * `stream-render.py` writes for a human, not the raw event stream. The newest
 * one is the pane, so the pane follows the loop into its next iteration and,
 * with no loop running, shows the last one's tail.
 *
 * READ-ONLY. This module opens files for reading and spawns exactly one
 * process: the harness's own redactor, `runner-failure.ts redact`, as a stdin →
 * stdout filter without `--done`, so it writes nothing to disk. The filter's
 * stdin carries the log's lines and this module's own reset markers and skip
 * notes; no request body reaches it, and nothing here can write to a loop's
 * terminal or start a loop.
 *
 * REDACTED OR NOTHING. Every byte shown has come out of that filter, the same
 * `runner-signals.json` redaction notifications and failure records use, so
 * there is no second copy of the patterns to drift. The filter fails closed —
 * with no patterns it says so on stderr and discards its input — and any
 * stderr, or the filter ending early, withholds the pane with that reason. A
 * skipped bad pattern withholds it too: a pattern file the harness only half
 * reads is not one to vouch for.
 *
 * The filter strikes secret values from the DASHBOARD's environment, not the
 * loop's. That is the second pass: `stream-render.py` already struck the
 * loop's own values, under the loop's environment, before the log was written.
 *
 * CHEAP WHEN IDLE. A follower stats its one log per poll, lists the directory
 * every few polls, and reads only the bytes appended since the last read. Stop
 * it and the timer and the filter go with it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as nodeFs from "node:fs";
import { join } from "node:path";

import type { OutputEvent } from "./contracts";

/** The only command this module runs, pinned by `read-only.test.ts`. */
export const REDACT_COMMAND = { script: "runner-failure.ts", args: ["redact"] } as const;

const LOGS_DIR = join(".ralph", "logs");
/** `ralph.sh`'s `iter-${ts}.log`; every sidecar beside it carries a pid or a suffix. */
const ITERATION_LOG = /^iter-\d{8}T\d{6}\.log$/;
const NEWLINE = 0x0a;
const READ_CHUNK = 64 * 1024;
/** A line that never ends is shown anyway past this, rather than held forever. */
const MAX_CARRY = 1024 * 1024;

export type OutputIO = Pick<typeof nodeFs, "readdirSync" | "statSync" | "openSync" | "readSync" | "closeSync">;

export type Emit = (event: OutputEvent) => void;

/**
 * How long the browser waits before reconnecting after output is withheld. The
 * reconnect starts a fresh filter, so a fixed pattern file brings an open page
 * back on its own — once a minute, not every few seconds.
 */
export const WITHHELD_RETRY_MS = 60_000;

export interface FollowOptions {
  worktree: string;
  /** Starts the redacting filter; one per follower. */
  redactor: () => ChildProcess;
  emit: Emit;
  pollMs?: number;
  /** List the directory for a newer iteration every this many polls. */
  listEvery?: number;
  /** How much of an existing log the pane opens with. */
  tailBytes?: number;
  io?: OutputIO;
}

export interface Follower {
  stop(): void;
}

/** The redactor, run from the harness checkout so it reads the harness's patterns. */
export function createRedactor(config: {
  bunPath: string;
  cliDir: string;
  env?: Record<string, string | undefined>;
}): () => ChildProcess {
  return () =>
    spawn(config.bunPath, [join(config.cliDir, REDACT_COMMAND.script), ...REDACT_COMMAND.args], {
      cwd: config.cliDir,
      env: config.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
}

/** Bytes `[from, to)` of one file, through the one read-only open this module makes. */
function readFrom(io: OutputIO, path: string, from: number, to: number): Buffer {
  const out = Buffer.alloc(to - from);
  const fd = io.openSync(path, "r");
  try {
    let at = 0;
    while (at < out.length) {
      const read = io.readSync(fd, out, at, Math.min(READ_CHUNK, out.length - at), from + at);
      if (read === 0) break;
      at += read;
    }
    return out.subarray(0, at);
  } finally {
    io.closeSync(fd);
  }
}

/**
 * The last `lines` lines of one named iteration log, or null when it cannot
 * be read. The unblocker chat's evidence seed quotes it (#253).
 *
 * RAW, NOT REDACTED: the caller puts it through the same filter the pane
 * uses before a byte of it is shown or sent anywhere. It lives here so there
 * is one reader of iteration logs, with the pane's own name check and its
 * bounded read — a log can run to megabytes, and only the tail is wanted.
 * Read from the end, so a first line cut mid-way is dropped, as the pane
 * drops it when it opens mid-file.
 */
export function readLogTail(
  worktree: string,
  log: string,
  { lines = 80, tailBytes = 64 * 1024, io = nodeFs }: { lines?: number; tailBytes?: number; io?: OutputIO } = {},
): string[] | null {
  if (!ITERATION_LOG.test(log)) return null;
  const path = join(worktree, LOGS_DIR, log);
  try {
    const size = io.statSync(path).size;
    const from = Math.max(0, size - tailBytes);
    let text = readFrom(io, path, from, size).toString("utf8");
    if (from > 0) text = text.slice(text.indexOf("\n") + 1);
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    return all.slice(-lines);
  } catch {
    return null;
  }
}

export function followIterationOutput({
  worktree,
  redactor,
  emit,
  pollMs = 1000,
  listEvery = 3,
  tailBytes = 64 * 1024,
  io = nodeFs,
}: FollowOptions): Follower {
  const dir = join(worktree, LOGS_DIR);
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let child: ChildProcess | null = null;

  // A reset has to land between the old log's last line and the new log's
  // first, and both are still inside the filter when it is decided. So it is
  // sent THROUGH the filter as a marker line, and emitted when the marker
  // comes out the other side. The nonce keeps a log line from posing as one.
  const marker = `\u0001ralph-dashboard-reset-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-`;
  const pendingResets = new Map<string, OutputEvent>();
  let resetCount = 0;
  let outCarry = "";

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (child !== null) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  };

  const withhold = (reason: string): void => {
    if (stopped) return;
    stop();
    emit({ kind: "withheld", reason });
  };

  const onRedacted = (chunk: string): void => {
    if (stopped) return;
    const lines = (outCarry + chunk).split("\n");
    outCarry = lines.pop() ?? "";
    let text = "";
    for (const line of lines) {
      const reset = line.startsWith(marker) ? pendingResets.get(line) : undefined;
      if (reset === undefined) {
        text += `${line}\n`;
        continue;
      }
      pendingResets.delete(line);
      if (text) emit({ kind: "append", text });
      text = "";
      emit(reset);
    }
    if (text) emit({ kind: "append", text });
  };

  try {
    child = redactor();
  } catch (error) {
    withhold(`the redactor could not start: ${error instanceof Error ? error.message : String(error)}`);
    return { stop };
  }
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    withhold("the redactor has no pipes to read from");
    return { stop };
  }
  let stderrText = "";
  stdout.setEncoding("utf8");
  stdout.on("data", onRedacted);
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    stderrText += chunk;
    const reason = stderrText.trim().split("\n")[0]?.slice(0, 300) ?? "";
    if (reason) withhold(`output withheld: ${reason}`);
  });
  stdin.on("error", () => undefined);
  child.on("error", (error) => withhold(`the redactor could not run: ${error.message}`));
  child.on("close", (code) =>
    withhold(stderrText.trim() ? `output withheld: ${stderrText.trim().slice(0, 300)}` : `the redactor exited (${code})`),
  );

  const feed = (bytes: Buffer | string): void => {
    if (!stopped && bytes.length > 0) stdin.write(bytes);
  };

  const reset = (log: string | null, reason: string | null): void => {
    const key = `${marker}${resetCount++}`;
    pendingResets.set(key, { kind: "reset", log, reason });
    feed(`${key}\n`);
  };

  // What is being followed. `undefined` is "not looked yet", so the first
  // listing always announces itself, even when it finds nothing.
  let current: string | null | undefined = undefined;
  let offset = 0;
  let carry: Buffer = Buffer.alloc(0);
  // Opened mid-file: the first partial line is not shown.
  let skipPartial = false;
  let polls = 0;

  const newestLog = (): string | null => {
    let names: string[];
    try {
      names = io.readdirSync(dir) as string[];
    } catch {
      return null;
    }
    const logs = names.filter((name) => ITERATION_LOG.test(name)).sort();
    return logs.at(-1) ?? null;
  };

  const sizeOf = (name: string): number | null => {
    try {
      return io.statSync(join(dir, name)).size;
    } catch {
      return null;
    }
  };

  const flushCarry = (): void => {
    if (carry.length > 0 && !skipPartial) feed(Buffer.concat([carry, Buffer.from("\n")]));
    carry = Buffer.alloc(0);
  };

  const openAt = (name: string, size: number): void => {
    carry = Buffer.alloc(0);
    skipPartial = size > tailBytes;
    offset = skipPartial ? size - tailBytes : 0;
  };

  const switchTo = (name: string | null): void => {
    flushCarry();
    current = name;
    if (name === null) {
      reset(null, "No iteration log yet: the loop has not started an iteration in this worktree.");
      return;
    }
    openAt(name, sizeOf(name) ?? 0);
    reset(name, null);
  };

  const readAppended = (name: string): void => {
    const size = sizeOf(name);
    if (size === null) {
      // Gone between listings: list again on the next poll rather than guess.
      polls = 0;
      return;
    }
    if (size < offset) {
      carry = Buffer.alloc(0);
      skipPartial = false;
      offset = 0;
      reset(name, "The log was truncated; showing it from the start.");
    }
    if (size - offset > tailBytes * 4) {
      // Fell far behind (a burst between polls): skip to the tail rather than
      // push megabytes through the filter and the browser.
      flushCarry();
      feed(`[dashboard] skipped ${size - tailBytes - offset} bytes of output\n`);
      openAt(name, size);
    }
    if (size === offset) return;
    let bytes = Buffer.concat([carry, readFrom(io, join(dir, name), offset, size)]);
    offset = size;
    carry = Buffer.alloc(0);
    if (skipPartial) {
      const first = bytes.indexOf(NEWLINE);
      if (first === -1) return;
      bytes = bytes.subarray(first + 1);
      skipPartial = false;
    }
    const cut = bytes.lastIndexOf(NEWLINE);
    if (cut === -1) {
      carry = bytes;
    } else {
      feed(bytes.subarray(0, cut + 1));
      carry = bytes.subarray(cut + 1);
    }
    if (carry.length > MAX_CARRY) flushCarry();
  };

  const tick = (): void => {
    if (stopped) return;
    if (current === undefined || polls % listEvery === 0) {
      const newest = newestLog();
      if (newest !== current) switchTo(newest);
    }
    polls += 1;
    if (typeof current === "string") readAppended(current);
  };

  tick();
  if (!stopped) timer = setInterval(tick, pollMs);
  return { stop };
}

/**
 * The follower as server-sent events. The follower starts with the response
 * and stops when the client goes — an abort, a cancelled body, or a failed
 * write — so an abandoned page holds no timer and no filter.
 */
export function outputResponse(
  start: (emit: Emit) => Follower,
  signal?: AbortSignal,
  heartbeatMs = 20_000,
): Response {
  let finish = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let follower: Follower | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        follower?.stop();
        signal?.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          finish();
        }
      };
      if (signal?.aborted) {
        finish();
        return;
      }
      signal?.addEventListener("abort", finish, { once: true });
      send("retry: 3000\n\n");
      // A comment every so often keeps an idle loop's stream from being taken
      // for an idle connection, and surfaces a vanished client as a failed write.
      heartbeat = setInterval(() => send(": keep-alive\n\n"), heartbeatMs);
      follower = start((event) => {
        if (event.kind === "withheld") send(`retry: ${WITHHELD_RETRY_MS}\n\n`);
        send(`data: ${JSON.stringify(event)}\n\n`);
        // The follower has stopped; close so the browser's retry tries again.
        if (event.kind === "withheld") finish();
      });
      if (closed) follower.stop();
    },
    cancel() {
      finish();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
