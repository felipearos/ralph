// @vitest-environment node
/**
 * The name guard, against real git: a temp bare repository is the public
 * remote, a clone of it pushes through the installed hook. The names are
 * placeholders (`acme`, `example-org`), never a real client.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addedLines, hookScript, matchOf, parsePatterns, report } from "./name-guard";
import { fixtureGitEnv, stripGitLocationEnv } from "./test-git-env";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs git pushes through the name-guard hook in bun");
stripGitLocationEnv();

const BUN = process.execPath.endsWith("bun") ? process.execPath : spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();
const GUARD = join(__dirname, "name-guard.ts");

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("parsePatterns", () => {
  it("reads one case-insensitive regex per line and skips comments and blanks", () => {
    const patterns = parsePatterns("# clients\nacme\n\n  example-org  \nC0[0-9]{3}\n");
    expect(patterns.map((p) => p.source)).toEqual(["acme", "example-org", "C0[0-9]{3}"]);
    expect(matchOf("ACME Corp", patterns)?.source).toBe("acme");
    expect(matchOf("channel C0123", patterns)?.source).toBe("C0[0-9]{3}");
    expect(matchOf("nothing here", patterns)).toBeNull();
  });

  it("throws on a line that is not a regex, so a broken list refuses instead of passing", () => {
    expect(() => parsePatterns("acme(\n")).toThrow();
  });
});

describe("addedLines", () => {
  const patch = [
    "diff --git a/old-acme.md b/notes.md",
    "similarity index 90%",
    "rename from old-acme.md",
    "rename to notes.md",
    "diff --git a/gone-acme.md b/gone-acme.md",
    "deleted file mode 100644",
    "--- a/gone-acme.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-acme was here",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,0 +4,2 @@",
    "+const repo = \"acme/backoffice\";",
    "+const ok = 1;",
  ].join("\n");

  it("keeps added lines and written paths, with their line numbers", () => {
    expect(addedLines(patch)).toEqual([
      { where: "notes.md", text: "notes.md" },
      { where: "src/a.ts", text: "src/a.ts" },
      { where: "src/a.ts:4", text: 'const repo = "acme/backoffice";' },
      { where: "src/a.ts:5", text: "const ok = 1;" },
    ]);
  });

  it("never reports a removed line or a deleted path: deleting a name is the fix", () => {
    const scanned = addedLines(patch).map((l) => l.text).join("\n");
    expect(scanned).not.toContain("acme was here");
    expect(scanned).not.toContain("gone-acme");
    expect(scanned).not.toContain("old-acme");
  });
});

describe("report", () => {
  it("names the commit, the place and the pattern", () => {
    const text = report([{ commit: "0123456789abcdef", where: "src/a.ts:4", pattern: "acme" }]);
    expect(text).toContain("0123456789 src/a.ts:4");
    expect(text).toContain("/acme/");
    expect(text).toContain("push refused");
  });
});

describe("the pre-push hook", () => {
  const env = (list: string) =>
    fixtureGitEnv({
      RALPH_NAME_GUARD: list,
      GIT_AUTHOR_NAME: "Guard Test",
      GIT_AUTHOR_EMAIL: "guard@example.invalid",
      GIT_COMMITTER_NAME: "Guard Test",
      GIT_COMMITTER_EMAIL: "guard@example.invalid",
    });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "name-guard-"));
    roots.push(root);
    const list = join(root, "list");
    writeFileSync(list, "# private names\nacme\n");
    const run = (args: string[], cwd = root) => spawnSync("git", args, { cwd, env: env(list), encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { env: env(list) });
    run(["clone", "-q", join(root, "origin.git"), "work"]);
    const work = join(root, "work");
    writeFileSync(join(work, "README.md"), "hello\n");
    run(["add", "."], work);
    run(["commit", "-qm", "first"], work);
    const install = spawnSync(BUN, [GUARD, "--install"], { cwd: work, env: env(list), encoding: "utf8" });
    expect(install.status, install.stderr).toBe(0);
    const commit = (file: string, body: string, message: string) => {
      writeFileSync(join(work, file), body);
      run(["add", "."], work);
      expect(run(["commit", "-qm", message], work).status).toBe(0);
    };
    return { root, list, work, run, commit };
  }

  it("installs an executable hook that runs this guard through bun", () => {
    const { work } = setup();
    const hook = readFileSync(join(work, ".git", "hooks", "pre-push"), "utf8");
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(hook).toContain(`${JSON.stringify(GUARD)} --pre-push "$@"`);
    expect(hookScript(GUARD, "/bin/bun")).toContain('exec "/bin/bun"');
  });

  it("lets a clean push through", () => {
    const { work, run, commit } = setup();
    commit("a.md", "plain words\n", "docs: plain");
    const push = run(["push", "-q", "origin", "HEAD:main"], work);
    expect(push.status, push.stderr).toBe(0);
  });

  it("refuses a push that adds a listed name, and names where", () => {
    const { work, run, commit } = setup();
    expect(run(["push", "-q", "origin", "HEAD:main"], work).status).toBe(0);
    commit("journal-acme.md", "nothing\n", "chore: journal");
    commit("b.md", "the ACME board\n", "docs: b");
    const push = run(["push", "-q", "origin", "HEAD:main"], work);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("journal-acme.md");
    expect(push.stderr).toContain("b.md:1");
    expect(run(["ls-remote", "origin", "main"], work).stdout).not.toContain(run(["rev-parse", "HEAD"], work).stdout.trim());
  });

  it("refuses a listed name in a commit message", () => {
    const { work, run, commit } = setup();
    commit("c.md", "fine\n", "fix: the acme report");
    const push = run(["push", "-q", "origin", "HEAD:topic"], work);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("message:1");
  });

  it("lets a commit through that only removes a name", () => {
    const { work, run, commit } = setup();
    commit("d.md", "fine\n", "docs: d");
    expect(run(["push", "-q", "origin", "HEAD:main"], work).status).toBe(0);
    // An old name already on the remote, removed now: the removal is clean.
    writeFileSync(join(work, "e.md"), "acme\n");
    run(["add", "."], work);
    run(["commit", "-qm", "docs: e", "--no-verify"], work);
    expect(run(["push", "-q", "--no-verify", "origin", "HEAD:main"], work).status).toBe(0);
    run(["rm", "-q", "e.md"], work);
    run(["commit", "-qm", "docs: drop e"], work);
    const push = run(["push", "-q", "origin", "HEAD:main"], work);
    expect(push.status, push.stderr).toBe(0);
  });

  it("refuses to install without a list, and leaves no hook behind", () => {
    const root = mkdtempSync(join(tmpdir(), "name-guard-"));
    roots.push(root);
    const missing = join(root, "no-list");
    execFileSync("git", ["init", "-q", join(root, "work")], { env: env(missing) });
    const install = spawnSync(BUN, [GUARD, "--install"], { cwd: join(root, "work"), env: env(missing), encoding: "utf8" });
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("no name list");
    expect(existsSync(join(root, "work", ".git", "hooks", "pre-push"))).toBe(false);
  });

  it("fails closed when the list is missing", () => {
    const { root, work, run, commit } = setup();
    commit("f.md", "fine\n", "docs: f");
    rmSync(join(root, "list"));
    const push = run(["push", "-q", "origin", "HEAD:main"], work);
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("no name list");
  });
});
