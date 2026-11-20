// @vitest-environment node
/**
 * The agents adapter's `renderPrompt` over a real `bun models.ts`, against a
 * copy of the loggd fixture project: the Prompts section must show exactly
 * what the harness renders for a role, so each render is compared to the CLI
 * run directly with the same cwd and env, not to a pinned text that would
 * drift with every prompt edit.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { subprocessSuite } from "../test-timeouts";
import { createAgentsAdapter } from "./agents-adapter";
import type { LoopRole } from "./contracts";
import { createProcessExecutor } from "./control-adapter";
import { bunPath } from "./fixtures";

subprocessSuite("bun models.ts");

const CLI_DIR = resolve(__dirname, "..");
const BUN = bunPath();
const PROJECT_ID = "loggd-web";

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A git-less project carrying loggd's `.ralph/`. With no `.git` the adapter's
 * `configCheckout` is the root itself, so the render runs right here.
 */
function loggdProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ralph-adapter-render-"));
  scratch.push(root);
  cpSync(join(CLI_DIR, "fixtures", "loggd", ".ralph"), join(root, ".ralph"), { recursive: true });
  return root;
}

const adapterAt = (root: string) =>
  createAgentsAdapter({ cliDir: CLI_DIR, root, project: PROJECT_ID, bunPath: BUN, exec: createProcessExecutor({ timeoutMs: 60_000 }) });

/** `models.ts --render-prompt --role <role>` run directly, with the env the adapter builds. */
function direct(root: string, role: LoopRole, loop: string) {
  const env = { ...process.env, RALPH_PROJECT: root, RALPH_PROJECT_ID: PROJECT_ID, RALPH_LOOP_NAME: loop };
  return spawnSync(BUN, [join(CLI_DIR, "models.ts"), "--render-prompt", "--role", role], { cwd: root, encoding: "utf8", env });
}

describe("renderPrompt over the loggd fixture", () => {
  const root = loggdProject();

  for (const [role, loop] of [["triager", "tria"], ["coder", "ralph"]] as const) {
    it(`renders the ${role} prompt exactly as models.ts --render-prompt prints it`, async () => {
      const expected = direct(root, role, loop);
      expect(expected.status, expected.stderr).toBe(0);
      expect(expected.stdout).not.toBe("");
      expect(await adapterAt(root).renderPrompt(role, loop)).toEqual({ ok: true, value: expected.stdout });
    });
  }

  it("refuses a render whose project fragment is gone, quoting models.ts", async () => {
    const broken = loggdProject();
    // The coder role's template is `prompt.md`, which splices the project's
    // PROMPT fragment; `coder.md` is the executor's, not this render's.
    rmSync(join(broken, ".ralph", "prompt.md"));
    const read = await adapterAt(broken).renderPrompt("coder", "ralph");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toContain("cannot read the project");
  });
});
