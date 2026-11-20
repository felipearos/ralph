#!/usr/bin/env bun
/**
 * The verifier session's hands on PRODUCTION for the acceptance check
 * (felipearos/ralph#566, spec #560): load a page, call an endpoint or read the
 * database, acting only as the project's dedicated test account.
 *
 * The session's permission rails deny it the credential directory
 * (`~/.config/ralph/screenshots`), so this tool reads the file for it and
 * never prints a value from it: every line it writes is scrubbed of the
 * file's values and of the session token before it leaves `run`.
 *
 *   bun verifier/acceptance.ts login
 *   bun verifier/acceptance.ts page <route> [<route>...]
 *   bun verifier/acceptance.ts probe <METHOD> <path> [--body <file>]
 *   bun verifier/acceptance.ts sql "<query>"
 *
 * The credential is the ui-shots store (`ui-shots.ts#credentialPath`), with
 * its keys:
 *   SHOTS_EMAIL / SHOTS_PASSWORD        the one test account; the gate already
 *                                       keeps it out of Sentry, so it must be
 *                                       the same account
 *   VERIFIER_SUPABASE_URL / _ANON_KEY   the PRODUCTION auth backend. The file's
 *                                       VITE_SUPABASE_* keys are the backend
 *                                       ui-shots' dev server talks to and are
 *                                       never used here
 *   VERIFIER_READONLY_DATABASE_URL      optional: a read-only connection
 * Under the project's `screenshots.login: "none"` pages and probes run with
 * no sign-in and need no credential.
 *
 * Exit: 0 done (a HARD BREAK is printed, not an exit: the session judges), 2
 * bad usage or no verifier rules, 3 inconclusive (no usable credential, no
 * read-only connection, or the verifier disabled in config), 4 the browser,
 * the network or the query failed, 5 the sign-in was refused or did not answer.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { LOGS_RELATIVE_DIR, projectRoot } from "../paths";
import { currentProjectId } from "../project-id";
import { freshestConfig } from "../live-rules";
import { verifierRules, type VerifierRules } from "../project-config";
import { contextOptions, findChromium, parseRoute, readCredential, runStep, shotFileName, supabaseLogin, type Step } from "../ui-shots";

const PREFIX = "verifier-acceptance";

export const EXIT = { ok: 0, usage: 2, inconclusive: 3, failed: 4, login: 5 } as const;

const USAGE = [
  "usage: bun verifier/acceptance.ts login",
  "       bun verifier/acceptance.ts page <route> [<route>...]",
  "       bun verifier/acceptance.ts probe <METHOD> <path> [--body <file>]",
  "       bun verifier/acceptance.ts sql \"<query>\"",
].join("\n");

const EMAIL_KEY = "SHOTS_EMAIL";
const PASSWORD_KEY = "SHOTS_PASSWORD";
const URL_KEY = "VERIFIER_SUPABASE_URL";
const ANON_KEY = "VERIFIER_SUPABASE_ANON_KEY";
const DATABASE_KEY = "VERIFIER_READONLY_DATABASE_URL";

const BODY_LIMIT = 2_000;
const ROW_LIMIT = 50;
const OUTPUT_LIMIT = 8_000;
const STATEMENT_TIMEOUT = "15s";

export const NO_SQL =
  "inconclusive: this project provides no read-only connection; mark criteria that need SQL not-verifiable";

/** One route's page as the browser saw it. */
export interface PageDriver {
  /** Loads `url`; resolves to the main document's HTTP status, null when none answered. */
  goto(url: string): Promise<number | null>;
  runStep(step: Step): Promise<string | null>;
  /** A password field is showing: the session did not hold. */
  signInWall(): Promise<boolean>;
  screenshot(path: string): Promise<void>;
  /** The path the page ended on. */
  landed(): string;
  /** The console errors since the last call. */
  takeConsoleErrors(): string[];
}

export interface BrowserDriver {
  page: PageDriver;
  close(): Promise<void>;
}

/** A session the browser carries into every production page load. */
export interface BrowserSession {
  storageKey: string;
  session: string;
}

export interface SqlSession {
  exec(statement: string): Promise<unknown[]>;
  close(): Promise<void>;
}

export interface AcceptanceDeps {
  root: string;
  env: NodeJS.ProcessEnv;
  /** The project's verifier rules; null when its config has no verifier block. */
  rules: VerifierRules | null;
  /** The project's `screenshots.login`; "supabase" when it has no screenshots block. */
  login: "supabase" | "none";
  fetcher: typeof fetch;
  /** A browser on `origin` carrying `session`, or why none could start. */
  openBrowser: (origin: string, session: BrowserSession | null) => Promise<BrowserDriver | { error: string }>;
  openSql: (url: string) => Promise<SqlSession>;
  now: () => Date;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

const done = (code: number, stdout: string, stderr = ""): Ran => ({ code, stdout, stderr });
const fail = (code: number, stderr: string): Ran => ({ code, stdout: "", stderr: `${stderr}\n` });

/** `text` with every secret replaced: a driver or a server may echo one back. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first, so a value that contains another is scrubbed whole.
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    // A value of a character or two would shred ordinary text, and is no secret.
    if (secret.length >= 4) out = out.replaceAll(secret, "<redacted>");
  }
  return out;
}

/**
 * Every credential value that may be secret: all but the test account's
 * email, which a criterion may need to see on a page ("the profile shows
 * the user's email") and which is no secret.
 */
const secretValues = (values: Record<string, string>): string[] =>
  Object.entries(values).filter(([key]) => key !== EMAIL_KEY).map(([, value]) => value);

type Credential = { ok: true; values: Record<string, string> } | { ok: false; ran: Ran };

function credential(deps: AcceptanceDeps, login: "supabase" | "none"): Credential {
  try {
    const read = readCredential(currentProjectId(deps.root, deps.env), { login }, deps.env);
    if (!read.ok) return { ok: false, ran: fail(EXIT.inconclusive, `inconclusive: ${read.error}`) };
    return { ok: true, values: read.values };
  } catch (error) {
    return { ok: false, ran: fail(EXIT.inconclusive, `inconclusive: the credential file cannot be read: ${(error as Error).message}`) };
  }
}

type SignedIn = { ok: true; session: BrowserSession | null; token: string | null } | { ok: false; ran: Ran };

/** The test account's production session, or none under login "none". */
async function signIn(deps: AcceptanceDeps, values: Record<string, string>, secrets: string[]): Promise<SignedIn> {
  if (deps.login === "none") return { ok: true, session: null, token: null };
  const missing = [EMAIL_KEY, PASSWORD_KEY, URL_KEY, ANON_KEY].filter((key) => !values[key]?.trim());
  if (missing.length > 0) {
    return { ok: false, ran: fail(EXIT.inconclusive, `inconclusive: the credential file has no ${missing.join(", ")}`) };
  }
  // Only the production backend: a VITE_* key here would win in supabaseLogin
  // and sign the account in to the backend the dev server uses.
  const login = await supabaseLogin(
    { SUPABASE_URL: values[URL_KEY]!, SUPABASE_ANON_KEY: values[ANON_KEY]!, [EMAIL_KEY]: values[EMAIL_KEY]!, [PASSWORD_KEY]: values[PASSWORD_KEY]! },
    deps.fetcher,
  );
  if (!login.ok) return { ok: false, ran: fail(EXIT.login, `inconclusive: ${login.error}`) };
  const parsed = JSON.parse(login.session) as { access_token: string; refresh_token?: unknown };
  const token = parsed.access_token;
  // The refresh token alone too: a truncated echo of the session would no
  // longer match the whole JSON, and it outlives the access token.
  secrets.push(token, login.session, ...(typeof parsed.refresh_token === "string" ? [parsed.refresh_token] : []));
  return { ok: true, session: { storageKey: login.storageKey, session: login.session }, token };
}

function productionOrigin(deps: AcceptanceDeps): { ok: true; url: string } | { ok: false; ran: Ran } {
  if (deps.rules === null || deps.rules.productionUrl === "") {
    return { ok: false, ran: fail(EXIT.usage, `${PREFIX}: the project's .ralph/config.json has no 'verifier' block with a productionUrl`) };
  }
  return { ok: true, url: deps.rules.productionUrl.replace(/\/+$/, "") };
}

async function login(deps: AcceptanceDeps, secrets: string[]): Promise<Ran> {
  if (deps.login === "none") return done(EXIT.ok, "no sign-in: this project's pages run without one\n");
  const read = credential(deps, deps.login);
  if (!read.ok) return read.ran;
  secrets.push(...secretValues(read.values));
  const signed = await signIn(deps, read.values, secrets);
  if (!signed.ok) return signed.ran;
  return done(EXIT.ok, "signed in as the test account\n");
}

async function page(deps: AcceptanceDeps, specs: string[], secrets: string[]): Promise<Ran> {
  if (specs.length === 0) return fail(EXIT.usage, USAGE);
  const routes: { spec: string; path: string; steps: Step[] }[] = [];
  for (const spec of specs) {
    const parsed = parseRoute(spec);
    if (!parsed.ok) return fail(EXIT.usage, `${PREFIX}: ${parsed.error}`);
    // Script in a signed-in production page could read the session out of
    // localStorage and carry it off; ticket text is untrusted, so no eval.
    if (parsed.steps.some((step) => step.kind === "eval")) {
      return fail(EXIT.usage, `${PREFIX}: eval: steps are not allowed against production; use click:, fill:, press: or wait:`);
    }
    routes.push({ spec, path: parsed.path, steps: parsed.steps });
  }
  const origin = productionOrigin(deps);
  if (!origin.ok) return origin.ran;
  const read = credential(deps, deps.login);
  if (!read.ok) return read.ran;
  secrets.push(...secretValues(read.values));
  const signed = await signIn(deps, read.values, secrets);
  if (!signed.ok) return signed.ran;

  const opened = await deps.openBrowser(origin.url, signed.session);
  if ("error" in opened) return fail(EXIT.failed, `${PREFIX}: the browser did not start: ${opened.error}`);
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const outDir = join(deps.root, LOGS_RELATIVE_DIR, "verifier", stamp);
  const lines: string[] = [];
  let allLoaded = true;
  try {
    mkdirSync(outDir, { recursive: true });
    for (const [index, route] of routes.entries()) {
      const { page: tab } = opened;
      tab.takeConsoleErrors();
      let status: number | null;
      try {
        status = await tab.goto(`${origin.url}${route.path}`);
      } catch (error) {
        allLoaded = false;
        lines.push(`${route.spec} — DID NOT LOAD: ${(error as Error).message.split("\n")[0]!.slice(0, 200)}`);
        continue;
      }
      const stepErrors: string[] = [];
      for (const [number, step] of route.steps.entries()) {
        const failed = await tab.runStep(step);
        if (failed) stepErrors.push(`step ${number + 1} ${failed}`);
      }
      const wall = await tab.signInWall().catch(() => false);
      const file = join(outDir, shotFileName(index, route.spec));
      let shot: string;
      try {
        await tab.screenshot(file);
        shot = relative(deps.root, file);
      } catch (error) {
        shot = `no screenshot (${(error as Error).message.split("\n")[0]!.slice(0, 200)})`;
      }
      const errors = tab.takeConsoleErrors();
      const parts = [
        `${route.spec} — HTTP ${status ?? "?"}`,
        ...(status !== null && status >= 500 ? ["HARD BREAK"] : []),
        `landed ${tab.landed()}`,
        `shot ${shot}`,
        ...(stepErrors.length > 0 ? [`step failures: ${stepErrors.join("; ")}`] : []),
        ...(wall ? ["SIGN-IN WALL: the session did not hold"] : []),
        `${errors.length} console error(s)${errors.length > 0 ? `, first: ${errors[0]}` : ""}`,
      ];
      lines.push(parts.join(" — "));
    }
  } catch (error) {
    return done(EXIT.failed, lines.map((line) => `${line}\n`).join(""), `${PREFIX}: the browser failed: ${(error as Error).message}\n`);
  } finally {
    await opened.close().catch(() => {});
  }
  return done(allLoaded ? EXIT.ok : EXIT.failed, lines.map((line) => `${line}\n`).join(""));
}

async function probe(deps: AcceptanceDeps, args: string[], secrets: string[]): Promise<Ran> {
  const [method, path, ...rest] = args;
  let bodyFile: string | null = null;
  if (rest.length === 2 && rest[0] === "--body") bodyFile = rest[1]!;
  else if (rest.length !== 0) return fail(EXIT.usage, USAGE);
  if (method === undefined || !/^[A-Za-z]+$/.test(method) || path === undefined) return fail(EXIT.usage, USAGE);
  // A path only: an absolute URL would let a probe carry the token off production.
  if (!path.startsWith("/") || path.startsWith("//")) {
    return fail(EXIT.usage, `${PREFIX}: probe takes a path starting with '/', never a URL; got ${JSON.stringify(path)}`);
  }
  const origin = productionOrigin(deps);
  if (!origin.ok) return origin.ran;
  const target = `${origin.url}${path}`;
  if (new URL(target).origin !== new URL(origin.url).origin) {
    return fail(EXIT.usage, `${PREFIX}: ${JSON.stringify(path)} does not stay on production's origin`);
  }
  let body: string | undefined;
  if (bodyFile !== null) {
    try {
      body = readFileSync(bodyFile, "utf8");
    } catch (error) {
      return fail(EXIT.usage, `${PREFIX}: cannot read the body file ${bodyFile}: ${(error as Error).message}`);
    }
  }
  const read = credential(deps, deps.login);
  if (!read.ok) return read.ran;
  secrets.push(...secretValues(read.values));
  const signed = await signIn(deps, read.values, secrets);
  if (!signed.ok) return signed.ran;

  const headers: Record<string, string> = {};
  if (signed.token !== null) headers.authorization = `Bearer ${signed.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  let text: string;
  try {
    response = await deps.fetcher(target, { method: method.toUpperCase(), headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    text = await response.text();
  } catch (error) {
    return fail(EXIT.failed, `${PREFIX}: ${method.toUpperCase()} ${path} did not answer: ${(error as Error).message}`);
  }
  const lines = [`HTTP ${response.status}`, ...(response.status >= 500 ? ["HARD BREAK"] : []), text.slice(0, BODY_LIMIT)];
  return done(EXIT.ok, `${lines.join("\n")}\n`);
}

// Rows can carry a bigint, which JSON.stringify refuses.
const jsonSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

async function sql(deps: AcceptanceDeps, args: string[], secrets: string[]): Promise<Ran> {
  if (args.length !== 1 || args[0]!.trim() === "") return fail(EXIT.usage, USAGE);
  // Read as login "none" would: a missing file means no connection, not a
  // missing account, while one readable by other users is still refused.
  const read = credential(deps, "none");
  if (!read.ok) return read.ran;
  secrets.push(...secretValues(read.values));
  const url = read.values[DATABASE_KEY]?.trim();
  if (!url) return fail(EXIT.inconclusive, NO_SQL);
  const query = args[0]!.trim().replace(/;\s*$/, "");
  // One statement: a second one could COMMIT the read-only transaction and
  // run outside it.
  if (query.includes(";")) return fail(EXIT.usage, `${PREFIX}: sql takes a single statement, with no ';' inside it`);

  let session: SqlSession | null = null;
  try {
    session = await deps.openSql(url);
    await session.exec("BEGIN TRANSACTION READ ONLY");
    await session.exec(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    // Limited in the database, not after: a `select *` on a big table would
    // otherwise pull every row into a process on the shared host.
    const rows = await session.exec(`select * from (${query}) as verifier_rows limit ${ROW_LIMIT + 1}`);
    const shown = rows.slice(0, ROW_LIMIT);
    const note = rows.length > ROW_LIMIT ? `(first ${ROW_LIMIT} rows; there are more)\n` : `(${rows.length} row(s))\n`;
    const text = JSON.stringify(shown, jsonSafe, 2);
    // Wide jsonb or bytea columns would flood the session's context.
    const capped = text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (cut at ${OUTPUT_LIMIT} characters)` : text;
    return done(EXIT.ok, `${capped}\n${note}`);
  } catch (error) {
    return fail(EXIT.failed, `${PREFIX}: the query failed: ${(error as Error).message}`);
  } finally {
    // Always rolled back: nothing this tool runs may stay, even a read.
    await session?.exec("ROLLBACK").catch(() => []);
    await session?.close().catch(() => {});
  }
}

export async function run(argv: readonly string[], deps: AcceptanceDeps): Promise<Ran> {
  const [verb, ...rest] = argv;
  const secrets: string[] = [];
  let ran: Ran;
  // Defence in depth for the switch (#789): every verb signs in to or calls
  // production, and a `probe` may POST, so a verifier switched off while its
  // session runs sends nothing. Inconclusive, the exit a missing credential
  // has: the session records that, and `decide` then refuses as well.
  if (deps.rules?.enabled === false) {
    return fail(EXIT.inconclusive, `${PREFIX}: inconclusive: the verifier is disabled in config ('verifier.enabled' is false); nothing is sent to production`);
  }
  if (verb === "login" && rest.length === 0) ran = await login(deps, secrets);
  else if (verb === "page") ran = await page(deps, rest, secrets);
  else if (verb === "probe") ran = await probe(deps, rest, secrets);
  else if (verb === "sql") ran = await sql(deps, rest, secrets);
  else ran = fail(EXIT.usage, USAGE);
  return { code: ran.code, stdout: redact(ran.stdout, secrets), stderr: redact(ran.stderr, secrets) };
}

/** The real browser: ui-shots' chromium, desktop context, the session in production's localStorage. */
async function openChromium(origin: string, session: BrowserSession | null): Promise<BrowserDriver | { error: string }> {
  const executable = await findChromium();
  if (executable === null) return { error: "no chromium on this host (Playwright's cache is empty)" };
  const { chromium } = await import("playwright-core");
  let browser: import("playwright-core").Browser;
  try {
    browser = await chromium.launch({ executablePath: executable });
  } catch (error) {
    return { error: (error as Error).message.split("\n")[0]! };
  }
  try {
    const context = await browser.newContext(contextOptions("desktop"));
    if (session !== null) {
      // Only on production's origin, and only when absent: the app refreshes
      // its own token, and a later page load must not put the stale one back.
      await context.addInitScript(
        ([key, value, home]) => {
          if (window.location.origin === home && !window.localStorage.getItem(key!)) window.localStorage.setItem(key!, value!);
        },
        [session.storageKey, session.session, new URL(origin).origin],
      );
    }
    const tab = await context.newPage();
    let errors: string[] = [];
    tab.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text().slice(0, 300));
    });
    tab.on("response", (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url().slice(0, 200)}`);
    });
    tab.on("pageerror", (error) => errors.push(error.message.slice(0, 300)));
    const driver: PageDriver = {
      async goto(url) {
        const response = await tab.goto(url, { waitUntil: "load", timeout: 60_000 });
        // Realtime sockets do not hold `networkidle`; the page is judged as it stands.
        await tab.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        return response?.status() ?? null;
      },
      runStep: (step) => runStep(tab, step),
      signInWall: () => tab.locator('input[type="password"]').first().isVisible(),
      async screenshot(path) {
        await tab.screenshot({ path, fullPage: true, animations: "disabled" });
      },
      landed: () => new URL(tab.url()).pathname,
      takeConsoleErrors() {
        const taken = errors;
        errors = [];
        return taken;
      },
    };
    return { page: driver, close: () => browser.close() };
  } catch (error) {
    await browser.close().catch(() => {});
    return { error: (error as Error).message.split("\n")[0]! };
  }
}

/** The real connection: one reserved Bun.SQL connection, so every statement shares the transaction. */
async function openBunSql(url: string): Promise<SqlSession> {
  const pool = new Bun.SQL(url, { max: 1, connectionTimeout: 15 });
  try {
    const reserved = await pool.reserve();
    return {
      exec: async (statement) => (await reserved.unsafe(statement)) as unknown[],
      async close() {
        reserved.release();
        await pool.close({ timeout: 1 });
      },
    };
  } catch (error) {
    await pool.close({ timeout: 1 }).catch(() => {});
    throw error;
  }
}

async function main(): Promise<number> {
  const root = projectRoot();
  let rules: VerifierRules | null;
  let loginMode: "supabase" | "none";
  try {
    // What the gate that handed this check-in over last read from origin (#788).
    const config = freshestConfig(root, "verifier").config;
    rules = verifierRules(config);
    loginMode = config.screenshots?.login ?? "supabase";
  } catch (error) {
    console.error(`${PREFIX}: ${(error as Error).message}`);
    return EXIT.usage;
  }
  const ran = await run(process.argv.slice(2), {
    root,
    env: process.env,
    rules,
    login: loginMode,
    fetcher: fetch,
    openBrowser: openChromium,
    openSql: openBunSql,
    now: () => new Date(),
  });
  process.stdout.write(ran.stdout);
  process.stderr.write(ran.stderr);
  return ran.code;
}

if (import.meta.main) process.exitCode = await main();
