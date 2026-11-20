// @vitest-environment node
/**
 * The tool shims the Codex executor's sandbox exposes, probed for real.
 *
 * On 2026-09-23 four of five overnight executor runs typed the command their
 * brief prescribed — `cd mobile && bunx jest …` — and got `bash: bunx: command
 * not found` (exit 127), then spent steps finding out that `bun x` worked.
 * `codex-executor.sh` bound the `bun` binary into `/ralph-runtimes` and nothing
 * else, but `bunx` is not a second binary: bun installs it as a symlink to
 * itself and switches mode on the name it was started as. Only `/usr` is
 * mounted, so a bun installed under `~/.bun` had lost its `bunx`.
 *
 * These cases start the real `codex-executor.sh --probe-tools`, which builds
 * the same runtime mounts and PATH the executor gets and asks, from inside
 * bubblewrap, whether each tool the host has resolves and runs. PATH is a
 * directory built per test, so the host's own tools cannot answer for the
 * sandbox's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the Codex executor's tools inside bubblewrap");

const SCRIPT = join(__dirname, "codex-executor.sh");

const which = (name: string): string | null => {
  try {
    return execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};

const BASH = which("bash") ?? "/bin/bash";
const BWRAP = which("bwrap");
const BUN = which("bun") ?? process.execPath;

/** CI installs bubblewrap and opens user namespaces; a laptop may not. */
const SANDBOX_WORKS = ((): boolean => {
  if (BWRAP === null) return false;
  const probe = spawnSync(BWRAP, ["--unshare-user", "--ro-bind", "/", "/", "true"]);
  return probe.status === 0;
})();

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A PATH holding only what the probe itself needs to start (bash, readlink,
 * bwrap) plus the runtimes a test installs, so the host's tools stay out.
 */
function hostPath(): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "ralph-codex-executor-"));
  scratchRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["bash", "readlink", "bwrap"]) {
    const real = which(tool);
    if (real !== null) symlinkSync(real, join(bin, tool));
  }
  return { root, bin };
}

function probe(bin: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BASH, [SCRIPT, "--probe-tools"], {
    // `codex-executor.sh` takes its project from the cwd (`ROOT="$PWD"`), and
    // inherited from the runner that is this checkout — a live loop's own when
    // it runs the suite as its gate (#199). The probe writes nothing today;
    // this keeps that from being the only thing holding it out of there.
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: bin },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!SANDBOX_WORKS)("the Codex executor's runtime shims", () => {
  it("exposes bunx beside bun, as the symlink bun installs it as", () => {
    const { root, bin } = hostPath();
    symlinkSync(BUN, join(bin, "bun"));

    const run = probe(bin, root);

    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("ok bun /ralph-runtimes/bun");
    expect(run.stdout).toContain("ok bunx /ralph-runtimes/bunx");
    expect(run.status).toBe(0);
  });

  it("exposes an npm installed outside /usr, with npx beside it", () => {
    const { root, bin } = hostPath();
    // The shape of every Node distribution outside /usr (nvm, tarballs,
    // hosted tool caches): the CLIs are scripts inside the npm package.
    const npmBin = join(root, "prefix", "lib", "node_modules", "npm", "bin");
    mkdirSync(npmBin, { recursive: true });
    for (const cli of ["npm-cli.js", "npx-cli.js"]) {
      writeFileSync(join(npmBin, cli), "#!/bin/sh\necho 10.0.0\n");
      chmodSync(join(npmBin, cli), 0o755);
    }
    symlinkSync(join(npmBin, "npm-cli.js"), join(bin, "npm"));
    symlinkSync(join(npmBin, "npx-cli.js"), join(bin, "npx"));

    const run = probe(bin, root);

    expect(run.stdout).toContain("ok npm /ralph-runtimes/npm");
    expect(run.stdout).toContain("ok npx /ralph-runtimes/npx");
    expect(run.status).toBe(0);
  });

  it("fails, naming the tool, when a runtime the host has does not run inside", () => {
    const { root, bin } = hostPath();
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "bun"), 0o755);

    const run = probe(bin, root);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("broken bun");
    expect(run.stdout).toContain("broken bunx");
  });

  it("requires nothing the host does not have", () => {
    const { root, bin } = hostPath();

    const run = probe(bin, root);

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("bunx");
  });
});
