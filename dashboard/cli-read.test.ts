import { describe, expect, it } from "vitest";

import { createCliReader, createTtlCache, RalphContractError, RalphUnavailableError, type CliSurface } from "./cli-read";
import type { ExecResult } from "./control-adapter";
import { createRecordingExecutor } from "./recording-executor";

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });

const narrowVersion = (value: unknown): { version: number } => {
  if (typeof value !== "object" || value === null || typeof (value as { version?: unknown }).version !== "number") {
    throw new RalphContractError("state", "$.version is not a number");
  }
  return { version: (value as { version: number }).version };
};

// Cast: a Partial override may swap `script` for `command`, which the
// exclusive union cannot see through a spread.
const surface = (overrides: Partial<CliSurface<{ version: number }>> = {}): CliSurface<{ version: number }> =>
  ({
    contract: "state",
    script: "loop-state.ts",
    args: ["--json"],
    narrow: narrowVersion,
    degrade: "loud",
    ...overrides,
  }) as CliSurface<{ version: number }>;

const setup = (answer: Parameters<ReturnType<typeof createRecordingExecutor>["on"]>[1] = ok('{"version":1}')) => {
  const rec = createRecordingExecutor({ fallback: answer });
  const clock = { t: 0 };
  const reader = createCliReader({ exec: rec.exec, now: () => clock.t, bunPath: "/bin/bun", cliDir: "/h", timeoutMs: 1234 });
  return { rec, clock, reader };
};

const call = { cwd: "/w", env: { A: "1" } };

/** A promise the test resolves by hand, to hold an executor call open. */
const deferred = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
};

describe("invocation", () => {
  it("runs a script surface as bun <cliDir>/<script>, appending per-call argv, with cwd, env, stdin and timeoutMs", async () => {
    const { rec, reader } = setup();
    await reader.read(surface(), { ...call, args: ["--loop", "x"], input: "secret" });
    expect(rec.calls[0]!.invocation).toEqual({
      command: "/bin/bun",
      args: ["/h/loop-state.ts", "--json", "--loop", "x"],
      cwd: "/w",
      env: { A: "1" },
      input: "secret",
      timeoutMs: 1234,
    });
  });

  it("runs a command surface as itself, with no stdin when none is given", async () => {
    const { rec, reader } = setup();
    await reader.read(surface({ script: undefined, command: "gh", args: ["pr", "list"] }), { ...call, args: ["--json"] });
    const invocation = rec.calls[0]!.invocation;
    expect(invocation).toEqual({ command: "gh", args: ["pr", "list", "--json"], cwd: "/w", env: { A: "1" }, timeoutMs: 1234 });
    expect("input" in invocation).toBe(false);
  });
});

describe("classification", () => {
  it("reads a non-zero status as unavailable, carrying stderr", async () => {
    const { reader } = setup({ status: 2, stdout: "", stderr: " boom \n" });
    const error = await reader.read(surface(), call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RalphUnavailableError);
    expect((error as RalphUnavailableError).detail).toBe("boom");
    expect((error as RalphUnavailableError).command).toBe("/bin/bun /h/loop-state.ts --json");
  });

  it("reads a null status as unavailable, naming the status when stderr is empty", async () => {
    const { reader } = setup({ status: null, stdout: "", stderr: "" });
    const error = await reader.read(surface(), call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RalphUnavailableError);
    expect((error as RalphUnavailableError).detail).toBe("exited with status null");
  });

  it("reads a rejecting executor as unavailable, with its message", async () => {
    const { reader } = setup({ throw: new Error("spawn ENOENT") });
    const error = await reader.read(surface(), call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RalphUnavailableError);
    expect((error as RalphUnavailableError).detail).toBe("spawn ENOENT");
  });

  it("reads non-JSON stdout as drift naming the contract", async () => {
    const { reader } = setup(ok("not json"));
    const error = await reader.read(surface(), call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RalphContractError);
    expect((error as RalphContractError).contract).toBe("state");
    expect((error as Error).message).toContain("not JSON");
  });

  it("wraps any other throw from narrow as drift", async () => {
    const { reader } = setup();
    const narrow = (): never => {
      throw new TypeError("bad shape");
    };
    const error = await reader.read(surface({ narrow }), call).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RalphContractError);
    expect((error as RalphContractError).detail).toBe("bad shape");
  });

  it("hands a text surface the raw stdout", async () => {
    const { reader } = setup(ok("abc123\n"));
    const text: CliSurface<string> = { contract: "head", command: "git", args: ["rev-parse", "HEAD"], parse: "text", narrow: (value) => String(value).trim(), degrade: "loud" };
    expect(await reader.read(text, call)).toBe("abc123");
  });
});

describe("degrade policies — read()", () => {
  it("loud: returns the value, and throws both unavailable and drift", async () => {
    expect(await setup().reader.read(surface(), call)).toEqual({ version: 1 });
    await expect(setup({ status: 1, stdout: "", stderr: "x" }).reader.read(surface(), call)).rejects.toBeInstanceOf(RalphUnavailableError);
    await expect(setup(ok("{}")).reader.read(surface(), call)).rejects.toBeInstanceOf(RalphContractError);
  });

  it("unavailable: unavailable becomes null, drift throws", async () => {
    const s = surface({ degrade: "unavailable" });
    expect(await setup({ status: 1, stdout: "", stderr: "x" }).reader.read(s, call)).toBeNull();
    await expect(setup(ok("{}")).reader.read(s, call)).rejects.toBeInstanceOf(RalphContractError);
  });

  it("any: every failure becomes null", async () => {
    const s = surface({ degrade: "any" });
    expect(await setup({ status: 1, stdout: "", stderr: "x" }).reader.read(s, call)).toBeNull();
    expect(await setup(ok("nope")).reader.read(s, call)).toBeNull();
    expect(await setup().reader.read(s, call)).toEqual({ version: 1 });
  });
});

describe("degrade policies — view()", () => {
  it("stamps readAt when the run starts", async () => {
    const rec = createRecordingExecutor({ fallback: ok('{"version":1}') });
    let t = Date.UTC(2026, 10, 3);
    const reader = createCliReader({
      exec: async (invocation) => {
        t += 5_000;
        return rec.exec(invocation);
      },
      now: () => t,
      bunPath: "bun",
      cliDir: "/h",
      timeoutMs: 1,
    });
    expect(await reader.view(surface(), call)).toEqual({ readAt: "2026-11-03T00:00:00.000Z", view: { version: 1 }, problem: null });
  });

  it("loud: failures throw", async () => {
    await expect(setup({ status: 1, stdout: "", stderr: "x" }).reader.view(surface(), call)).rejects.toBeInstanceOf(RalphUnavailableError);
    await expect(setup(ok("{}")).reader.view(surface(), call)).rejects.toBeInstanceOf(RalphContractError);
  });

  it("unavailable: unavailable becomes a problem carrying the detail, drift throws", async () => {
    const s = surface({ degrade: "unavailable" });
    expect(await setup({ status: 1, stdout: "", stderr: "no gh" }).reader.view(s, call)).toEqual({
      readAt: new Date(0).toISOString(),
      view: null,
      problem: "no gh",
    });
    await expect(setup(ok("{}")).reader.view(s, call)).rejects.toBeInstanceOf(RalphContractError);
  });

  it("any: drift becomes a problem carrying the message", async () => {
    const s = surface({ degrade: "any" });
    expect((await setup(ok("nope")).reader.view(s, call)).problem).toContain("not JSON");
    const drift = await setup(ok("{}")).reader.view(s, call);
    expect(drift.view).toBeNull();
    expect(drift.problem).toContain("$.version");
  });
});

describe("TTL cache", () => {
  it("reuses a view within ttl and re-runs it after", async () => {
    const { rec, clock, reader } = setup();
    const s = surface({ ttlMs: 1_000 });
    await reader.view(s, call);
    clock.t = 999;
    await reader.view(s, call);
    expect(rec.calls).toHaveLength(1);
    clock.t = 1_000;
    await reader.view(s, call);
    expect(rec.calls).toHaveLength(2);
  });

  it("shares one executor call between overlapping callers", async () => {
    const rec = createRecordingExecutor({ fallback: ok('{"version":1}') });
    const { gate, release } = deferred();
    const reader = createCliReader({
      exec: async (invocation) => {
        await gate;
        return rec.exec(invocation);
      },
      now: () => 0,
      bunPath: "bun",
      cliDir: "/h",
      timeoutMs: 1,
    });
    const s = surface({ ttlMs: 1_000 });
    const first = reader.view(s, call);
    const second = reader.view(s, call);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(rec.calls).toHaveLength(1);
  });

  it("caches a failed `any` view until ttl and retries after it", async () => {
    const { rec, clock, reader } = setup({ status: 1, stdout: "", stderr: "down" });
    const s = surface({ degrade: "any", ttlMs: 1_000 });
    expect((await reader.view(s, call)).problem).toBe("down");
    clock.t = 500;
    expect((await reader.view(s, call)).problem).toBe("down");
    expect(rec.calls).toHaveLength(1);
    rec.fallback = ok('{"version":2}');
    clock.t = 1_000;
    expect((await reader.view(s, call)).view).toEqual({ version: 2 });
    expect(rec.calls).toHaveLength(2);
  });

  it("does not keep drift thrown under `unavailable`: the next call re-runs", async () => {
    const { rec, reader } = setup(ok("{}"));
    const s = surface({ degrade: "unavailable", ttlMs: 1_000 });
    await expect(reader.view(s, call)).rejects.toBeInstanceOf(RalphContractError);
    await expect(reader.view(s, call)).rejects.toBeInstanceOf(RalphContractError);
    expect(rec.calls).toHaveLength(2);
  });

  it("keeps different keys apart", async () => {
    const { rec, reader } = setup();
    const s = surface({ ttlMs: 1_000 });
    await reader.view(s, call);
    await reader.view(s, { ...call, cwd: "/other" });
    await reader.view(s, { ...call, key: "explicit" });
    await reader.view(s, { ...call, cwd: "/third", key: "explicit" });
    expect(rec.calls).toHaveLength(3);
  });

  it("keeps different surfaces apart under one key", async () => {
    const { rec, reader } = setup();
    await reader.view(surface({ ttlMs: 1_000 }), call);
    await reader.view(surface({ ttlMs: 1_000 }), call);
    expect(rec.calls).toHaveLength(2);
  });

  it("createTtlCache drops a rejected load", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1_000, now: () => 0 });
    let loads = 0;
    await expect(cache.get("k", async () => {
      loads += 1;
      throw new Error("x");
    })).rejects.toThrow("x");
    expect(await cache.get("k", async () => ++loads)).toBe(2);
    expect(await cache.get("k", async () => ++loads)).toBe(2);
  });
});
