// @vitest-environment node
/**
 * The live pane's follower, driven against real files in a scratch worktree.
 *
 * The redactor is a real subprocess in every case: `cat` stands in for a
 * redactor that passes text through, a one-line script for one that cannot
 * read its patterns, and the harness's own `runner-failure.ts redact` proves
 * the wiring strikes a secret end to end.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { OutputEvent } from "./contracts";
import { bunPath } from "./fixtures";
import { createRedactor, followIterationOutput, outputResponse, readLogTail, WITHHELD_RETRY_MS, type OutputIO } from "./iteration-output";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("streams output through real child processes");

const REPO_ROOT = join(__dirname, "..");
const scratch: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  scratch.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function worktree(): { root: string; logs: string } {
  const root = mkdtempSync(join(tmpdir(), "ralph-output-"));
  scratch.push(root);
  const logs = join(root, ".ralph", "logs");
  mkdirSync(logs, { recursive: true });
  return { root, logs };
}

const passthrough = () => spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });

const unreadable = () =>
  spawn(
    "sh",
    ["-c", "echo 'runner-failure: runner-signals.json has no patterns — discarding' >&2; cat > /dev/null; exit 1"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

function follow(root: string, options: { redactor?: () => ReturnType<typeof spawn>; io?: OutputIO; tailBytes?: number } = {}) {
  const events: OutputEvent[] = [];
  const handle = followIterationOutput({
    worktree: root,
    redactor: options.redactor ?? passthrough,
    emit: (event) => events.push(event),
    pollMs: 20,
    listEvery: 1,
    ...(options.io ? { io: options.io } : {}),
    ...(options.tailBytes ? { tailBytes: options.tailBytes } : {}),
  });
  stops.push(handle.stop);
  return { events, stop: handle.stop };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const text = (events: OutputEvent[]): string =>
  events.flatMap((event) => (event.kind === "append" ? [event.text] : [])).join("");

describe("followIterationOutput", () => {
  it("shows the newest iteration log and appends lines as they are written", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260901T100000.log"), "old iteration\n");
    writeFileSync(join(logs, "iter-20260902T100000.log"), "[t] text: first\n");
    // Not iteration logs: sidecars and stage logs are never the pane.
    writeFileSync(join(logs, "iter-20260903T100000-12.err"), "stderr\n");
    writeFileSync(join(logs, "iter-20260903T100000-12-1.events.jsonl"), "{}\n");
    const { events } = follow(root);

    await until(() => text(events).includes("first"));
    expect(events[0]).toEqual({ kind: "reset", log: "iter-20260902T100000.log", reason: null });

    appendFileSync(join(logs, "iter-20260902T100000.log"), "[t] tool: Bash — ls\n[t] partial");
    await until(() => text(events).includes("tool: Bash"));
    expect(text(events)).toBe("[t] text: first\n[t] tool: Bash — ls\n");

    // A line is shown only once it is whole.
    appendFileSync(join(logs, "iter-20260902T100000.log"), " line\n");
    await until(() => text(events).includes("partial line"));
    expect(text(events)).not.toContain("old iteration");
  });

  it("follows the loop into a new iteration", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260902T100000.log"), "iteration one\n");
    const { events } = follow(root);
    await until(() => text(events).includes("iteration one"));

    writeFileSync(join(logs, "iter-20260902T110000.log"), "iteration two\n");
    await until(() => text(events).includes("iteration two"));

    const resets = events.filter((event) => event.kind === "reset");
    expect(resets.at(-1)).toEqual({ kind: "reset", log: "iter-20260902T110000.log", reason: null });
    // The reset lands between the two iterations' output, in order.
    const order = events.map((event) => (event.kind === "append" ? event.text : event.kind));
    expect(order.indexOf("iteration two\n")).toBeGreaterThan(order.lastIndexOf("reset"));
    expect(order.indexOf("iteration one\n")).toBeLessThan(order.lastIndexOf("reset"));
  });

  it("starts a long log at its tail, on a line boundary", async () => {
    const { root, logs } = worktree();
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}\n`).join("");
    writeFileSync(join(logs, "iter-20260902T100000.log"), lines);
    const { events } = follow(root, { tailBytes: 100 });
    await until(() => text(events).includes("line 199"));
    const shown = text(events);
    expect(shown.length).toBeLessThanOrEqual(100);
    expect(shown.startsWith("line ")).toBe(true);
    expect(shown).not.toContain("line 0\n");
  });

  it("is an empty pane with a reason when there is no log, and picks one up when it appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-output-"));
    scratch.push(root);
    const { events } = follow(root);
    await until(() => events.length > 0);
    expect(events[0]).toMatchObject({ kind: "reset", log: null });
    expect((events[0] as { reason: string }).reason).toMatch(/no iteration log/i);

    mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(root, ".ralph", "logs", "iter-20260902T100000.log"), "hello\n");
    await until(() => text(events).includes("hello"));
  });

  it("looks again when the followed log disappears", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260902T100000.log"), "first\n");
    const events: OutputEvent[] = [];
    const handle = followIterationOutput({ worktree: root, redactor: passthrough, emit: (event) => events.push(event), pollMs: 20, listEvery: 3 });
    stops.push(handle.stop);
    await until(() => text(events).includes("first"));

    rmSync(join(logs, "iter-20260902T100000.log"));
    await until(() => events.at(-1)?.kind === "reset" && (events.at(-1) as { log: string | null }).log === null);
    writeFileSync(join(logs, "iter-20260902T110000.log"), "second\n");
    await until(() => text(events).includes("second"));
  });

  it("restarts the pane with a reason when the log is truncated", async () => {
    const { root, logs } = worktree();
    const path = join(logs, "iter-20260902T100000.log");
    writeFileSync(path, "before truncation\n");
    const { events } = follow(root);
    await until(() => text(events).includes("before"));

    truncateSync(path, 0);
    await until(() => events.some((event) => event.kind === "reset" && event.reason !== null));
    expect(events.at(-1)).toMatchObject({ kind: "reset", log: "iter-20260902T100000.log" });
    expect((events.at(-1) as { reason: string }).reason).toMatch(/truncated/i);

    appendFileSync(path, "after\n");
    await until(() => text(events).includes("after"));
  });

  it("withholds output, with the redactor's reason, when it cannot redact", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260902T100000.log"), "ghp_secretsecretsecretsecret\n");
    const { events } = follow(root, { redactor: unreadable });
    await until(() => events.some((event) => event.kind === "withheld"));
    const withheld = events.find((event) => event.kind === "withheld") as { reason: string };
    expect(withheld.reason).toMatch(/no patterns/);
    expect(events.some((event) => event.kind === "append")).toBe(false);
  });

  it("strikes secrets through the harness's own redactor", async () => {
    const { root, logs } = worktree();
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    writeFileSync(join(logs, "iter-20260902T100000.log"), `[t] tool result: token ${token} ok\n`);
    const redactor = createRedactor({ bunPath: bunPath(), cliDir: REPO_ROOT, env: { PATH: process.env.PATH ?? "" } });
    const { events } = follow(root, { redactor });
    await until(() => text(events).includes("ok"), 20_000);
    expect(text(events)).toContain("[redacted:github-token]");
    expect(text(events)).not.toContain(token);
  }, 30_000);

  it("reads only what was appended: an idle log costs a stat, not a re-read", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260902T100000.log"), "x".repeat(10_000) + "\n");
    let bytesRead = 0;
    const io: OutputIO = {
      ...fs,
      readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        const read = fs.readSync(fd, buffer, offset, length, position);
        bytesRead += read;
        return read;
      }) as OutputIO["readSync"],
    };
    const { events } = follow(root, { io });
    await until(() => text(events).length > 0);
    const afterFirst = bytesRead;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bytesRead).toBe(afterFirst);

    appendFileSync(join(logs, "iter-20260902T100000.log"), "more\n");
    await until(() => text(events).includes("more"));
    expect(bytesRead).toBe(afterFirst + "more\n".length);
  });

  it("stops the redactor and its polling when stopped", async () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20260902T100000.log"), "one\n");
    let child: ReturnType<typeof spawn> | null = null;
    const { events, stop } = follow(root, {
      redactor: () => {
        child = passthrough();
        return child;
      },
    });
    await until(() => text(events).includes("one"));
    stop();
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    const count = events.length;
    appendFileSync(join(logs, "iter-20260902T100000.log"), "two\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events.length).toBe(count);
  });
});

describe("outputResponse", () => {
  it("serves the events as server-sent events and stops the follower when the client goes", async () => {
    let stopped = false;
    let emit: (event: OutputEvent) => void = () => undefined;
    const controller = new AbortController();
    const response = outputResponse(
      (sink) => {
        emit = sink;
        return { stop: () => (stopped = true) };
      },
      controller.signal,
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    emit({ kind: "reset", log: "iter-1.log", reason: null });
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("iter-1.log")) {
      const { value } = await reader.read();
      received += decoder.decode(value);
    }
    expect(received).toContain(`data: ${JSON.stringify({ kind: "reset", log: "iter-1.log", reason: null })}\n\n`);

    controller.abort();
    expect(stopped).toBe(true);
  });

  it("closes a withheld stream and asks the browser to retry in a minute", async () => {
    let stopped = false;
    const response = outputResponse((sink) => {
      sink({ kind: "withheld", reason: "no patterns" });
      return { stop: () => (stopped = true) };
    });
    const received = await response.text();
    expect(received).toContain(`retry: ${WITHHELD_RETRY_MS}\n\n`);
    expect(received).toContain(`data: ${JSON.stringify({ kind: "withheld", reason: "no patterns" })}\n\n`);
    // The retry is sent before the event, so the browser holds it when the stream ends.
    expect(received.indexOf(`retry: ${WITHHELD_RETRY_MS}`)).toBeLessThan(received.indexOf("withheld"));
    expect(stopped).toBe(true);
  });
});

describe("readLogTail", () => {
  it("returns the last lines of the named log, without its trailing newline", () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20261007T105001.log"), `${Array.from({ length: 120 }, (_, n) => `line ${n}`).join("\n")}\n`);
    const tail = readLogTail(root, "iter-20261007T105001.log", { lines: 80 });
    expect(tail).toHaveLength(80);
    expect(tail![0]).toBe("line 40");
    expect(tail!.at(-1)).toBe("line 119");
  });

  it("reads only the tail of a long log, and drops the line it cut into", () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "iter-20261007T105001.log"), `${"x".repeat(5_000)}\nwhole one\nwhole two\n`);
    expect(readLogTail(root, "iter-20261007T105001.log", { lines: 80, tailBytes: 100 })).toEqual(["whole one", "whole two"]);
  });

  it("is null for a log it cannot read, and for a name that is not an iteration log", () => {
    const { root, logs } = worktree();
    writeFileSync(join(logs, "supervisor-run.log"), "not this one\n");
    expect(readLogTail(root, "iter-20261007T105001.log")).toBeNull();
    expect(readLogTail(root, "supervisor-run.log")).toBeNull();
    expect(readLogTail(root, "../../../etc/passwd")).toBeNull();
  });
});
