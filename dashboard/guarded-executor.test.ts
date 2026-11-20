import { describe, expect, it } from "vitest";

import { guarded, type ExecResult, type Executor, type Invocation } from "./control-adapter";

const invocation: Invocation = { command: "true", args: [], cwd: "/", env: {} };

describe("guarded", () => {
  it("turns a rejection into a null status carrying the error's message", async () => {
    const rejecting: Executor = () => Promise.reject(new Error("boom"));
    expect(await guarded(rejecting)(invocation)).toEqual({ status: null, stdout: "", stderr: "boom" });
  });

  it("stringifies a rejection that is not an Error", async () => {
    // oxlint-disable-next-line prefer-promise-reject-errors -- the non-Error case is the point
    const rejecting: Executor = () => Promise.reject("nope");
    expect(await guarded(rejecting)(invocation)).toEqual({ status: null, stdout: "", stderr: "nope" });
  });

  it("catches an executor that throws before returning a promise", async () => {
    const throwing: Executor = () => {
      throw new Error("sync boom");
    };
    expect(await guarded(throwing)(invocation)).toEqual({ status: null, stdout: "", stderr: "sync boom" });
  });

  it("passes a resolved result through as the same object", async () => {
    const result: ExecResult = { status: 0, stdout: "out", stderr: "" };
    const resolving: Executor = () => Promise.resolve(result);
    expect(await guarded(resolving)(invocation)).toBe(result);
  });
});
