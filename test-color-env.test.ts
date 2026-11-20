// @vitest-environment node
/**
 * A shell's `FORCE_COLOR` must not reach the children a suite spawns (#187):
 * with it, Bun wraps `console.error` output in ANSI codes even into a pipe, and
 * a test comparing a CLI's stderr fails only for whoever has it exported.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { FORCED_COLOR_ENV, stripForcedColorEnv } from "./test-color-env.setup";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("spawns Bun to see whether its stderr is coloured");

const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();

const stderrOf = (env: NodeJS.ProcessEnv): string =>
  spawnSync(BUN, ["-e", 'console.error("the problem")'], { encoding: "utf8", env }).stderr;

describe("the colour-forcing environment", () => {
  it("is gone from every test process, whatever the shell exported", () => {
    for (const name of FORCED_COLOR_ENV) expect(process.env[name]).toBeUndefined();
  });

  it("colours a child's stderr while set, which is the leak this guards against", () => {
    expect(stderrOf({ ...process.env, FORCE_COLOR: "3" })).toContain("\u001b[");
  });

  it("leaves a child's stderr plain once stripped", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "3", CLICOLOR_FORCE: "1" };
    stripForcedColorEnv(env);
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.CLICOLOR_FORCE).toBeUndefined();
    expect(stderrOf(env)).toBe("the problem\n");
    expect(stderrOf(process.env)).toBe("the problem\n");
  });
});
