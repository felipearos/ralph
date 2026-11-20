// @vitest-environment node
/**
 * The shared recording executor's own contract. Suites lean on it for their
 * argv and ordering assertions, so what it records and how it picks an answer
 * are pinned here rather than inferred from whichever suite breaks first.
 */
import { describe, expect, it } from "vitest";

import { guarded, type ExecResult, type Invocation } from "./control-adapter";
import { createRecordingExecutor } from "./recording-executor";

const call = (command: string, ...args: string[]): Invocation => ({ command, args, cwd: "/w", env: {} });
const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

describe("createRecordingExecutor", () => {
  it("records every invocation in order with the answer it gave", async () => {
    const recorder = createRecordingExecutor().on({ command: "git" }, ok("g"));
    await recorder.exec(call("git", "status"));
    await recorder.exec(call("bun", "x"));
    recorder.record(call("<inbox>"), ok("sent"));
    await recorder.exec(call("git", "log"));

    expect(recorder.calls.map((c) => [c.invocation.command, c.invocation.args, c.answer?.stdout])).toEqual([
      ["git", ["status"], "g"],
      ["bun", ["x"], ""],
      ["<inbox>", [], "sent"],
      ["git", ["log"], "g"],
    ]);
  });

  it("answers with the first matching rule", async () => {
    const recorder = createRecordingExecutor()
      .on({ command: "git", args: ["log", "--oneline"] }, ok("first"))
      .on({ command: "git", args: ["log"] }, ok("second"))
      .on(() => true, ok("any"));

    expect((await recorder.exec(call("git", "log", "--oneline", "-1"))).stdout).toBe("first");
    expect((await recorder.exec(call("git", "log"))).stdout).toBe("second");
    expect((await recorder.exec(call("git", "status"))).stdout).toBe("any");
  });

  it("falls back to a non-zero status naming the invocation, or to the configured fallback", async () => {
    expect(await createRecordingExecutor().exec(call("gh", "pr"))).toEqual({
      status: 127,
      stdout: "",
      stderr: "unexpected invocation: gh",
    });
    const custom = createRecordingExecutor({ fallback: ok("fine") });
    expect(await custom.exec(call("gh"))).toEqual(ok("fine"));
  });

  it("rejects on a throw rule, and guarded() turns that into a null status", async () => {
    const recorder = createRecordingExecutor().on({ command: "boom" }, { throw: new Error("spawn ENOENT") });

    await expect(recorder.exec(call("boom"))).rejects.toThrow("spawn ENOENT");
    expect(await guarded(recorder.exec)(call("boom"))).toEqual({ status: null, stdout: "", stderr: "spawn ENOENT" });
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[0]!.answer).toBeNull();
    expect(recorder.calls[0]!.error).toBeInstanceOf(Error);
  });

  it("records a call whose function answer throws, then rejects", async () => {
    let seen = 0;
    const recorder = createRecordingExecutor().on({ command: "git" }, () => {
      seen += 1;
      if (seen > 1) throw new Error("fatal: bad revision");
      return ok("");
    });

    expect(await recorder.exec(call("git", "log"))).toEqual(ok(""));
    await expect(recorder.exec(call("git", "log"))).rejects.toThrow("fatal: bad revision");
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls[1]!.answer).toBeNull();
    expect(recorder.calls[1]!.error).toBeInstanceOf(Error);
  });

  it("hands function answers the invocation and reads state at call time", async () => {
    let phase = "before";
    const recorder = createRecordingExecutor().on(
      (invocation) => invocation.command === "echo",
      (invocation) => ok(`${phase}:${invocation.args.join(" ")}`),
    );

    expect((await recorder.exec(call("echo", "a", "b"))).stdout).toBe("before:a b");
    phase = "after";
    expect((await recorder.exec(call("echo", "c"))).stdout).toBe("after:c");
  });

  it("lets a test re-script by changing the rules mid-test", async () => {
    const recorder = createRecordingExecutor().on({ command: "git" }, ok("old"));
    expect((await recorder.exec(call("git"))).stdout).toBe("old");
    recorder.rules.unshift({ match: { command: "git" }, answer: ok("new") });
    expect((await recorder.exec(call("git"))).stdout).toBe("new");
  });
});
