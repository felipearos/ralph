// @vitest-environment node
/**
 * Before-and-after screenshots (`ui-shots.ts`): the pieces a PR body is built
 * from, the sign-in, the publish through a fake `gh`, and one real capture —
 * a throwaway git repository served by bun and photographed by chromium on
 * both sides of a change.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { findChromium } from "./dashboard/e2e-chromium";
import type { ScreenshotsConfig } from "./project-config";
import { subprocessSuite } from "./test-timeouts";
import { scratchDir } from "./test-scratch";
import {
  SECTION_END,
  SECTION_START,
  SHOTS_BRANCH,
  SHOTS_RELATIVE_DIR,
  capture,
  contextOptions,
  credentialPath,
  fenceProblems,
  parseEnvFile,
  parseRoute,
  publish,
  renderSection,
  serverEnv,
  shotFileName,
  spliceSection,
  supabaseLogin,
  supabaseStorageKey,
  type Gh,
  type Manifest,
} from "./ui-shots";

subprocessSuite("runs git, bash, a bun static server and chromium");

const CHROMIUM = findChromium();

const manifest = (side: "before" | "after", viewport: "phone" | "desktop", shots: Manifest["shots"]): Manifest => ({
  side,
  sha: side === "before" ? "aaaaaaaa11111111" : "bbbbbbbb22222222",
  viewport,
  takenAt: "2026-10-28T12:00:00.000Z",
  shots,
});

describe("the host credential", () => {
  it("lives beside the tracker credentials, one file per project", () => {
    expect(credentialPath("acme-pwa", { XDG_CONFIG_HOME: "/x" })).toBe("/x/ralph/screenshots/acme-pwa.env");
  });

  it("reads KEY=value lines, comments, export prefixes and one level of quotes", () => {
    expect(parseEnvFile(`# preview only\nexport VITE_SUPABASE_URL="https://ref.supabase.co"\nSHOTS_EMAIL='a@b.c'\n\nnot a line\nE2E_X=1=2\n`)).toEqual({
      VITE_SUPABASE_URL: "https://ref.supabase.co",
      SHOTS_EMAIL: "a@b.c",
      E2E_X: "1=2",
    });
  });

  it("names each fence it breaks without printing the value", () => {
    const values = { VITE_SUPABASE_URL: "https://production.supabase.co" };
    const problems = fenceProblems(values, { VITE_SUPABASE_URL: "https://preview.supabase.co", OTHER: "x" });
    expect(problems).toEqual(["VITE_SUPABASE_URL must start with 'https://preview.supabase.co'", "OTHER must start with 'x'"]);
    expect(problems.join()).not.toContain("production");
  });

  it("keeps the test account out of the dev server's environment", () => {
    expect(serverEnv({ VITE_A: "1", SHOTS_EMAIL: "e", SHOTS_PASSWORD: "p" })).toEqual({ VITE_A: "1" });
  });
});

describe("the browser", () => {
  it("is a phone or a desktop", () => {
    expect(contextOptions("phone")).toMatchObject({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
    expect(contextOptions("desktop")).toEqual({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  });

  it("keys the session the way supabase-js does", () => {
    expect(supabaseStorageKey("https://exampleprojectref00.supabase.co")).toBe("sb-exampleprojectref00-auth-token");
  });

  it("splits a route into its path and the steps run before its shot", () => {
    expect(parseRoute("modules/tasks?tab=historial|fill:Desde=2026-10-21|click:Aplicar|press:Escape|wait:21 oct|eval:window.x = 1")).toEqual({
      ok: true,
      path: "/modules/tasks?tab=historial",
      steps: [
        { kind: "fill", label: "Desde", value: "2026-10-21" },
        { kind: "click", name: "Aplicar" },
        { kind: "press", key: "Escape" },
        { kind: "wait", text: "21 oct" },
        { kind: "eval", script: "window.x = 1" },
      ],
    });
    expect(parseRoute("/a|tap:x")).toEqual({ ok: false, error: "unknown step 'tap' in '/a|tap:x': use click, fill, press, wait or eval" });
    expect(parseRoute("/a|fill:Desde")).toEqual({ ok: false, error: "step 'fill:Desde' in '/a|fill:Desde' must be fill:<label>=<value>" });
    expect(parseRoute("/a|click:")).toEqual({ ok: false, error: "step 'click:' in '/a|click:' has nothing after its colon" });
  });

  it("names each shot by its order and route", () => {
    expect(shotFileName(0, "/")).toBe("01-home.png");
    expect(shotFileName(11, "/modules/checklist/execute/12?tab=a")).toBe("12-modules-checklist-execute-12-tab-a.png");
  });
});

describe("the sign-in", () => {
  const values = {
    VITE_SUPABASE_URL: "https://ref.supabase.co/",
    VITE_SUPABASE_ANON_KEY: "anon",
    SHOTS_EMAIL: "tester@example.com",
    SHOTS_PASSWORD: "hunter2",
  };

  it("posts a password grant and keeps the session with an expiry", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "jwt", refresh_token: "r", expires_in: 3600, user: { id: "u1" } }));
    }) as unknown as typeof fetch;
    const login = await supabaseLogin(values, fetcher);
    expect(calls[0]!.url).toBe("https://ref.supabase.co/auth/v1/token?grant_type=password");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "tester@example.com", password: "hunter2" });
    expect(login.ok).toBe(true);
    if (login.ok) {
      expect(login.storageKey).toBe("sb-ref-auth-token");
      expect(JSON.parse(login.session)).toMatchObject({ access_token: "jwt", expires_at: expect.any(Number) });
    }
  });

  it("says why it was refused, and never with the password", async () => {
    const fetcher = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const login = await supabaseLogin(values, fetcher);
    expect(login).toEqual({ ok: false, error: "the sign-in was refused (HTTP 400)" });
    expect(await supabaseLogin({ ...values, SHOTS_PASSWORD: "" }, fetcher)).toEqual({
      ok: false,
      error: "the credential file has no SHOTS_EMAIL / SHOTS_PASSWORD",
    });
  });
});

describe("the PR body section", () => {
  const url = (side: string, file: string) => `https://img/${side}/${file}`;

  it("puts phones side by side, one row per route, and flags a redirect", () => {
    const section = renderSection(
      {
        before: manifest("before", "phone", [{ route: "/tasks", file: "01-tasks.png", landed: "/", consoleErrors: [] }]),
        after: manifest("after", "phone", [{ route: "/tasks", file: "01-tasks.png", landed: "/tasks", consoleErrors: [] }]),
      },
      url,
      "es",
    );
    expect(section.startsWith(SECTION_START)).toBe(true);
    expect(section.endsWith(SECTION_END)).toBe(true);
    expect(section).toContain("## Capturas — antes y después");
    expect(section).toContain(
      '<tr><td><code>/tasks</code></td><td><img src="https://img/before/01-tasks.png" width="280" alt="before /tasks"><br><sub>redirigió a <code>/</code></sub></td><td><img src="https://img/after/01-tasks.png" width="280" alt="after /tasks"></td></tr>',
    );
    expect(section).toContain("phone 393×852, con la isla dinámica dibujada · base `aaaaaaaa` · head `bbbbbbbb`");
  });

  it("labels a route's steps and flags a shot that showed the sign-in form", () => {
    const route = "/tasks|click:Historial";
    const section = renderSection(
      { after: manifest("after", "phone", [{ route, file: "01-tasks.png", landed: "/tasks", signIn: true, consoleErrors: [] }]) },
      url,
      "en",
    );
    expect(section).toContain(
      '<tr><td><code>/tasks</code><br><sub>click:Historial</sub></td><td>(not captured)</td><td><img src="https://img/after/01-tasks.png" width="280" alt="after /tasks → click:Historial"><br><sub>showed the sign-in form</sub></td></tr>',
    );
    // A markdown table row splits on any `|`, even inside an attribute (PWA #45): none may reach a phone section.
    expect(section.split("\n").filter((line) => line.startsWith("<tr>")).every((line) => !line.includes("|"))).toBe(true);
  });

  it("stacks desktops so each keeps its width, and marks a side not captured", () => {
    const section = renderSection(
      { after: manifest("after", "desktop", [{ route: "/checklists", file: "01-checklists.png", landed: "/checklists", consoleErrors: [] }]) },
      url,
      "en",
    );
    expect(section).toContain("### `/checklists`\n\n**Before**\n\n(not captured)\n\n**After**\n\n<img src=\"https://img/after/01-checklists.png\" width=\"900\"");
    expect(section).not.toContain("base `");
  });

  it("replaces its old self, else sits above the token footer, else goes last", () => {
    const section = `${SECTION_START}\nnew\n${SECTION_END}`;
    expect(spliceSection(`intro\n\n${SECTION_START}\nold\n${SECTION_END}\n\ntail`, section)).toBe(`intro\n\n${section}\n\ntail`);
    expect(spliceSection("intro\n\n<details><summary>token usage — step 3", section)).toBe(`intro\n\n${section}\n\n<details><summary>token usage — step 3`);
    expect(spliceSection("intro\n\n", section)).toBe(`intro\n\n${section}\n`);
  });
});

/** A `gh` that answers the git data API and the PR reads from memory, recording each call. */
function fakeGh(options: { branch: string | null; refuseFirstPatch?: boolean }) {
  const calls: { args: string[]; input?: unknown }[] = [];
  let tip = options.branch;
  let refused = false;
  let body = "🤖 Ralph loop\n\n<details><summary>token usage — step 1</summary>";
  let blobs = 0;
  const gh: Gh = (args, input) => {
    const parsed = input === undefined ? undefined : args.includes("--body-file") ? input : JSON.parse(input);
    calls.push({ args, input: parsed });
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args[0] === "pr" && args[1] === "view") return { ok: true, out: JSON.stringify({ body, url: "https://github.com/o/r/pull/7" }) };
    if (args[0] === "pr" && args[1] === "edit") {
      body = String(input);
      return { ok: true, out: "" };
    }
    if (path.endsWith(`/git/ref/heads/${SHOTS_BRANCH}`)) return tip ? { ok: true, out: JSON.stringify({ object: { sha: tip } }) } : { ok: false, out: "HTTP 404" };
    if (path.includes("/git/commits/")) return { ok: true, out: JSON.stringify({ tree: { sha: `tree-of-${path.split("/").at(-1)}` } }) };
    if (path.endsWith("/git/blobs")) return { ok: true, out: JSON.stringify({ sha: `blob${(blobs += 1)}` }) };
    if (path.endsWith("/git/trees")) return { ok: true, out: JSON.stringify({ sha: "tree-new" }) };
    if (path.endsWith("/git/commits")) return { ok: true, out: JSON.stringify({ sha: `commit-on-${tip ?? "nothing"}` }) };
    if (args.includes("PATCH")) {
      if (options.refuseFirstPatch && !refused) {
        refused = true;
        tip = "moved";
        return { ok: false, out: "HTTP 422 Update is not a fast forward" };
      }
      tip = (parsed as { sha: string }).sha;
      return { ok: true, out: JSON.stringify({ object: { sha: tip } }) };
    }
    if (path.endsWith("/git/refs")) {
      tip = (parsed as { sha: string }).sha;
      return { ok: true, out: JSON.stringify({ object: { sha: tip } }) };
    }
    return { ok: false, out: `unexpected gh ${args.join(" ")}` };
  };
  return { gh, calls, body: () => body };
}

function seedShots(root: string, sides: ("before" | "after")[]): void {
  for (const side of sides) {
    const dir = join(root, SHOTS_RELATIVE_DIR, side);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-home.png"), `png-${side}`);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest(side, "phone", [{ route: "/", file: "01-home.png", landed: "/", consoleErrors: [] }])));
  }
}

describe("publish", () => {
  it("starts the screenshots branch, then writes the section into the PR body above the footer", () => {
    const root = scratchDir("ralph-shots-publish-");
    seedShots(root, ["before", "after"]);
    const fake = fakeGh({ branch: null });
    const result = publish({ root, repo: "o/r", pr: 7, locale: "es", gh: fake.gh, stamp: "S1" });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/7" });

    const blobs = fake.calls.filter((call) => call.args.some((arg) => arg.endsWith("/git/blobs")));
    expect(blobs.map((call) => Buffer.from((call.input as { content: string }).content, "base64").toString())).toEqual(["png-before", "png-after"]);
    const tree = fake.calls.find((call) => call.args.some((arg) => arg.endsWith("/git/trees")))!.input as { base_tree?: string; tree: { path: string }[] };
    expect(tree.base_tree).toBeUndefined();
    expect(tree.tree.map((entry) => entry.path)).toEqual(["pr-7/S1/before/01-home.png", "pr-7/S1/after/01-home.png"]);
    expect(fake.calls.some((call) => call.args.some((arg) => arg.endsWith("/git/refs")))).toBe(true);

    const body = fake.body();
    expect(body.indexOf(SECTION_START)).toBeLessThan(body.indexOf("<details><summary>token usage"));
    expect(body).toContain("https://github.com/o/r/blob/commit-on-nothing/pr-7/S1/before/01-home.png?raw=true");
  });

  it("builds on the branch tip, and retries when another loop moved it first", () => {
    const root = scratchDir("ralph-shots-publish-");
    seedShots(root, ["after"]);
    const fake = fakeGh({ branch: "tip1", refuseFirstPatch: true });
    expect(publish({ root, repo: "o/r", pr: 7, locale: "en", gh: fake.gh, stamp: "S2" }).ok).toBe(true);
    const trees = fake.calls.filter((call) => call.args.some((arg) => arg.endsWith("/git/trees"))).map((call) => (call.input as { base_tree: string }).base_tree);
    expect(trees).toEqual(["tree-of-tip1", "tree-of-moved"]);
    expect(fake.body()).toContain("/blob/commit-on-moved/pr-7/S2/after/01-home.png?raw=true");
    expect(fake.body()).toContain("(not captured)");
  });

  it("refuses when nothing was captured", () => {
    const root = scratchDir("ralph-shots-publish-");
    expect(publish({ root, repo: "o/r", pr: 7, locale: "en", gh: fakeGh({ branch: null }).gh })).toEqual({
      ok: false,
      error: "nothing captured: run capture before and after first",
    });
  });
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A repository whose base says "Antes" and whose head says "Después", with a remote to diff against. */
function appRepo(): string {
  const dir = scratchDir("ralph-shots-app-");
  const remote = join(dir, "remote.git");
  const root = join(dir, "app");
  git(dir, "init", "--quiet", "--bare", remote);
  git(dir, "init", "--quiet", "-b", "main", root);
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  // `/old` redirects home, so a route that lands elsewhere is reported.
  writeFileSync(
    join(root, "server.ts"),
    `const page = await Bun.file("index.html").text();
Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[2]), fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/old") return Response.redirect("/", 302);
  if (path === "/wall") return new Response('<form><input type="password" aria-label="Clave"></form>', { headers: { "content-type": "text/html" } });
  return new Response(page.replace("PATH", path), { headers: { "content-type": "text/html" } });
} });
`,
  );
  const head = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><div id="inset" style="padding-top: env(safe-area-inset-top, 0px)"></div>';
  writeFileSync(join(root, "index.html"), `${head}<h1>Antes PATH</h1>`);
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "--quiet", "origin", "main");
  git(root, "switch", "--quiet", "-c", "feature");
  writeFileSync(
    join(root, "index.html"),
    `${head}<h1>Después PATH</h1><button>Más tarde</button><button onclick="document.body.insertAdjacentHTML('beforeend', '<p>Guardado</p>')">Guardar</button>`,
  );
  git(root, "commit", "--quiet", "-am", "head");
  return root;
}

const CONFIG: ScreenshotsConfig = {
  viewport: "phone",
  serve: "bun server.ts {port}",
  login: "none",
  requireEnv: {},
  dismiss: ["Más tarde"],
  locale: "en",
};

describe.skipIf(CHROMIUM === null)("a capture", () => {
  it("photographs the base and the head in throwaway worktrees, and reports a redirect", async () => {
    const root = appRepo();
    process.env.XDG_CACHE_HOME = join(root, "..", "cache");
    const lines: string[] = [];
    const run = (side: "before" | "after") =>
      capture({ root, side, routes: ["/", "/old"], config: CONFIG, baseBranch: "main", credential: {}, chromium: CHROMIUM!, log: (line) => lines.push(line) });

    const before = await run("before");
    const after = await run("after");
    expect([before, after].map((result) => (result.ok ? "ok" : result.error))).toEqual(["ok", "ok"]);
    if (!before.ok || !after.ok) return;
    expect(before.manifest.sha).toBe(git(root, "rev-parse", "main"));
    expect(after.manifest.sha).toBe(git(root, "rev-parse", "HEAD"));
    expect(after.manifest.shots.map((shot) => [shot.route, shot.landed])).toEqual([
      ["/", "/"],
      ["/old", "/"],
    ]);
    expect(lines).toContain("after /old → .ralph/logs/shots/after/02-old.png — REDIRECTED to /, so this is not a picture of /old");
    for (const side of ["before", "after"]) {
      const png = readFileSync(join(root, SHOTS_RELATIVE_DIR, side, "01-home.png"));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }

    // Steps reach a state no URL does, the phone has the island's inset, and a
    // sign-in form under the route's own URL is still reported.
    const inset = "eval:if (getComputedStyle(document.getElementById('inset')).paddingTop !== '59px') throw new Error('no inset')";
    const steps = await capture({
      root,
      side: "after",
      routes: [`/|click:Guardar|wait:Guardado|${inset}`, "/|click:Borrar", "/wall"],
      config: CONFIG,
      baseBranch: "main",
      credential: {},
      chromium: CHROMIUM!,
      log: (line) => lines.push(line),
    });
    expect(steps.ok).toBe(true);
    if (!steps.ok) return;
    const [saved, missing, wall] = steps.manifest.shots;
    expect(saved).not.toHaveProperty("stepErrors");
    expect(missing!.stepErrors).toEqual([expect.stringMatching(/^step 1 click failed: /)]);
    expect(wall).toMatchObject({ route: "/wall", landed: "/wall", signIn: true });
    expect(lines.at(-1)).toContain("SHOWS A SIGN-IN FORM");
    // Nothing is left behind: no worktree, no scratch checkout.
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
    const cache = join(root, "..", "cache", "ralph", "shots");
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  it("says so when the app never comes up, and still cleans up", async () => {
    const root = appRepo();
    process.env.XDG_CACHE_HOME = join(root, "..", "cache");
    const result = await capture({
      root,
      side: "after",
      routes: ["/"],
      config: { ...CONFIG, serve: "echo boom {port} >&2; exit 1" },
      baseBranch: "main",
      credential: {},
      chromium: CHROMIUM!,
      log: () => {},
    });
    expect(result).toMatchObject({ ok: false, exit: 4 });
    if (!result.ok) expect(result.error).toContain("boom");
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
  });
});
