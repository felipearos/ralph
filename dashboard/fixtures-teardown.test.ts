// @vitest-environment node
/**
 * Teardown that outlives a loaded host (#187): a dashboard suite used to fail
 * after its tests passed, with `ENOTEMPTY` from `rmSync`, because a child it
 * had spawned or signalled was still writing into the scratch root.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { removeScratchDir, waitForExit } from "./fixtures";

subprocessSuite("spawns shells that write into, and linger over, a scratch directory");

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("scratch teardown", () => {
  it("removes a directory a child is still writing into", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-teardown-writer-"));
    // Keeps adding entries until its directory is gone, like a CLI finishing
    // its write after the test that spawned it has returned.
    const writer = spawn(
      "bash",
      ["-c", 'for i in $(seq 1 200); do mkdir "$1/d$i" 2>/dev/null && : > "$1/d$i/f" || exit 0; done', "writer", dir],
      { stdio: "ignore" },
    );
    const exited = new Promise((resolve) => writer.on("close", resolve));
    while (readdirSync(dir).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    removeScratchDir(dir);
    await exited;

    expect(existsSync(dir)).toBe(false);
  });

  it("waits for a signalled child to finish exiting before teardown goes on", async () => {
    const child = spawn("bash", ["-c", "trap 'sleep 0.3; exit 0' TERM; while :; do sleep 0.05; done"], {
      stdio: "ignore",
    });
    const pid = child.pid!;
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(pid, "SIGTERM");

    await waitForExit([pid]);

    expect(running(pid)).toBe(false);
  });

  it("kills a child that ignores SIGTERM once the wait runs out", async () => {
    const child = spawn("bash", ["-c", "trap '' TERM; while :; do sleep 0.05; done"], { stdio: "ignore" });
    const pid = child.pid!;
    const closed = new Promise((resolve) => child.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(pid, "SIGTERM");

    const started = Date.now();
    await waitForExit([pid], 300);
    await closed;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(running(pid)).toBe(false);
  });
});
