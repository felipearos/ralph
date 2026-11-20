// @vitest-environment node
/**
 * `vercel.json` at the repo root, pinned: the region, the rewrites that send
 * the shell's client-side routes to `index.html` and every API path to the one
 * function, and the `ignoreCommand` that keeps the loops' journal commits from
 * spending Hobby's 100 deployments a day.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { build, type Rolldown } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isShellPath, SHELL_PAGES } from "../routes";
import { realGitPath } from "../fixtures";
import { shellBuildConfig } from "../vite-config";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs git and the ignoreCommand in a scratch repo, and a Vite build of the shell");

interface VercelConfig {
  regions: string[];
  outputDirectory: string;
  buildCommand: string;
  functions: Record<string, unknown>;
  rewrites: { source: string; destination: string }[];
  ignoreCommand: string;
}

const REPO = join(import.meta.dirname, "..", "..");
const config = JSON.parse(readFileSync(join(REPO, "vercel.json"), "utf8")) as VercelConfig;

/**
 * Where Vercel sends `pathname`: the first rewrite whose source matches, or
 * `null` when none does (a static file, or Vercel's own 404). The sources here
 * use only anchored groups, no `:param` segments, so as regexes they match
 * exactly what path-to-regexp matches.
 */
function rewrite(pathname: string): string | null {
  for (const { source, destination } of config.rewrites) {
    if (new RegExp(`^${source}$`).test(pathname)) return destination;
  }
  return null;
}

describe("vercel.json", () => {
  it("runs one function in São Paulo and serves the static build", () => {
    expect(config.regions).toEqual(["gru1"]);
    expect(config.outputDirectory).toBe("dashboard/remote/dist");
    expect(config.buildCommand).toBe("bun dashboard/remote/build-static.ts");
    expect(Object.keys(config.functions)).toEqual(["api/index.ts"]);
  });

  it("has no path-to-regexp params, so the rewrite sources read as plain regexes", () => {
    for (const { source } of config.rewrites) expect(source).not.toMatch(/:\w/);
  });

  it("sends every API path to the function", () => {
    expect(rewrite("/api/p/x/api/loops")).toBe("/api");
    expect(rewrite("/api/projects")).toBe("/api");
    expect(rewrite("/api/projects/health")).toBe("/api");
  });

  it("sends the shell's client-side routes to index.html", () => {
    expect(rewrite("/p/x/loops/y")).toBe("/index.html");
    expect(rewrite("/p/x")).toBe("/index.html");
    expect(rewrite("/usage")).toBe("/index.html");
    expect(rewrite("/loops/y")).toBe("/index.html");
  });

  // Iterates SHELL_PAGES itself, so a page added there without a matching
  // rewrite fails here: locally it opens (or 302s into a project), hosted it
  // would 404.
  it("covers every page the local server serves the shell at", () => {
    // A loop page is a shell page by prefix, not a member of SHELL_PAGES.
    expect(isShellPath("/loops/y")).toBe(true);
    const missing: string[] = [];
    for (const page of [...SHELL_PAGES, "/loops/y"]) {
      // `/p/x/` and `/p/x` are both a project's Agents page. The unscoped `/`
      // is the static index itself, served without a rewrite; every other
      // unscoped page is served or 302'd into a project by the local server.
      const addresses = page === "/" ? ["/p/x/", "/p/x"] : [`/p/x${page}`, page];
      for (const address of addresses) if (rewrite(address) !== "/index.html") missing.push(address);
    }
    expect(missing).toEqual([]);
  });

  it("leaves the bundled assets to the static output", () => {
    // `build-static.ts` writes `index.html` and Vite's content-hashed
    // artifacts at the root (`<name>-<hash>.js`, `<name>-<hash>.css`, and the
    // same for any imported file); a rewrite catching one would serve the
    // shell in place of the asset.
    expect(rewrite("/index.html")).toBeNull();
    expect(rewrite("/index-abc123.js")).toBeNull();
    expect(rewrite("/index-abc123.css")).toBeNull();
    expect(rewrite("/usage-abc123.js")).toBeNull();
    expect(rewrite("/logo-abc123.svg")).toBeNull();
    // A static file without a hash, should one ever be added beside the build.
    expect(rewrite("/favicon.svg")).toBeNull();
    // The sources are anchored: a name that starts like a page is not the page.
    expect(rewrite("/usage-report")).toBeNull();
    expect(rewrite("/intake-abc123.js")).toBeNull();
  });
});

/**
 * The script the ignoreCommand runs. It is a file because Vercel refuses an
 * ignoreCommand over 256 characters, which the inline path list outgrew.
 */
const IGNORE_SCRIPT = join(REPO, "dashboard", "remote", "vercel-ignore.sh");

/** The pathspecs the ignore script diffs: every token after `--`, line continuations dropped. */
const pathspecs = (() => {
  const tokens = readFileSync(IGNORE_SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join(" ")
    .replace(/\\/g, " ")
    .trim()
    .split(/\s+/);
  const dashes = tokens.indexOf("--");
  return dashes === -1 ? [] : tokens.slice(dashes + 1);
})();

/** Whether a commit touching `file` (repo-relative) is one the ignoreCommand deploys. */
const covered = (file: string) => pathspecs.some((spec) => file === spec || file.startsWith(`${spec}/`));

describe("vercel.json ignoreCommand", () => {
  it("fits Vercel's 256-character limit and runs the ignore script", () => {
    expect(config.ignoreCommand.length).toBeLessThanOrEqual(256);
    expect(config.ignoreCommand).toBe("sh dashboard/remote/vercel-ignore.sh");
  });
});

describe("vercel.json ignoreCommand pathspecs", () => {
  it("diffs a list of paths, none of them journal/ or the whole tree", () => {
    expect(pathspecs.length).toBeGreaterThan(0);
    for (const spec of pathspecs) {
      expect(spec).not.toMatch(/^(\.|journal|dashboard)\/?$/);
    }
  });

  it("covers the build's own files", () => {
    for (const file of ["dashboard/build.ts", "dashboard/vite-config.ts", "dashboard/remote/build-static.ts", "package.json", "bun.lock", "vercel.json", "tsconfig.json"]) {
      expect(covered(file), file).toBe(true);
    }
  });

  // From the build itself, not a hand list: a module the shell starts
  // importing from outside the listed paths would otherwise change the bundle
  // without redeploying it. It walks the JS modules only: Tailwind's scan of
  // the whole repo for class names is not followed, as it was not before.
  it("covers every repo file Vite bundles into the shell", async () => {
    const result = await build({ ...shellBuildConfig(), logLevel: "silent" });
    const outputs = (Array.isArray(result) ? result : [result as Rolldown.RolldownOutput]).flatMap((r) => r.output);
    const files = new Set<string>();
    for (const output of outputs) {
      if (output.type !== "chunk") continue;
      for (const id of output.moduleIds) {
        // Vite's virtual modules, and the plugins' `?query` variants of a file.
        if (id.startsWith("\0")) continue;
        const path = id.replace(/\?.*$/, "");
        if (!isAbsolute(path) || path.split(/[\\/]/).includes("node_modules")) continue;
        const file = relative(REPO, path);
        if (file.startsWith("..") || isAbsolute(file)) continue;
        files.add(file.split(sep).join("/"));
      }
    }
    // The build bundled the shell at all, so an empty walk cannot pass.
    expect([...files].some((file) => file.startsWith("dashboard/ui/"))).toBe(true);
    expect([...files].filter((file) => !covered(file)).sort()).toEqual([]);
  });
});

describe("vercel.json ignoreCommand", () => {
  const repo = mkdtempSync(join(tmpdir(), "ralph-vercel-ignore-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(realGitPath(), args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  const commit = (path: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${Date.now()} ${Math.random()}\n`);
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `touch ${path}`);
  };
  // Vercel runs the command in the cloned repo: exit 0 skips the build.
  // The scratch repo has no copy of the script, so run this checkout's: what
  // it diffs is the scratch repo's history, which is the cwd's.
  const ignoreExit = () => spawnSync("sh", [IGNORE_SCRIPT], { cwd: repo }).status;

  beforeAll(() => {
    git("init", "-q");
    commit("journal/start.md");
    commit("dashboard/ui/app.tsx");
  });

  it("skips a commit that touches only journal/", () => {
    commit("journal/ralph.md");
    expect(ignoreExit()).toBe(0);
  });

  it("builds a commit that touches dashboard/ui", () => {
    commit("dashboard/ui/app.tsx");
    expect(ignoreExit()).not.toBe(0);
  });

  it("builds a commit that touches the route constants or the function", () => {
    commit("dashboard/routes.ts");
    expect(ignoreExit()).not.toBe(0);
    commit("dashboard/route-table.ts");
    expect(ignoreExit()).not.toBe(0);
    // The command body parsers sit outside dashboard/remote but are bundled into the function.
    commit("dashboard/command-requests.ts");
    expect(ignoreExit()).not.toBe(0);
    commit("api/index.ts");
    expect(ignoreExit()).not.toBe(0);
  });

  it("builds a commit that touches the Vite config or a module the shell imports types from", () => {
    commit("dashboard/vite-config.ts");
    expect(ignoreExit()).not.toBe(0);
    commit("lineup/contracts.ts");
    expect(ignoreExit()).not.toBe(0);
  });
});
