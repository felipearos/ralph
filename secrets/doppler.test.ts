// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { secretSourceContract } from "./contract";
import { FIXTURE_VALUE, writeFakeDoppler } from "./doppler-fixture";
import { dopplerSource, MAX_WHY_CHARS, type ProcessRunner, type RunResult } from "./source";

subprocessSuite("doppler, a fake CLI script on PATH");

const ok = (stdout: string, stderr = ""): RunResult => ({ code: 0, stdout, stderr, timedOut: false });
const failed = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr, timedOut: false });

/** A runner answering by the secret name in `doppler secrets get <NAME> ...`, recording each argv. */
const fakeRunner = (answer: (name: string) => RunResult | Error, calls: string[][] = []): ProcessRunner =>
  async (argv) => {
    calls.push(argv);
    const result = answer(argv[3] ?? "");
    if (result instanceof Error) throw result;
    return result;
  };

secretSourceContract("doppler, through a fake process", {
  kind: "doppler",
  supportsUnread: true,
  make: ({ stored, unread }) =>
    dopplerSource({
      project: "proj",
      config: "prd",
      run: fakeRunner((name) => {
        // The update notice on stderr is the real CLI's success: the contract
        // then also proves it never leaks into the value.
        if (name in stored) return ok(stored[name] ?? "", "A new version of the Doppler CLI is available");
        if (unread.includes(name)) return failed("Unable to connect to api.doppler.com\nconnection refused");
        return failed(`Doppler Error: Could not find requested secret: ${name}`);
      }),
    }),
});

describe("doppler secret source", () => {
  const read = (result: RunResult | Error, name = "TOKEN") =>
    dopplerSource({ project: "proj", config: "prd", run: fakeRunner(() => result) }).read(name);

  it("asks the configured project and config for the name, plain", async () => {
    const calls: string[][] = [];
    await dopplerSource({ project: "proj", config: "prd", run: fakeRunner(() => ok("v"), calls) }).read("TOKEN");
    expect(calls).toEqual([["doppler", "secrets", "get", "TOKEN", "--plain", "-p", "proj", "-c", "prd"]]);
  });

  it("passes its deadline to the runner, 30 s unless told otherwise", async () => {
    const deadlines: number[] = [];
    const run: ProcessRunner = async (_argv, timeoutMs) => {
      deadlines.push(timeoutMs);
      return ok("v");
    };
    await dopplerSource({ project: "p", config: "c", run }).read("A");
    await dopplerSource({ project: "p", config: "c", run, timeoutMs: 250 }).read("A");
    expect(deadlines).toEqual([30_000, 250]);
  });

  it("drops trailing newlines from a value, as the shell's substitution did", async () => {
    expect(await read(ok("tok\n\n"))).toEqual({ kind: "value", value: "tok" });
  });

  it("reads an empty value on success as absent", async () => {
    expect(await read(ok(""))).toEqual({ kind: "absent" });
    expect(await read(ok("\n"))).toEqual({ kind: "absent" });
  });

  it("reads a timeout as unread", async () => {
    expect(await read({ code: null, stdout: "", stderr: "", timedOut: true })).toEqual({
      kind: "unread",
      why: "the read timed out",
    });
  });

  it("reads not-found, in any case, as absent", async () => {
    expect(await read(failed("Doppler Error: could NOT find requested secret: TOKEN"))).toEqual({ kind: "absent" });
  });

  it("reads other error text as unread, on one line and bounded", async () => {
    const long = `failed to unlock correct collection\n${"x".repeat(400)}`;
    const result = await read(failed(long));
    expect(result).toEqual({ kind: "unread", why: long.replace(/\n/g, " ").slice(0, MAX_WHY_CHARS) });
  });

  it("reads a silent failure as absent: no evidence of an outage", async () => {
    expect(await read(failed(""))).toEqual({ kind: "absent" });
    expect(await read(failed("\n\n"))).toEqual({ kind: "absent" });
  });

  it("reads a CLI that cannot start as unread, with the error", async () => {
    expect(await read(new Error("spawn doppler ENOENT"))).toEqual({ kind: "unread", why: "spawn doppler ENOENT" });
  });
});

describe("doppler secret source, through the default runner and a fake CLI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withFakeDoppler = (): void => {
    vi.stubEnv("PATH", `${writeFakeDoppler(scratchDir("ralph-fake-doppler-"))}:${process.env.PATH ?? ""}`);
  };
  const source = (timeoutMs?: number) => dopplerSource({ project: "proj", config: "prd", timeoutMs });

  it("returns stdout alone, never the update notice on stderr", async () => {
    withFakeDoppler();
    expect(await source().read("STORED")).toEqual({ kind: "value", value: FIXTURE_VALUE });
  });

  it("tells not-found, a locked keyring and a silent failure apart", async () => {
    withFakeDoppler();
    expect(await source().read("NOT_THERE")).toEqual({ kind: "absent" });
    expect(await source().read("LOCKED")).toEqual({
      kind: "unread",
      why: "Doppler Error: failed to unlock correct collection /org/freedesktop/secrets ",
    });
    expect(await source().read("SILENT")).toEqual({ kind: "absent" });
  });

  it("gives up on a hung CLI at its deadline, grandchildren and all", async () => {
    withFakeDoppler();
    const started = Date.now();
    expect(await source(300).read("HANG")).toEqual({ kind: "unread", why: "the read timed out" });
    // Far under the script's 60 s sleep: the read did not wait on the pipes.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("reads a missing CLI as unread", async () => {
    vi.stubEnv("PATH", scratchDir("ralph-no-doppler-"));
    const read = await source().read("STORED");
    expect(read.kind).toBe("unread");
    if (read.kind === "unread") expect(read.why).toContain("ENOENT");
  });
});
