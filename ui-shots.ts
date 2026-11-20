#!/usr/bin/env bun
/**
 * Before-and-after screenshots of a UI change, put in the pull request.
 *
 * A person reviewing a loop's PR on a team repository reads a diff of JSX and
 * class names and has to imagine the screen. The loop that wrote it has the
 * same problem the other way round: its gates prove the code compiles and the
 * tests pass, never that the page looks right. So the loop photographs every
 * screen its diff changes, as the base branch draws it and as its head draws
 * it, looks at both itself, and puts them side by side in the PR body.
 *
 * The project says how (the `screenshots` block of `.ralph/config.json`): the
 * viewport its users have — a store worker's phone for the PWA, an office
 * desktop for the backoffice — the command that serves the app, how the
 * browser gets a session, and which buttons close a welcome tour that would
 * cover every shot. The login, and the backend the dev server talks to, live
 * on the host, never in the repo:
 *
 *   $XDG_CONFIG_HOME/ralph/screenshots/<project-id>.env   (else ~/.config/…)
 *
 * `KEY=value` lines. `SHOTS_EMAIL` and `SHOTS_PASSWORD` are the
 * test account the browser signs in as; every other line is passed to the
 * dev server's environment (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, …),
 * so no env file is ever written into a checkout. The orchestrator is denied
 * the directory (`claude-orchestrator-settings.json`): it reaches the account
 * only through this script, which never prints a value.
 *
 *   capture <before|after> <route>...
 *       Serves the app at the side's commit — `before` is the merge base with
 *       `origin/<baseBranch>`, `after` is HEAD — in a throwaway worktree, signs
 *       in, and saves one full-page PNG per route under
 *       `.ralph/logs/shots/<side>/`, with a `manifest.json`. Prints, per
 *       route, the file and where the page actually landed: a route that
 *       redirected (to the login, to the home), or that shows a sign-in form,
 *       is not a picture of the route.
 *
 *       A route may carry steps run before its shot, `|`-separated, for a
 *       state no URL reaches — a dialog, a picked date, a toast:
 *         /tasks?tab=historial|fill:Desde=2026-10-21|click:Aplicar|wait:21 oct
 *       `click:<name>` a button, link, tab or text with that exact name;
 *       `fill:<label>=<value>` the field with that label; `press:<key>`;
 *       `wait:<text>` until it shows; `eval:<js>` a script in the page. A step
 *       that fails is reported and the shot is still taken.
 *   publish <pr>
 *       Commits the captured PNGs to the repo's `ralph-screenshots` branch
 *       through the GitHub API (no local git state is touched) and writes a
 *       before/after section into the PR body, replacing the previous one.
 *   status
 *       Prints the viewport, or why this project takes no screenshots.
 *
 * Exit codes:
 *   0   done
 *   3   this project takes no screenshots, or this host cannot (no config
 *       block, no credential file, no chromium) — not a failed ticket
 *   4   the app did not come up, or a capture failed
 *   5   the sign-in was refused, or the credential fails `requireEnv`
 *   6   publish failed (nothing captured, GitHub refused)
 *  64   usage
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import { LOGS_RELATIVE_DIR, projectRoot } from "./paths";
import { currentProjectId } from "./project-id";
import { loadProjectConfig, type ScreenshotsConfig, type ScreenshotViewport } from "./project-config";

export const EXIT = {
  ok: 0,
  off: 3,
  capture: 4,
  login: 5,
  publish: 6,
  usage: 64,
} as const;

export const SHOTS_RELATIVE_DIR = `${LOGS_RELATIVE_DIR}/shots`;
export const SHOTS_BRANCH = "ralph-screenshots";
export const SECTION_START = "<!-- ralph:screenshots -->";
export const SECTION_END = "<!-- /ralph:screenshots -->";
/** The first line of the token footer (`usage.py --md`); the section goes above it. */
const FOOTER_START = "<details><summary>token usage";

const EMAIL_KEY = "SHOTS_EMAIL";
const PASSWORD_KEY = "SHOTS_PASSWORD";

export type Side = "before" | "after";

/** One photographed route, as `manifest.json` records it. */
export interface Shot {
  /** The route as given, steps included: what pairs a before with its after. */
  route: string;
  file: string;
  /** The path the page ended on; differs from the route's path when it redirected. */
  landed: string;
  /** A password field was showing: the session did not hold, whatever the URL says. */
  signIn?: boolean;
  stepErrors?: string[];
  consoleErrors: string[];
}

/** One action run on a page before its shot. */
export type Step =
  | { kind: "click"; name: string }
  | { kind: "fill"; label: string; value: string }
  | { kind: "press"; key: string }
  | { kind: "wait"; text: string }
  | { kind: "eval"; script: string };

/** A route argument split into its path and steps, or why it cannot be. */
export function parseRoute(spec: string): { ok: true; path: string; steps: Step[] } | { ok: false; error: string } {
  const [rawPath, ...rawSteps] = spec.split("|");
  const path = rawPath!.trim().startsWith("/") ? rawPath!.trim() : `/${rawPath!.trim()}`;
  const steps: Step[] = [];
  for (const raw of rawSteps) {
    const colon = raw.indexOf(":");
    const kind = colon === -1 ? raw.trim() : raw.slice(0, colon).trim();
    const arg = colon === -1 ? "" : raw.slice(colon + 1);
    if (arg.trim() === "") return { ok: false, error: `step '${raw}' in '${spec}' has nothing after its colon` };
    if (kind === "click") steps.push({ kind, name: arg.trim() });
    else if (kind === "press") steps.push({ kind, key: arg.trim() });
    else if (kind === "wait") steps.push({ kind, text: arg.trim() });
    else if (kind === "eval") steps.push({ kind, script: arg });
    else if (kind === "fill") {
      const equals = arg.indexOf("=");
      if (equals <= 0) return { ok: false, error: `step '${raw}' in '${spec}' must be fill:<label>=<value>` };
      steps.push({ kind, label: arg.slice(0, equals).trim(), value: arg.slice(equals + 1) });
    } else return { ok: false, error: `unknown step '${kind}' in '${spec}': use click, fill, press, wait or eval` };
  }
  return { ok: true, path, steps };
}

export interface Manifest {
  side: Side;
  sha: string;
  viewport: ScreenshotViewport;
  takenAt: string;
  shots: Shot[];
}

// ── Host credential ──────────────────────────────────────────────────────────

export function credentialPath(projectId: string, env: Record<string, string | undefined> = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? xdg : join(homedir(), ".config"), "ralph", "screenshots", `${projectId}.env`);
}

/** `KEY=value` lines; `#` comments, blank lines and an `export ` prefix are allowed, one level of quotes is removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]!] = match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

/** Every `requireEnv` entry the credential breaks, by name only: a value is never printed. */
export function fenceProblems(values: Record<string, string>, requireEnv: Record<string, string>): string[] {
  return Object.entries(requireEnv)
    .filter(([name, prefix]) => !(values[name] ?? "").startsWith(prefix))
    .map(([name, prefix]) => `${name} must start with '${prefix}'`);
}

/** The environment the dev server gets: the credential minus the account. */
export function serverEnv(values: Record<string, string>): Record<string, string> {
  const env = { ...values };
  delete env[EMAIL_KEY];
  delete env[PASSWORD_KEY];
  return env;
}

// ── Browser ──────────────────────────────────────────────────────────────────

/**
 * Playwright context options per viewport. The phone is a 393×852 iPhone 15,
 * the size most store workers hold, at 2× so text stays legible in the PR
 * without a 3× file; the desktop is a 1440×900 laptop screen.
 */
export function contextOptions(viewport: ScreenshotViewport): Record<string, unknown> {
  if (viewport === "phone") {
    return {
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    };
  }
  return { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
}

/**
 * The iPhone 15's safe areas, as an installed PWA sees them: 59px under the
 * Dynamic Island, 34px over the home indicator. A headless browser has none,
 * so without them `env(safe-area-inset-*)` is 0 and a header or toast that
 * sits under the island on a real phone looks fine in the shot (OAI-38).
 */
export const PHONE_INSETS = { top: 59, bottom: 34, left: 0, right: 0 } as const;

/**
 * Draws the island over the page for the shot, so a reader sees what it
 * covers. Inert: hidden from the accessibility tree and from pointer events,
 * and removed again before the next route's steps run.
 */
const DRAW_ISLAND = `(() => {
  const island = document.createElement("div");
  island.id = "ralph-shots-island";
  island.setAttribute("aria-hidden", "true");
  island.style.cssText = "position:fixed;top:11px;left:50%;transform:translateX(-50%);width:125px;height:37px;border-radius:19px;background:#000;z-index:2147483647;pointer-events:none";
  document.documentElement.appendChild(island);
})()`;
const ERASE_ISLAND = `document.getElementById("ralph-shots-island")?.remove()`;

/** supabase-js v2's default storage key for a project URL. */
export function supabaseStorageKey(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

/** A file name for a route: ordered, and readable in the branch listing. */
export function shotFileName(index: number, route: string): string {
  const slug = route.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "home";
  return `${String(index + 1).padStart(2, "0")}-${slug}.png`;
}

type Login = { ok: true; storageKey: string; session: string } | { ok: false; error: string };

/** A Supabase password sign-in, as the session JSON supabase-js keeps in localStorage. */
export async function supabaseLogin(values: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Login> {
  const url = values.VITE_SUPABASE_URL ?? values.SUPABASE_URL;
  const key = values.VITE_SUPABASE_ANON_KEY ?? values.SUPABASE_ANON_KEY;
  if (!url || !key) return { ok: false, error: "the credential file has no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY" };
  if (!values[EMAIL_KEY] || !values[PASSWORD_KEY]) return { ok: false, error: `the credential file has no ${EMAIL_KEY} / ${PASSWORD_KEY}` };
  let response: Response;
  try {
    response = await fetcher(`${url.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ email: values[EMAIL_KEY], password: values[PASSWORD_KEY] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, error: `the sign-in did not answer: ${(error as Error).message}` };
  }
  if (!response.ok) return { ok: false, error: `the sign-in was refused (HTTP ${response.status})` };
  const session = (await response.json()) as Record<string, unknown>;
  if (typeof session.access_token !== "string") return { ok: false, error: "the sign-in answered without a session" };
  if (typeof session.expires_at !== "number" && typeof session.expires_in === "number") {
    session.expires_at = Math.floor(Date.now() / 1000) + session.expires_in;
  }
  return { ok: true, storageKey: supabaseStorageKey(url), session: JSON.stringify(session) };
}

// ── Git and the dev server ───────────────────────────────────────────────────

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 120_000 });
  return { ok: result.status === 0, out: (result.status === 0 ? result.stdout : result.stderr || result.stdout || "").trim() };
}

/** The commit a side is photographed at. `before` is where the branch left its base, not the base's tip. */
export function sideCommit(root: string, side: Side, baseBranch: string): { ok: true; sha: string } | { ok: false; error: string } {
  if (side === "after") {
    const head = git(root, ["rev-parse", "HEAD"]);
    return head.ok ? { ok: true, sha: head.out } : { ok: false, error: head.out };
  }
  // A failed fetch degrades to the last fetched base; the orient step fetched it.
  git(root, ["fetch", "--quiet", "origin", baseBranch]);
  const base = git(root, ["merge-base", "HEAD", `origin/${baseBranch}`]);
  return base.ok ? { ok: true, sha: base.out } : { ok: false, error: `no merge base with origin/${baseBranch}: ${base.out}` };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves when `url` answers, or false at the deadline or when the server dies first. */
async function waitForServer(url: string, alive: () => boolean, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!alive()) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status < 500) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Where the throwaway checkout goes: the user cache when it shares the
 * project's filesystem, so `node_modules` can be hard-linked into it; the
 * system temp directory otherwise.
 */
function scratchParent(root: string): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const cache = join(xdg ? xdg : join(homedir(), ".cache"), "ralph", "shots");
  try {
    mkdirSync(cache, { recursive: true });
    if (statSync(cache).dev === statSync(root).dev) return cache;
  } catch {
    // Fall through to the temp directory.
  }
  return tmpdir();
}

/**
 * The project's installed dependencies in the checkout, not a fresh install: a
 * capture must take seconds, and a base a few commits back almost always has
 * the same lockfile. A hard-linked copy, not a symlink, because Vite serves
 * nothing whose real path is outside the checkout — a symlinked `node_modules`
 * answers 403 for every font and icon in it, and the shot renders in the wrong
 * typeface. Vite's own cache is left out, so the copy never writes into the
 * project's through a shared inode.
 */
function linkDependencies(root: string, checkout: string): "copy" | "symlink" | "none" {
  if (!existsSync(join(root, "node_modules"))) return "none";
  // A worktree whose own node_modules is a link to another's: copy what it points at.
  const modules = realpathSync(join(root, "node_modules"));
  const target = join(checkout, "node_modules");
  const copied = spawnSync("cp", ["-al", modules, target], { timeout: 300_000 });
  if (copied.status === 0) {
    rmSync(join(target, ".vite"), { recursive: true, force: true });
    return "copy";
  }
  rmSync(target, { recursive: true, force: true });
  symlinkSync(modules, target);
  return "symlink";
}

type PageLike = import("playwright-core").Page;

/** Runs one step; resolves to null, or to why it failed. */
export async function runStep(page: PageLike, step: Step): Promise<string | null> {
  const timeout = 10_000;
  try {
    if (step.kind === "click") {
      for (const role of ["button", "link", "tab", "menuitem", "option"] as const) {
        const target = page.getByRole(role, { name: step.name, exact: true }).first();
        if (await target.isVisible().catch(() => false)) {
          await target.click({ timeout });
          return null;
        }
      }
      await page.getByText(step.name, { exact: true }).first().click({ timeout });
    } else if (step.kind === "fill") {
      // A label that wraps its field's shown value ("Desde 21 oct") names it
      // longer than the text the agent sees beside it: exact first, then prefix.
      const exact = page.getByLabel(step.label, { exact: true }).first();
      const field = (await exact.count()) > 0 ? exact : page.getByLabel(step.label).first();
      await field.fill(step.value, { timeout });
    } else if (step.kind === "press") {
      await page.keyboard.press(step.key);
    } else if (step.kind === "wait") {
      await page.getByText(step.text).first().waitFor({ state: "visible", timeout: 15_000 });
    } else {
      await page.evaluate(step.script);
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    return null;
  } catch (error) {
    return `${step.kind} failed: ${(error as Error).message.split("\n")[0]!.slice(0, 200)}`;
  }
}

export interface CaptureOptions {
  root: string;
  side: Side;
  routes: string[];
  config: ScreenshotsConfig;
  baseBranch: string;
  credential: Record<string, string>;
  chromium: string;
  /** How long the app may take to come up. */
  serveTimeoutMs?: number;
  log?: (line: string) => void;
}

export type CaptureResult = { ok: true; manifest: Manifest } | { ok: false; exit: number; error: string };

/**
 * Serve the side's commit and photograph each route. The worktree, the server
 * (its whole process group) and the browser are torn down on every path out.
 */
export async function capture(options: CaptureOptions): Promise<CaptureResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const commit = sideCommit(options.root, options.side, options.baseBranch);
  if (!commit.ok) return { ok: false, exit: EXIT.capture, error: commit.error };

  const routes = options.routes.map((spec) => ({ spec, parsed: parseRoute(spec) }));
  const bad = routes.find((route) => !route.parsed.ok);
  if (bad && !bad.parsed.ok) return { ok: false, exit: EXIT.capture, error: bad.parsed.error };

  const fence = fenceProblems(options.credential, options.config.requireEnv);
  if (fence.length > 0) return { ok: false, exit: EXIT.login, error: `the credential file fails requireEnv: ${fence.join("; ")}` };

  let login: Login | null = null;
  if (options.config.login === "supabase") {
    login = await supabaseLogin(options.credential);
    if (!login.ok) return { ok: false, exit: EXIT.login, error: login.error };
  }

  const scratch = mkdtempSync(join(scratchParent(options.root), "ralph-shots-"));
  const checkout = join(scratch, "checkout");
  const added = git(options.root, ["worktree", "add", "--detach", checkout, commit.sha]);
  if (!added.ok) {
    rmSync(scratch, { recursive: true, force: true });
    return { ok: false, exit: EXIT.capture, error: `git worktree add failed: ${added.out}` };
  }
  const linked = linkDependencies(options.root, checkout);
  if (linked === "symlink") log("node_modules is symlinked, not copied: assets served from it (fonts, icons) may 403 and render wrong");

  const port = await freePort();
  const command = options.config.serve.replaceAll("{port}", String(port));
  const server = spawn("bash", ["-c", command], {
    cwd: checkout,
    env: { ...process.env, ...serverEnv(options.credential), BROWSER: "none" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  const keep = (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString()).slice(-4_000);
  };
  server.stdout?.on("data", keep);
  server.stderr?.on("data", keep);
  let exited = false;
  server.once("exit", () => {
    exited = true;
  });
  const stopServer = () => {
    if (exited || server.pid === undefined) return;
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  const onSignal = () => {
    stopServer();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const outDir = join(options.root, SHOTS_RELATIVE_DIR, options.side);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const origin = `http://127.0.0.1:${port}`;
  let browser: { close(): Promise<void> } | null = null;
  try {
    const up = await waitForServer(`${origin}/`, () => !exited, options.serveTimeoutMs ?? 120_000);
    if (!up) {
      return { ok: false, exit: EXIT.capture, error: `the app did not come up on ${origin} (${exited ? "the server exited" : "timed out"}):\n${serverLog.trim()}` };
    }
    const { chromium } = await import("playwright-core");
    // A native date input formats by the browser's own locale, not the
    // context's: on Linux that is the process's, so set both.
    const lang = options.config.locale === "es" ? "es-CL" : "en-US";
    const posix = `${lang.replace("-", "_")}.UTF-8`;
    const launched = await chromium.launch({
      executablePath: options.chromium,
      args: [`--lang=${lang}`],
      env: { ...process.env, LANG: posix, LC_ALL: posix, LANGUAGE: lang.replace("-", "_") },
    });
    browser = launched;
    // The users' locale, so a native date input or a formatted number reads the way theirs does.
    const context = await launched.newContext({ ...contextOptions(options.config.viewport), locale: lang });
    if (login?.ok) {
      // Only when absent: the app refreshes its own token, and a later page
      // load must not put the stale one back.
      await context.addInitScript(
        ([key, value]) => {
          if (!window.localStorage.getItem(key!)) window.localStorage.setItem(key!, value!);
        },
        [login.storageKey, login.session],
      );
    }
    const page = await context.newPage();
    const phone = options.config.viewport === "phone";
    if (phone) {
      const cdp = await context.newCDPSession(page);
      // Experimental in CDP; an older chromium without it shoots with no insets.
      await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: PHONE_INSETS } as never).catch(() => log("this chromium cannot emulate safe areas: the shots have no notch insets"));
    }
    let errors: string[] = [];
    // A failed request's console line names no URL; the response does.
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text().slice(0, 300));
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url().slice(0, 200)}`);
    });
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 300)));

    const shots: Shot[] = [];
    for (const [index, { spec, parsed }] of routes.entries()) {
      if (!parsed.ok) continue;
      errors = [];
      const { path, steps } = parsed;
      await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 60_000 });
      // Realtime sockets do not hold `networkidle`; a page that keeps polling
      // past the bound is photographed as it stands.
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
      for (const name of options.config.dismiss) {
        const button = page.getByRole("button", { name, exact: true }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        }
      }
      const stepErrors: string[] = [];
      for (const [number, step] of steps.entries()) {
        const failed = await runStep(page, step);
        if (failed) stepErrors.push(`step ${number + 1} ${failed}`);
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
      // A login page that keeps the route's URL is still a login page.
      const signIn = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
      const file = shotFileName(index, spec);
      if (phone) await page.evaluate(DRAW_ISLAND).catch(() => {});
      await page.screenshot({ path: join(outDir, file), fullPage: true, animations: "disabled" });
      if (phone) await page.evaluate(ERASE_ISLAND).catch(() => {});
      const landed = new URL(page.url()).pathname;
      shots.push({ route: spec, file, landed, ...(signIn ? { signIn } : {}), ...(stepErrors.length > 0 ? { stepErrors } : {}), consoleErrors: [...errors] });
      const where = landed === path.split(/[?#]/)[0] ? "" : ` — REDIRECTED to ${landed}, so this is not a picture of ${path}`;
      const wall = signIn ? " — SHOWS A SIGN-IN FORM: the session did not hold, so this is not a picture of the route" : "";
      const failedSteps = stepErrors.length > 0 ? ` — ${stepErrors.join("; ")}` : "";
      const noise = errors.length > 0 ? ` — ${errors.length} console error(s), first: ${errors[0]}` : "";
      log(`${options.side} ${spec} → ${relative(options.root, join(outDir, file))}${where}${wall}${failedSteps}${noise}`);
    }
    const manifest: Manifest = {
      side: options.side,
      sha: commit.sha,
      viewport: options.config.viewport,
      takenAt: new Date().toISOString(),
      shots,
    };
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, exit: EXIT.capture, error: `capture failed: ${(error as Error).message}` };
  } finally {
    await browser?.close().catch(() => {});
    stopServer();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    git(options.root, ["worktree", "remove", "--force", checkout]);
    rmSync(scratch, { recursive: true, force: true });
    git(options.root, ["worktree", "prune"]);
  }
}

// ── The PR body ──────────────────────────────────────────────────────────────

const WORDS = {
  en: { heading: "Screenshots — before and after", route: "Route", before: "Before", after: "After", none: "(not captured)", redirected: "redirected to", signIn: "showed the sign-in form", note: "Taken by the loop at", island: "Dynamic Island drawn", base: "base", head: "head" },
  es: { heading: "Capturas — antes y después", route: "Ruta", before: "Antes", after: "Después", none: "(sin captura)", redirected: "redirigió a", signIn: "mostró el inicio de sesión", note: "Tomadas por el loop en", island: "con la isla dinámica dibujada", base: "base", head: "head" },
} as const;

/** The PR-body section: phones side by side in a table, desktops stacked so each keeps its width. */
export function renderSection(
  manifests: Partial<Record<Side, Manifest>>,
  urlFor: (side: Side, file: string) => string,
  locale: ScreenshotsConfig["locale"],
): string {
  const words = WORDS[locale];
  const viewport = (manifests.after ?? manifests.before)!.viewport;
  const routes = [...new Set([...(manifests.before?.shots ?? []), ...(manifests.after?.shots ?? [])].map((shot) => shot.route))];
  const cell = (side: Side, route: string, width: number): string => {
    const shot = manifests[side]?.shots.find((entry) => entry.route === route);
    if (!shot) return words.none;
    const path = route.split("|")[0]!.split(/[?#]/)[0]!;
    const redirect = shot.landed === path ? "" : `<br><sub>${words.redirected} <code>${shot.landed}</code></sub>`;
    const wall = shot.signIn ? `<br><sub>${words.signIn}</sub>` : "";
    return `<img src="${urlFor(side, shot.file)}" width="${width}" alt="${side} ${escapeHtml(route.split("|").join(" → "))}">${redirect}${wall}`;
  };
  const size = viewport === "phone" ? `393×852, ${words.island}` : "1440×900";
  const labelHtml = (route: string): string => {
    const [path, ...steps] = route.split("|");
    const code = `<code>${escapeHtml(path!)}</code>`;
    return steps.length === 0 ? code : `${code}<br><sub>${steps.map(escapeHtml).join(" → ")}</sub>`;
  };
  const label = (route: string): string => {
    const [path, ...steps] = route.split("|");
    return steps.length === 0 ? `\`${path}\`` : `\`${path}\`<br><sub>${steps.map(escapeHtml).join(" → ")}</sub>`;
  };
  const lines = [SECTION_START, `## ${words.heading}`, ""];
  if (viewport === "phone") {
    // HTML, not a markdown table: a markdown row splits on every `|`, even one
    // inside an attribute, and a route's steps are `|`-separated (PWA #45).
    lines.push("<table>", `<tr><th>${words.route}</th><th>${words.before}</th><th>${words.after}</th></tr>`);
    for (const route of routes) {
      lines.push(`<tr><td>${labelHtml(route)}</td><td>${cell("before", route, 280)}</td><td>${cell("after", route, 280)}</td></tr>`);
    }
    lines.push("</table>");
  } else {
    for (const route of routes) {
      lines.push(`### ${label(route)}`, "", `**${words.before}**`, "", cell("before", route, 900), "", `**${words.after}**`, "", cell("after", route, 900), "");
    }
  }
  const shas = [
    manifests.before ? `${words.base} \`${manifests.before.sha.slice(0, 8)}\`` : null,
    manifests.after ? `${words.head} \`${manifests.after.sha.slice(0, 8)}\`` : null,
  ].filter(Boolean);
  lines.push("", `<sub>${words.note} ${viewport} ${size} · ${shas.join(" · ")}</sub>`, SECTION_END);
  return lines.join("\n");
}

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The body with the section replaced, or inserted above the token footer, or appended. */
export function spliceSection(body: string, section: string): string {
  const start = body.indexOf(SECTION_START);
  const end = body.indexOf(SECTION_END);
  if (start !== -1 && end > start) return `${body.slice(0, start)}${section}${body.slice(end + SECTION_END.length)}`;
  const footer = body.indexOf(FOOTER_START);
  if (footer !== -1) return `${body.slice(0, footer)}${section}\n\n${body.slice(footer)}`;
  return `${body.replace(/\s+$/, "")}\n\n${section}\n`;
}

// ── Publish ──────────────────────────────────────────────────────────────────

/** Runs `gh` with arguments and optional stdin; the seam the tests replace. */
export type Gh = (args: string[], input?: string) => { ok: boolean; out: string };

export const runGh: Gh = (args, input) => {
  const result = spawnSync("gh", args, { encoding: "utf8", input, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: (result.status === 0 ? result.stdout : result.stderr || result.stdout || "").trim() };
};

function ghJson(gh: Gh, args: string[], body?: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const result = gh(body === undefined ? args : [...args, "--input", "-"], body === undefined ? undefined : JSON.stringify(body));
  if (!result.ok) return { ok: false, error: result.out };
  try {
    return { ok: true, value: JSON.parse(result.out) as Record<string, unknown> };
  } catch {
    return { ok: false, error: `unparseable gh output: ${result.out.slice(0, 200)}` };
  }
}

export function readManifests(root: string): Partial<Record<Side, Manifest>> {
  const found: Partial<Record<Side, Manifest>> = {};
  for (const side of ["before", "after"] as const) {
    const path = join(root, SHOTS_RELATIVE_DIR, side, "manifest.json");
    if (!existsSync(path)) continue;
    try {
      found[side] = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    } catch {
      // A torn manifest is the same as no capture for that side.
    }
  }
  return found;
}

export interface PublishOptions {
  root: string;
  repo: string;
  pr: number;
  locale: ScreenshotsConfig["locale"];
  gh?: Gh;
  /** A stamp unique to this publish, so a re-publish never reuses a path. */
  stamp?: string;
}

/**
 * One commit on `ralph-screenshots` holding this publish's PNGs under
 * `pr-<n>/<stamp>/<side>/`, made through the git data API so the loop's
 * checkout is never touched; then the PR body's section. Another loop may move
 * the branch between our read and our write, so a refused ref update is
 * retried on the new tip.
 */
export function publish(options: PublishOptions): { ok: true; url: string } | { ok: false; error: string } {
  const gh = options.gh ?? runGh;
  const manifests = readManifests(options.root);
  if (!manifests.before && !manifests.after) return { ok: false, error: "nothing captured: run capture before and after first" };
  const stamp = options.stamp ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const api = `repos/${options.repo}`;

  const entries: { path: string; sha: string }[] = [];
  for (const side of ["before", "after"] as const) {
    for (const shot of manifests[side]?.shots ?? []) {
      const file = join(options.root, SHOTS_RELATIVE_DIR, side, shot.file);
      if (!existsSync(file)) continue;
      const blob = ghJson(gh, ["api", "-X", "POST", `${api}/git/blobs`], { content: readFileSync(file).toString("base64"), encoding: "base64" });
      if (!blob.ok) return { ok: false, error: `GitHub refused a blob: ${blob.error}` };
      entries.push({ path: `pr-${options.pr}/${stamp}/${side}/${shot.file}`, sha: String(blob.value.sha) });
    }
  }
  if (entries.length === 0) return { ok: false, error: "the manifests name no PNG that is still on disk" };

  let commitSha = "";
  for (let attempt = 1; attempt <= 3 && commitSha === ""; attempt += 1) {
    const ref = gh(["api", `${api}/git/ref/heads/${SHOTS_BRANCH}`]);
    let parent: string | null = null;
    let parentTree: string | null = null;
    if (ref.ok) {
      parent = String((JSON.parse(ref.out) as { object: { sha: string } }).object.sha);
      const parentCommit = ghJson(gh, ["api", `${api}/git/commits/${parent}`]);
      if (!parentCommit.ok) return { ok: false, error: `cannot read ${SHOTS_BRANCH}: ${parentCommit.error}` };
      parentTree = String((parentCommit.value.tree as { sha: string }).sha);
    }
    const tree = ghJson(gh, ["api", "-X", "POST", `${api}/git/trees`], {
      ...(parentTree ? { base_tree: parentTree } : {}),
      tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha })),
    });
    if (!tree.ok) return { ok: false, error: `GitHub refused the tree: ${tree.error}` };
    const commit = ghJson(gh, ["api", "-X", "POST", `${api}/git/commits`], {
      message: `screenshots for #${options.pr} (${stamp})`,
      tree: tree.value.sha,
      parents: parent ? [parent] : [],
    });
    if (!commit.ok) return { ok: false, error: `GitHub refused the commit: ${commit.error}` };
    const sha = String(commit.value.sha);
    const moved = parent
      ? ghJson(gh, ["api", "-X", "PATCH", `${api}/git/refs/heads/${SHOTS_BRANCH}`], { sha, force: false })
      : ghJson(gh, ["api", "-X", "POST", `${api}/git/refs`], { ref: `refs/heads/${SHOTS_BRANCH}`, sha });
    if (moved.ok) commitSha = sha;
    else if (attempt === 3) return { ok: false, error: `${SHOTS_BRANCH} kept moving: ${moved.error}` };
  }

  const urlFor = (side: Side, file: string) => `https://github.com/${options.repo}/blob/${commitSha}/pr-${options.pr}/${stamp}/${side}/${file}?raw=true`;
  const section = renderSection(manifests, urlFor, options.locale);
  const view = gh(["pr", "view", String(options.pr), "--repo", options.repo, "--json", "body,url"]);
  if (!view.ok) return { ok: false, error: `cannot read PR #${options.pr}: ${view.out}` };
  const { body, url } = JSON.parse(view.out) as { body: string; url: string };
  const edited = gh(["pr", "edit", String(options.pr), "--repo", options.repo, "--body-file", "-"], spliceSection(body ?? "", section));
  if (!edited.ok) return { ok: false, error: `cannot edit PR #${options.pr}: ${edited.out}` };
  return { ok: true, url };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

type Setup = { ok: true; root: string; config: ScreenshotsConfig; repo: string; baseBranch: string; projectId: string } | { ok: false; exit: number; error: string };

function setup(): Setup {
  const root = projectRoot();
  let project;
  try {
    project = loadProjectConfig(root);
  } catch (error) {
    return { ok: false, exit: EXIT.off, error: (error as Error).message };
  }
  if (!project.screenshots) return { ok: false, exit: EXIT.off, error: "this project takes no screenshots (no 'screenshots' block in .ralph/config.json)" };
  return { ok: true, root, config: project.screenshots, repo: project.repo, baseBranch: project.baseBranch, projectId: currentProjectId(root) };
}

export function readCredential(
  projectId: string,
  config: Pick<ScreenshotsConfig, "login">,
  env: Record<string, string | undefined> = process.env,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const path = credentialPath(projectId, env);
  // An app with no sign-in needs nothing from the host.
  if (!existsSync(path) && config.login === "none") return { ok: true, values: {} };
  if (!existsSync(path)) return { ok: false, error: `this host has no screenshot credential for '${projectId}' (${path})` };
  // A password other users can read is refused, as a tracker credential is.
  if ((statSync(path).mode & 0o077) !== 0) return { ok: false, error: `${path} is readable by other users: chmod 600 it` };
  return { ok: true, values: parseEnvFile(readFileSync(path, "utf8")) };
}

export async function findChromium(): Promise<string | null> {
  const { findChromium: find } = await import("./dashboard/e2e-chromium");
  return find();
}

const USAGE = "usage: ui-shots.ts capture <before|after> <route>... | publish <pr> | status";

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "capture" && command !== "publish" && command !== "status") {
    console.error(USAGE);
    return EXIT.usage;
  }
  const ready = setup();
  if (!ready.ok) {
    console.error(ready.error);
    return ready.exit;
  }

  if (command === "status") {
    const credential = ready.config.login === "none" || existsSync(credentialPath(ready.projectId));
    const chromium = await findChromium();
    if (!credential) console.log(`off: no credential at ${credentialPath(ready.projectId)}`);
    else if (!chromium) console.log("off: no chromium on this host");
    else console.log(`${ready.config.viewport}: ready`);
    return credential && chromium ? EXIT.ok : EXIT.off;
  }

  if (command === "publish") {
    const pr = Number(rest[0]);
    if (!Number.isInteger(pr) || pr <= 0) {
      console.error(USAGE);
      return EXIT.usage;
    }
    const result = publish({ root: ready.root, repo: ready.repo, pr, locale: ready.config.locale });
    if (!result.ok) {
      console.error(result.error);
      return EXIT.publish;
    }
    console.log(`screenshots published to ${result.url}`);
    return EXIT.ok;
  }

  const [side, ...routes] = rest;
  if ((side !== "before" && side !== "after") || routes.length === 0) {
    console.error(USAGE);
    return EXIT.usage;
  }
  const credential = readCredential(ready.projectId, ready.config);
  if (!credential.ok) {
    console.error(credential.error);
    return EXIT.off;
  }
  const chromium = await findChromium();
  if (!chromium) {
    console.error("no chromium on this host (Playwright's cache is empty)");
    return EXIT.off;
  }
  const result = await capture({ root: ready.root, side, routes, config: ready.config, baseBranch: ready.baseBranch, credential: credential.values, chromium });
  if (!result.ok) {
    console.error(result.error);
    return result.exit;
  }
  return EXIT.ok;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

