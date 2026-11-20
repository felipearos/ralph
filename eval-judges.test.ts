import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { codexJudge } from "./eval-judges";
import { scratchDir } from "./test-scratch";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs judge-codex.sh under bash and bubblewrap with a stub codex");

const bwrapUsable = (): boolean =>
  spawnSync("bwrap", ["--unshare-user", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { encoding: "utf8" }).status === 0;

/**
 * A stub `codex` that answers with the prompt's first line, and says whether
 * it could read a file outside the sandbox: a judge that could read the
 * scoring clone could tell the human's diff from the agents'.
 */
function fixture() {
  const dir = scratchDir("judge-codex-");
  const bin = join(dir, "bin");
  const codexHome = join(dir, "codex-home");
  const secret = join(dir, "scoring-clone", "AUTHORS");
  mkdirSync(bin);
  mkdirSync(codexHome);
  mkdirSync(join(dir, "scoring-clone"));
  writeFileSync(join(codexHome, "auth.json"), "{}\n");
  writeFileSync(secret, "the human wrote candidate 2\n");
  writeFileSync(join(bin, "codex"), [
    "#!/usr/bin/env bash",
    "out=''",
    "while [ $# -gt 0 ]; do case \"$1\" in --output-last-message) out=\"$2\"; shift 2;; *) shift;; esac; done",
    "first=\"$(head -1)\"",
    "if cat \"$SECRET_PATH\" >/dev/null 2>&1; then seen=read; else seen=unreadable; fi",
    "printf '{\"first\": \"%s\", \"secret\": \"%s\", \"cwd\": \"%s\"}' \"$first\" \"$seen\" \"$PWD\" > \"$out\"",
    "",
  ].join("\n"));
  chmodSync(join(bin, "codex"), 0o755);
  const env = { ...process.env, RALPH_CODEX_BIN: join(bin, "codex"), CODEX_HOME: codexHome, SECRET_PATH: secret, GH_TOKEN: "ghp_secret" };
  return { dir, env, codexHome };
}

describe.skipIf(!bwrapUsable())("codexJudge", () => {
  it("returns the last message of a sandboxed run that cannot read outside its empty directory", async () => {
    const { dir, env } = fixture();
    const call = codexJudge({ model: "gpt-6-luna", cwd: dir, logPath: join(dir, "judge.log"), timeoutMs: 20_000, env });
    const answer = await call("You are judging candidate changes.\nmore");
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(JSON.parse(answer.text)).toEqual({ first: "You are judging candidate changes.", secret: "unreadable", cwd: "/tmp/judge" });
  });

  it("is a failed call, never a throw, when the sandbox has no auth to mount", async () => {
    const { dir, env } = fixture();
    const call = codexJudge({ model: "m", cwd: dir, logPath: join(dir, "judge.log"), timeoutMs: 20_000, env: { ...env, CODEX_HOME: join(dir, "nowhere") } });
    expect(await call("p")).toEqual({ ok: false, reason: "judge run failed: exit 2 (no sandbox: see the judge log)" });
    expect(readFileSync(join(dir, "judge.log"), "utf8")).toMatch(/has no auth\.json/);
  });

  it("kills a judge that outlives its timeout", async () => {
    const { dir, env } = fixture();
    writeFileSync(join(dir, "bin", "codex"), "#!/usr/bin/env bash\nsleep 30\n");
    const call = codexJudge({ model: "m", cwd: dir, logPath: join(dir, "judge.log"), timeoutMs: 500, env });
    expect(await call("p")).toEqual({ ok: false, reason: "judge timed out after 1s" });
  });
});
