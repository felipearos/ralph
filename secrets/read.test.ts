// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";
import { subprocessSuite } from "../test-timeouts";
import { FIXTURE_VALUE, writeFakeDoppler } from "./doppler-fixture";

subprocessSuite("bun secrets/read.ts, with a fake doppler on PATH");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const READ = join(import.meta.dirname, "read.ts");

/** The CLI run as bash runs it, with only the environment given here. */
const readSecret = (args: string[], env: Record<string, string>) =>
  spawnSync(BUN, [READ, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, timeout: 25_000 });

const viaDoppler = (): Record<string, string> => ({
  PATH: `${writeFakeDoppler(scratchDir("ralph-read-doppler-"))}:${process.env.PATH ?? ""}`,
  RALPH_NAMED_SECRETS_RUNNER: "doppler",
  RALPH_SECRETS_PROJECT: "proj",
  RALPH_SECRETS_CONFIG: "prd",
});

describe("bun secrets/read.ts", () => {
  it("prints a Doppler value with no trailing newline, and nothing else anywhere", () => {
    const out = readSecret(["STORED"], viaDoppler());
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(FIXTURE_VALUE);
    expect(out.stderr).not.toContain("tok_fixture");
  });

  it("exits 3 with nothing on stdout for an absent secret", () => {
    const out = readSecret(["NOT_THERE"], viaDoppler());
    expect(out.status).toBe(3);
    expect(out.stdout).toBe("");
  });

  it("exits 4 with the reason on one stderr line for an unread secret", () => {
    const out = readSecret(["LOCKED"], viaDoppler());
    expect(out.status).toBe(4);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("Doppler Error: failed to unlock correct collection /org/freedesktop/secrets \n");
  });

  it("falls back to RALPH_SECRETS_RUNNER when the named-secrets runner is unset", () => {
    const { RALPH_NAMED_SECRETS_RUNNER: _unused, ...env } = viaDoppler();
    const out = readSecret(["STORED"], { ...env, RALPH_SECRETS_RUNNER: "doppler" });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe(FIXTURE_VALUE);
  });

  it("reads the environment when no runner is configured, never Doppler", () => {
    const env = { ...viaDoppler(), RALPH_NAMED_SECRETS_RUNNER: "", API_TOKEN: "tok_env" };
    expect(readSecret(["API_TOKEN"], env)).toMatchObject({ status: 0, stdout: "tok_env" });
    // STORED is only in the fake Doppler: an environment read must not find it.
    expect(readSecret(["STORED"], env)).toMatchObject({ status: 3, stdout: "" });
  });

  it("exits 2 on a usage error", () => {
    expect(readSecret([], {}).status).toBe(2);
    expect(readSecret(["A", "B"], {}).status).toBe(2);
  });
});
