import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { createProcessExecutor } from "./executor";

subprocessSuite("sh");

describe("createProcessExecutor", () => {
  it("bounds a child by the invocation's own timeoutMs over the constructor's", async () => {
    const exec = createProcessExecutor({ timeoutMs: 60_000 });
    // The one deliberately slow child: left alone it would exit 0, so a null
    // status is the evidence the 200 ms budget killed it, whatever the host load.
    const result = await exec({ command: "sh", args: ["-c", "sleep 5"], cwd: tmpdir(), env: process.env, timeoutMs: 200 });
    expect(result.status).toBeNull();
    // A killed child printed nothing; the error names the cause instead.
    expect(result.stderr).not.toBe("");
  });

  it("names a binary that never spawned, rather than an empty failure", async () => {
    const exec = createProcessExecutor({ timeoutMs: 60_000 });
    const result = await exec({ command: "/nonexistent/ralph-608", args: [], cwd: tmpdir(), env: process.env });
    expect(result.status).toBeNull();
    expect(result.stderr).toContain("ENOENT");
  });

  it("closes stdin when there is no input, so a child that reads it gets EOF", async () => {
    // A 60 s budget: were stdin left open, `cat` would block until the suite's timeout.
    const exec = createProcessExecutor({ timeoutMs: 60_000 });
    const result = await exec({ command: "sh", args: ["-c", "cat"], cwd: tmpdir(), env: process.env });
    expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("falls back to the constructor timeout and reports the exit status", async () => {
    const exec = createProcessExecutor({ timeoutMs: 60_000 });
    const result = await exec({ command: "sh", args: ["-c", "exit 3"], cwd: tmpdir(), env: process.env });
    expect(result.status).toBe(3);
  });
});
