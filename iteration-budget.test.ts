// @vitest-environment node
/**
 * The cap is only as good as its count and its aim: count each API message
 * once, and stop the session it serves — nothing else on the machine.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TokenTally, sessionPids } from "./iteration-budget";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the iteration-budget CLI through bash and bun");

const SCRIPT = join(import.meta.dirname, "iteration-budget.ts");
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const assistant = (session: string, id: string, usage: Record<string, number>, text = "x"): string =>
  JSON.stringify({
    type: "assistant",
    session_id: session,
    message: { id, content: [{ type: "text", text }], usage },
  });

describe("counting", () => {
  it("counts a message once however many content blocks repeat its usage", () => {
    const tally = new TokenTally();
    const usage = { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 1000 };
    tally.feed(`${assistant("s", "m1", usage)}\n${assistant("s", "m1", { ...usage, output_tokens: 20 })}\n`);
    expect(tally.total).toBe(1 + 20 + 100 + 1000);
  });

  it("waits for a partial line, and ignores what is not an assistant message", () => {
    const tally = new TokenTally();
    const line = assistant("s", "m1", { input_tokens: 5 });
    tally.feed(line.slice(0, 20));
    expect(tally.total).toBe(0);
    tally.feed(`${line.slice(20)}\n{"type":"result","usage":{"input_tokens":999}}\nnot json\n`);
    expect(tally.total).toBe(5);
  });

  it("can count one session of a shared iteration file", () => {
    const tally = new TokenTally("b");
    tally.feed(`${assistant("a", "m1", { input_tokens: 7 })}\n${assistant("b", "m2", { input_tokens: 3 })}\n`);
    expect(tally.total).toBe(3);
  });
});

describe("aiming", () => {
  it("finds the session's claude by --session-id or --resume, never itself or a neighbour", () => {
    const ps = [
      "  100 claude -p prompt --model claude-opus-5 --session-id aaaa-1 --verbose",
      "  101 claude -p prompt --resume aaaa-1 --verbose",
      "  102 claude -p prompt --session-id aaaa-10 --verbose",
      "  103 bun iteration-budget.ts watch --session aaaa-1",
      "  104 doppler run -- nice -n 5 claude -p x --session-id aaaa-1",
    ].join("\n");
    expect(sessionPids("aaaa-1", ps, 103)).toEqual([100, 101, 104]);
  });
});

describe("watching", () => {
  it("stops the session and leaves a marker once the cap is passed", async () => {
    const dir = scratchDir("ralph-budget-");
    const events = join(dir, "iter.events.jsonl");
    const marker = join(dir, "budget.json");
    writeFileSync(events, "");
    // A stand-in for `claude`: a process whose command line names the session.
    const victim = spawn("bash", ["-c", "sleep 60; true", "claude", "--session-id", "sess-1"], { stdio: "ignore" });
    const bystander = spawn("bash", ["-c", "sleep 60; true", "claude", "--session-id", "sess-2"], { stdio: "ignore" });
    const watcher = spawn(
      BUN,
      [SCRIPT, "watch", "--events", events, "--limit", "100", "--session", "sess-1", "--marker", marker, "--interval", "0.1"],
      { stdio: "ignore" },
    );
    const victimExit = new Promise<string | null>((resolve) => victim.on("exit", (_code, sig) => resolve(sig)));
    appendFileSync(events, `${assistant("sess-1", "m1", { cache_read_input_tokens: 60 })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(marker)).toBe(false);
    appendFileSync(events, `${assistant("sess-1", "m2", { cache_read_input_tokens: 60 })}\n`);

    expect(await victimExit).toBe("SIGTERM");
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ session: "sess-1", used: 120, limit: 100 });
    expect(bystander.exitCode).toBeNull();
    bystander.kill();
    watcher.kill();
  });

  it("prints the count for a finished iteration", () => {
    const dir = scratchDir("ralph-budget-");
    const events = join(dir, "iter.events.jsonl");
    writeFileSync(events, `${assistant("a", "m1", { input_tokens: 4 })}\n${assistant("b", "m2", { output_tokens: 6 })}`);
    const all = spawnSync(BUN, [SCRIPT, "count", "--events", events], { encoding: "utf8" });
    const one = spawnSync(BUN, [SCRIPT, "count", "--events", events, "--session", "b"], { encoding: "utf8" });
    expect(all.stdout.trim()).toBe("10");
    expect(one.stdout.trim()).toBe("6");
  });
});
