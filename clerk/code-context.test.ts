// @vitest-environment node
/**
 * The pieces of code context (felipearos/ralph#499) that are not the poll:
 * which apps a ticket reads, the queue's idempotency, the result validator,
 * the comment's markdown subset as Atlassian Document Format, the real git
 * that checks a clone's ref out detached beside it without touching the
 * clone's own checkout, and the `--show` CLI the session reads its case with.
 * The poll's half is `clerk/gate-code-context.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { RALPH_HOME } from "../paths";
import type { CodeContextRules } from "../project-config";
import { subprocessSuite } from "../test-timeouts";
import type { NewIssue } from "./apply";
import { CASE_PATTERN, NO_CASE, appsOf, caseDirOf, caseWhy, checkoutRepo, codeDirOf, commentDoc, pruneCodeContext, queueCodeContext, validateResult } from "./code-context";
import { clerkStorePath, emptyStore, withClerkStore } from "./store";

subprocessSuite("git, and bun clerk/code-context.ts --show");

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ralph-code-context-"));
  roots.push(dir);
  return dir;
};

const RULES: CodeContextRules = { repos: { pwa: { path: "/x/pwa", ref: "origin/dev", mainRef: "origin/main" }, Backoffice: { path: "/x/bo", ref: "origin/dev", mainRef: "origin/main" } } };

const issue = (app: NewIssue["app"]): NewIssue => ({
  type: "Error",
  summary: "No exporta",
  description: "El reporte no se exporta",
  labels: ["slack-intake"],
  app,
  priority: "Low",
  assignee: "person",
  difficulty: "easy",
  storyPoints: 1,
  permalink: "https://example.slack.com/archives/C0TEAMCHAN1/p1760961660000000",
});

const comment = (body = "Dónde está: `src/a.ts`.\n".repeat(12)): string => `Contexto de código (revisión automática sobre origin/dev cb0ae16)\n\n${body}`;

describe("which apps a ticket reads", () => {
  it("reads its app's repo, both for both, and none for none or an unconfigured app", () => {
    expect(appsOf("pwa", RULES)).toEqual(["pwa"]);
    expect(appsOf("Backoffice", RULES)).toEqual(["Backoffice"]);
    expect(appsOf("both", RULES)).toEqual(["pwa", "Backoffice"]);
    expect(appsOf("none", RULES)).toEqual([]);
    expect(appsOf("both", { repos: { Backoffice: RULES.repos.Backoffice! } })).toEqual(["Backoffice"]);
    expect(caseWhy("OAI-62", ["pwa", "Backoffice"])).toBe("code context OAI-62 (pwa, Backoffice)");
    expect(CASE_PATTERN.exec(caseWhy("OAI-62", ["pwa"]))?.[1]).toBe("OAI-62");
  });

  it("queues a ticket once, and nothing with the feature off", () => {
    const store = emptyStore("C0TEAMCHAN1");
    const input = { key: "OAI-62", report: "1760961660.000000", issue: issue("pwa"), files: [], at: "2026-10-26T10:00:00.000Z" };
    expect(queueCodeContext(store, null, input)).toBe(false);
    expect(store.codeContext).toBeUndefined();
    expect(queueCodeContext(store, RULES, input)).toBe(true);
    expect(queueCodeContext(store, RULES, input)).toBe(false);
    expect(queueCodeContext(store, RULES, { ...input, key: "OAI-63", issue: issue("none") })).toBe(false);
    expect(store.codeContext).toEqual({
      handed: null,
      cases: {
        "OAI-62": expect.objectContaining({ key: "OAI-62", apps: ["pwa"], state: "queued", attempt: 1, previousProblems: [], ticket: expect.objectContaining({ app: "pwa", summary: "No exporta" }) }),
      },
    });
  });

  it("forgets finished cases after 90 days and keeps queued ones", () => {
    const store = emptyStore("C0TEAMCHAN1");
    const at = "2026-07-01T10:00:00.000Z";
    for (const key of ["OAI-1", "OAI-2", "OAI-3"]) queueCodeContext(store, RULES, { key, report: "1", issue: issue("pwa"), files: [], at });
    Object.assign(store.codeContext!.cases["OAI-1"]!, { state: "done", doneAt: at });
    Object.assign(store.codeContext!.cases["OAI-2"]!, { state: "dropped", doneAt: "2026-10-20T10:00:00.000Z" });
    pruneCodeContext(store, Date.parse("2026-10-26T10:00:00.000Z"));
    expect(Object.keys(store.codeContext!.cases)).toEqual(["OAI-2", "OAI-3"]);
  });
});

describe("validating the session's result", () => {
  it("takes a well-formed comment, trimmed", () => {
    expect(validateResult({ key: "OAI-62", comment_es: `  ${comment()}\n` }, "OAI-62")).toEqual({ ok: true, comment: comment().trim() });
  });

  it("lists every problem at once", () => {
    expect(validateResult({ key: "OAI-61", comment_es: "Hola ✅" }, "OAI-62")).toEqual({
      ok: false,
      problems: [
        "'key' must be \"OAI-62\"; got \"OAI-61\"",
        "'comment_es' must be 200 to 6000 characters; got 6",
        "the first line of 'comment_es' must start with \"Contexto de código\"; got \"Hola ✅\"",
        "'comment_es' must carry no emoji; found ✅",
      ],
    });
    expect(validateResult({ key: "OAI-62", comment_es: comment("x".repeat(6000)) }, "OAI-62")).toMatchObject({ ok: false, problems: [expect.stringContaining("got 60")] });
    expect(validateResult({ key: "OAI-62" }, "OAI-62")).toMatchObject({ ok: false, problems: ["'comment_es' must be a string; got nothing"] });
    expect(validateResult([], "OAI-62")).toMatchObject({ ok: false });
    expect(validateResult("result.json is not JSON: x", "OAI-62")).toEqual({ ok: false, problems: ["result.json is not JSON: x"] });
  });
});

describe("the comment as Atlassian Document Format", () => {
  it("makes one paragraph per line, a list of the bullets, and marks code, bold, links and the leading label", () => {
    const doc = commentDoc(
      [
        "Contexto de código (revisión automática sobre origin/dev cb0ae16)",
        "",
        "Estado: corregido en dev por **abc1234**, ver https://github.com/x/y/pull/9.",
        "- `src/a.ts`: el filtro",
        "- sin etiqueta: también",
        "Línea suelta sin etiqueta, aunque diga algo: después",
      ].join("\n"),
    );
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Contexto de código (revisión automática sobre origin/dev cb0ae16)" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Estado:", marks: [{ type: "strong" }] },
            { type: "text", text: " corregido en dev por " },
            { type: "text", text: "abc1234", marks: [{ type: "strong" }] },
            { type: "text", text: ", ver " },
            { type: "text", text: "https://github.com/x/y/pull/9", marks: [{ type: "link", attrs: { href: "https://github.com/x/y/pull/9" } }] },
            { type: "text", text: "." },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "src/a.ts", marks: [{ type: "code" }] }, { type: "text", text: ": el filtro" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "sin etiqueta:", marks: [{ type: "strong" }] }, { type: "text", text: " también" }] }] },
          ],
        },
        // A colon past the label's few words is a sentence's, not a label.
        { type: "paragraph", content: [{ type: "text", text: "Línea suelta sin etiqueta, aunque diga algo: después" }] },
      ],
    });
  });
});

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

/** An origin with `main` and `dev`, and a clone of it on `main` with a local change. */
function clones(): { origin: string; clone: string; root: string; commit: (message: string) => string } {
  const dir = scratch();
  const seed = join(dir, "seed");
  const origin = join(dir, "origin.git");
  const clone = join(dir, "acme-pwa");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "-b", "main");
  writeFileSync(join(seed, "app.ts"), "export const v = 1;\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "main");
  git(seed, "checkout", "--quiet", "-b", "dev");
  writeFileSync(join(seed, "app.ts"), "export const v = 2;\n");
  git(seed, "commit", "--quiet", "-am", "dev");
  git(dir, "clone", "--quiet", "--bare", seed, origin);
  git(dir, "clone", "--quiet", "-b", "main", origin, clone);
  // Somebody's work in progress in the clone: never touched.
  writeFileSync(join(clone, "app.ts"), "export const v = 99; // wip\n");
  const root = join(dir, "worktree");
  mkdirSync(root);
  return {
    origin,
    clone,
    root,
    commit: (message) => {
      writeFileSync(join(seed, "app.ts"), `export const v = "${message}";\n`);
      git(seed, "commit", "--quiet", "-am", message);
      git(seed, "push", "--quiet", origin, "dev");
      return git(seed, "rev-parse", "HEAD");
    },
  };
}

describe("checking a repo out for a case", () => {
  it("adds a detached worktree at the fetched ref, re-points it later, and leaves the clone's checkout alone", () => {
    const { clone, root, commit } = clones();
    const repo = { path: clone, ref: "origin/dev", mainRef: "origin/main" };
    const first = commit("fix uno");
    const checked = checkoutRepo("pwa", repo, root);
    expect(checked).toEqual({ app: "pwa", path: codeDirOf(root, "pwa"), ref: "origin/dev", sha: first, mainRef: "origin/main" });
    expect(readFileSync(join(checked.path, "app.ts"), "utf8")).toBe('export const v = "fix uno";\n');
    // Whatever a session left in its view goes with the next checkout.
    writeFileSync(join(checked.path, "app.ts"), "scribbled");
    writeFileSync(join(checked.path, "new.ts"), "scribbled");
    const second = commit("fix dos");
    expect(checkoutRepo("pwa", repo, root).sha).toBe(second);
    expect(readFileSync(join(checked.path, "app.ts"), "utf8")).toBe('export const v = "fix dos";\n');
    expect(() => readFileSync(join(checked.path, "new.ts"))).toThrow();
    expect(git(checked.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    // The clone: still on main, its work in progress where it was.
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(clone, "app.ts"), "utf8")).toBe("export const v = 99; // wip\n");
    expect(git(clone, "branch", "--list")).toBe("* main");
  });

  it("re-adds a worktree whose directory was deleted, and refuses a missing clone or ref", () => {
    const { clone, root, commit } = clones();
    const repo = { path: clone, ref: "origin/dev", mainRef: "origin/main" };
    commit("uno");
    checkoutRepo("pwa", repo, root);
    rmSync(codeDirOf(root, "pwa"), { recursive: true, force: true });
    expect(checkoutRepo("pwa", repo, root).sha).toBe(git(clone, "rev-parse", "origin/dev"));
    expect(() => checkoutRepo("pwa", { ...repo, ref: "origin/nope" }, root)).toThrow("origin/nope is not a commit");
    expect(() => checkoutRepo("pwa", { ...repo, path: join(root, "missing") }, root)).toThrow("does not exist");
  });
});

describe("bun clerk/code-context.ts --show", () => {
  const project = (): { root: string; storePath: string } => {
    const root = scratch();
    git(root, "init", "--quiet");
    cpSync(join(RALPH_HOME, "fixtures", "clerk", ".ralph"), join(root, ".ralph"), { recursive: true });
    return { root, storePath: clerkStorePath("clara", root) };
  };
  const show = (root: string) =>
    spawnSync("bun", [join(RALPH_HOME, "clerk", "code-context.ts"), "--show"], { cwd: root, encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root, RALPH_LOOP_NAME: "clara" } });

  it("prints the handed case's case.json, and says when none is waiting", async () => {
    const { root, storePath } = project();
    const none = show(root);
    expect(none.status).toBe(1);
    expect(none.stderr.trim()).toBe(NO_CASE);
    expect(none.stdout).toBe("");

    await withClerkStore(storePath, "C0TESTCHAN1", (store) => {
      queueCodeContext(store, RULES, { key: "OAI-62", report: "1", issue: issue("pwa"), files: [], at: new Date().toISOString() });
      store.codeContext!.cases["OAI-62"]!.state = "handed";
      store.codeContext!.handed = "OAI-62";
    });
    const text = `${JSON.stringify({ key: "OAI-62", attempt: 1 }, null, 2)}\n`;
    mkdirSync(caseDirOf(root, "OAI-62"), { recursive: true });
    writeFileSync(join(caseDirOf(root, "OAI-62"), "case.json"), text);
    const shown = show(root);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toBe(text);

    const usage = spawnSync("bun", [join(RALPH_HOME, "clerk", "code-context.ts")], { cwd: root, encoding: "utf8", env: { ...process.env, RALPH_PROJECT: root } });
    expect(usage.status).toBe(64);
  });
});
