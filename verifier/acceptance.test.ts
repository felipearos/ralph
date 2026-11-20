// @vitest-environment node
/**
 * The verifier's production acceptance CLI (felipearos/ralph#566): it signs
 * in only as the test account against the PRODUCTION backend, never prints a
 * credential value, keeps probes on production's origin, runs SQL in a
 * read-only transaction, and reports pages — all in-process through `run`
 * with fakes, so no browser, network or database is touched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { VerifierRules } from "../project-config";
import { NO_SQL, run, type AcceptanceDeps, type BrowserDriver, type BrowserSession, type SqlSession } from "./acceptance";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const PROJECT = "acme";
const PRODUCTION = "https://acme.example";
const EMAIL = "tester@acme.example";
const PASSWORD = "hunter2-very-secret";
const PROD_SUPABASE = "https://prodref.supabase.co";
const PROD_ANON = "prod-anon-key-value";
const DEV_SUPABASE = "https://devref.supabase.co";
const DEV_ANON = "dev-anon-key-value";
const DATABASE = "postgres://reader:db-password-value@db.acme.example:5432/acme";
const TOKEN = "access-token-value-abc123";

const FULL = {
  SHOTS_EMAIL: EMAIL,
  SHOTS_PASSWORD: PASSWORD,
  VERIFIER_SUPABASE_URL: PROD_SUPABASE,
  VERIFIER_SUPABASE_ANON_KEY: PROD_ANON,
  VITE_SUPABASE_URL: DEV_SUPABASE,
  VITE_SUPABASE_ANON_KEY: DEV_ANON,
};
const SECRETS = [EMAIL, PASSWORD, PROD_SUPABASE, PROD_ANON, DEV_SUPABASE, DEV_ANON, DATABASE, TOKEN];

const RULES = { productionUrl: PRODUCTION } as VerifierRules;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A project root and an XDG config dir, with the credential file when `values` is given. */
function host(values: Record<string, string> | null, mode = 0o600): { root: string; env: NodeJS.ProcessEnv } {
  const root = tempDir("ralph-acceptance-root-");
  const xdg = tempDir("ralph-acceptance-xdg-");
  if (values !== null) {
    const dir = join(xdg, "ralph", "screenshots");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${PROJECT}.env`);
    writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
    chmodSync(file, mode);
  }
  return { root, env: { XDG_CONFIG_HOME: xdg, RALPH_PROJECT_ID: PROJECT } };
}

/** A fetcher that answers the sign-in with `signIn` and everything else with `answer`. */
function fakeFetch(signIn: () => Response, answer: () => Response = () => new Response("ok")): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/auth/v1/token")) return signIn();
    return answer();
  }) as typeof fetch;
  return { fetcher, calls };
}

const session = () => Response.json({ access_token: TOKEN, expires_in: 3600, refresh_token: "refresh-token-value" });

function deps(overrides: Partial<AcceptanceDeps> & Pick<AcceptanceDeps, "root" | "env">): AcceptanceDeps {
  return {
    rules: RULES,
    login: "supabase",
    fetcher: fakeFetch(session).fetcher,
    openBrowser: async () => ({ error: "no browser in this test" }),
    openSql: async () => {
      throw new Error("no database in this test");
    },
    now: () => new Date("2026-10-29T10:00:00.000Z"),
    ...overrides,
  };
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("login", () => {
  it("is inconclusive (exit 3) with no credential file, and prints no value", async () => {
    const { root, env } = host(null);
    const ran = await run(["login"], deps({ root, env }));
    expect(ran.code).toBe(3);
    expect(ran.stderr).toMatch(/^inconclusive: /);
    expectNoSecret(ran.stdout + ran.stderr);
  });

  it("refuses a credential file other users can read", async () => {
    for (const mode of [0o640, 0o604]) {
      const { root, env } = host(FULL, mode);
      const { fetcher, calls } = fakeFetch(session);
      const ran = await run(["login"], deps({ root, env, fetcher }));
      expect(ran.code).toBe(3);
      expect(ran.stderr).toContain("readable by other users");
      expect(calls).toHaveLength(0);
    }
  });

  it("is inconclusive when the file lacks the production keys, naming them but no value", async () => {
    const { VERIFIER_SUPABASE_URL: _url, VERIFIER_SUPABASE_ANON_KEY: _key, ...devOnly } = FULL;
    const { root, env } = host(devOnly);
    const { fetcher, calls } = fakeFetch(session);
    const ran = await run(["login"], deps({ root, env, fetcher }));
    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain("VERIFIER_SUPABASE_URL, VERIFIER_SUPABASE_ANON_KEY");
    // The dev backend is never a fallback for production.
    expect(calls).toHaveLength(0);
    expectNoSecret(ran.stdout + ran.stderr);
  });

  it("signs in against the production backend only, never the VITE_* one", async () => {
    const { root, env } = host(FULL);
    const { fetcher, calls } = fakeFetch(session);
    const ran = await run(["login"], deps({ root, env, fetcher }));
    expect(ran).toMatchObject({ code: 0, stdout: "signed in as the test account\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PROD_SUPABASE}/auth/v1/token?grant_type=password`);
    expect((calls[0]!.init!.headers as Record<string, string>).apikey).toBe(PROD_ANON);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it("exits 5 when the sign-in is refused or does not answer", async () => {
    const { root, env } = host(FULL);
    const refused = await run(["login"], deps({ root, env, fetcher: fakeFetch(() => new Response("no", { status: 400 })).fetcher }));
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain("refused (HTTP 400)");
    const silent = fakeFetch(() => {
      throw new Error(`connect failed to ${PROD_SUPABASE}`);
    });
    const unanswered = await run(["login"], deps({ root, env, fetcher: silent.fetcher }));
    expect(unanswered.code).toBe(5);
    expectNoSecret(refused.stdout + refused.stderr + unanswered.stdout + unanswered.stderr);
  });

  it("needs no credential under login \"none\"", async () => {
    const { root, env } = host(null);
    const ran = await run(["login"], deps({ root, env, login: "none" }));
    expect(ran.code).toBe(0);
  });
});

describe("probe", () => {
  it("sends nothing to production once the verifier is disabled in config, in any verb (#789)", async () => {
    const { root, env } = host(FULL);
    const { fetcher, calls } = fakeFetch(session, () => Response.json({}));
    let opened = 0;
    const off = deps({
      root,
      env,
      fetcher,
      rules: { ...RULES, enabled: false },
      openBrowser: async () => { opened++; return { error: "no browser in this test" }; },
    });
    for (const argv of [["login"], ["probe", "POST", "/api/items"], ["page", "/settings"], ["sql", "select 1"]]) {
      const ran = await run(argv, off);
      expect(ran.code).toBe(3);
      expect(ran.stderr).toBe("verifier-acceptance: inconclusive: the verifier is disabled in config ('verifier.enabled' is false); nothing is sent to production\n");
    }
    expect(calls).toHaveLength(0);
    expect(opened).toBe(0);
  });

  it("sends the test account's bearer to production and prints the status and body", async () => {
    const { root, env } = host(FULL);
    const { fetcher, calls } = fakeFetch(session, () => Response.json({ items: [1, 2] }));
    const bodyFile = join(root, "body.json");
    writeFileSync(bodyFile, '{"q":1}');
    const ran = await run(["probe", "POST", "/api/items?x=1", "--body", bodyFile], deps({ root, env, fetcher }));
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('HTTP 200\n{"items":[1,2]}\n');
    const call = calls.at(-1)!;
    expect(call.url).toBe(`${PRODUCTION}/api/items?x=1`);
    expect(call.init!.method).toBe("POST");
    expect((call.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect((call.init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(call.init!.body).toBe('{"q":1}');
  });

  it("refuses an absolute or protocol-relative URL before signing in", async () => {
    const { root, env } = host(FULL);
    for (const target of ["https://evil.example/steal", "//evil.example/steal", "api/items"]) {
      const { fetcher, calls } = fakeFetch(session);
      const ran = await run(["probe", "GET", target], deps({ root, env, fetcher }));
      expect(ran.code).toBe(2);
      expect(calls).toHaveLength(0);
    }
  });

  it("prints HARD BREAK on a 5xx and never the token, even when the body echoes it", async () => {
    const { root, env } = host(FULL);
    const { fetcher } = fakeFetch(session, () => new Response(`upstream down, saw Bearer ${TOKEN}`, { status: 503 }));
    const ran = await run(["probe", "GET", "/api/health"], deps({ root, env, fetcher }));
    expect(ran.code).toBe(0);
    expect(ran.stdout.split("\n").slice(0, 2)).toEqual(["HTTP 503", "HARD BREAK"]);
    expectNoSecret(ran.stdout + ran.stderr);
  });

  it("scrubs the refresh token alone, and leaves the test account's email readable", async () => {
    const { root, env } = host(FULL);
    const { fetcher } = fakeFetch(session, () => new Response(`{"user":"${FULL.SHOTS_EMAIL}","refresh":"refresh-token-value"}`));
    const ran = await run(["probe", "GET", "/api/me"], deps({ root, env, fetcher }));
    expect(ran.code).toBe(0);
    expect(ran.stdout).not.toContain("refresh-token-value");
    expect(ran.stdout).toContain(FULL.SHOTS_EMAIL);
  });

  it("exits 4 on a network error", async () => {
    const { root, env } = host(FULL);
    const { fetcher } = fakeFetch(session, () => {
      throw new Error("ECONNRESET");
    });
    const ran = await run(["probe", "GET", "/api/health"], deps({ root, env, fetcher }));
    expect(ran.code).toBe(4);
  });

  it("sends no Authorization under login \"none\" and needs no credential", async () => {
    const { root, env } = host(null);
    const { fetcher, calls } = fakeFetch(session);
    const ran = await run(["probe", "GET", "/"], deps({ root, env, fetcher, login: "none" }));
    expect(ran.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });
});

describe("sql", () => {
  it("is inconclusive (exit 3) when the project provides no read-only connection", async () => {
    const { root, env } = host(FULL);
    const ran = await run(["sql", "select 1"], deps({ root, env }));
    expect(ran.code).toBe(3);
    expect(ran.stderr).toBe(`${NO_SQL}\n`);
  });

  it("runs the query in a read-only transaction that is always rolled back", async () => {
    const { root, env } = host({ ...FULL, VERIFIER_READONLY_DATABASE_URL: DATABASE });
    const statements: string[] = [];
    let closed = false;
    let openedWith = "";
    const openSql = async (url: string): Promise<SqlSession> => {
      openedWith = url;
      return {
        exec: async (statement) => {
          statements.push(statement);
          // The database honours the wrapping limit: 51 of the table's 60 rows.
          return statement.startsWith("select") ? Array.from({ length: 51 }, (_, id) => ({ id, big: BigInt(id) })) : [];
        },
        close: async () => {
          closed = true;
        },
      };
    };
    const ran = await run(["sql", "select id from things;"], deps({ root, env, openSql }));
    expect(ran.code).toBe(0);
    expect(openedWith).toBe(DATABASE);
    expect(statements[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(statements[1]).toMatch(/^SET LOCAL statement_timeout/);
    expect(statements[2]).toBe("select * from (select id from things) as verifier_rows limit 51");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(closed).toBe(true);
    const shown = JSON.parse(ran.stdout.slice(0, ran.stdout.lastIndexOf("]") + 1)) as unknown[];
    expect(shown).toHaveLength(50);
    expect(ran.stdout).toContain("first 50 rows; there are more");
  });

  it("refuses a second statement that could escape the transaction", async () => {
    const { root, env } = host({ ...FULL, VERIFIER_READONLY_DATABASE_URL: DATABASE });
    const ran = await run(["sql", "select 1; commit; delete from things"], deps({ root, env }));
    expect(ran.code).toBe(2);
  });

  it("reports a failing query (exit 4), rolls back, and never prints the URL", async () => {
    const { root, env } = host({ ...FULL, VERIFIER_READONLY_DATABASE_URL: DATABASE });
    const statements: string[] = [];
    const openSql = async (): Promise<SqlSession> => ({
      exec: async (statement) => {
        statements.push(statement);
        if (statement.includes("delete")) throw new Error(`cannot execute DELETE in a read-only transaction (${DATABASE})`);
        return [];
      },
      close: async () => {},
    });
    const ran = await run(["sql", "delete from things"], deps({ root, env, openSql }));
    expect(ran.code).toBe(4);
    expect(ran.stderr).toContain("read-only transaction");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expectNoSecret(ran.stdout + ran.stderr);
  });
});

describe("page", () => {
  interface FakeVisit {
    status: number | null;
    landed: string;
    wall?: boolean;
    errors?: string[];
  }

  function fakeBrowser(visits: Record<string, FakeVisit>) {
    const seen: { origin: string; session: BrowserSession | null; urls: string[]; shots: string[]; steps: string[]; closed: boolean } = {
      origin: "",
      session: null,
      urls: [],
      shots: [],
      steps: [],
      closed: false,
    };
    let current: FakeVisit = { status: null, landed: "/" };
    const openBrowser = async (origin: string, session: BrowserSession | null): Promise<BrowserDriver> => {
      seen.origin = origin;
      seen.session = session;
      return {
        page: {
          goto: async (url) => {
            seen.urls.push(url);
            current = visits[new URL(url).pathname] ?? { status: 404, landed: new URL(url).pathname };
            return current.status;
          },
          runStep: async (step) => {
            seen.steps.push(step.kind);
            return step.kind === "click" ? "click failed: no such button" : null;
          },
          signInWall: async () => current.wall ?? false,
          screenshot: async (path) => {
            seen.shots.push(path);
            writeFileSync(path, "png");
          },
          landed: () => current.landed,
          takeConsoleErrors: () => current.errors ?? [],
        },
        close: async () => {
          seen.closed = true;
        },
      };
    };
    return { openBrowser, seen };
  }

  it("reports status, landed path, HARD BREAK and steps, with shots under the root", async () => {
    const { root, env } = host(FULL);
    const { openBrowser, seen } = fakeBrowser({
      "/tasks": { status: 200, landed: "/tasks", errors: ["boom"] },
      "/broken": { status: 502, landed: "/broken" },
      "/private": { status: 200, landed: "/login", wall: true },
    });
    const ran = await run(["page", "/tasks|click:Aplicar", "/broken", "/private"], deps({ root, env, openBrowser }));
    expect(ran.code).toBe(0);
    expect(seen.origin).toBe(PRODUCTION);
    expect(seen.session?.storageKey).toBe("sb-prodref-auth-token");
    expect(seen.urls).toEqual([`${PRODUCTION}/tasks`, `${PRODUCTION}/broken`, `${PRODUCTION}/private`]);
    expect(seen.closed).toBe(true);
    const lines = ran.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("/tasks|click:Aplicar — HTTP 200");
    expect(lines[0]).toContain("landed /tasks");
    expect(lines[0]).toContain("step failures: step 1 click failed");
    expect(lines[0]).toContain("1 console error(s)");
    expect(lines[0]).not.toContain("HARD BREAK");
    expect(lines[1]).toContain("HTTP 502 — HARD BREAK");
    expect(lines[2]).toContain("landed /login");
    expect(lines[2]).toContain("SIGN-IN WALL");
    const stampDir = join(root, ".ralph", "logs", "verifier", "2026-10-29T10-00-00-000Z");
    expect(seen.shots.every((shot) => shot.startsWith(stampDir))).toBe(true);
    expect(existsSync(join(stampDir, "01-tasks-click-Aplicar.png"))).toBe(true);
    expect(lines[0]).toContain("shot .ralph/logs/verifier/2026-10-29T10-00-00-000Z/01-tasks-click-Aplicar.png");
    expectNoSecret(ran.stdout + ran.stderr);
  });

  it("refuses eval: steps against production before signing in", async () => {
    // Script in a signed-in production page could read the session out of localStorage.
    const { root, env } = host(FULL);
    const { openBrowser, seen } = fakeBrowser({});
    const { fetcher, calls } = fakeFetch(session);
    const ran = await run(["page", "/tasks|eval:localStorage.length"], deps({ root, env, openBrowser, fetcher }));
    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("eval: steps are not allowed");
    expect(calls).toHaveLength(0);
    expect(seen.urls).toHaveLength(0);
  });

  it("exits 4 when the browser cannot start", async () => {
    const { root, env } = host(FULL);
    const ran = await run(["page", "/"], deps({ root, env }));
    expect(ran.code).toBe(4);
  });

  it("exits 5 before opening a browser when the sign-in is refused", async () => {
    const { root, env } = host(FULL);
    const { openBrowser, seen } = fakeBrowser({});
    const ran = await run(["page", "/"], deps({ root, env, openBrowser, fetcher: fakeFetch(() => new Response("", { status: 401 })).fetcher }));
    expect(ran.code).toBe(5);
    expect(seen.urls).toHaveLength(0);
  });

  it("runs with no session and no credential under login \"none\"", async () => {
    const { root, env } = host(null);
    const { openBrowser, seen } = fakeBrowser({ "/": { status: 200, landed: "/" } });
    const ran = await run(["page", "/"], deps({ root, env, openBrowser, login: "none" }));
    expect(ran.code).toBe(0);
    expect(seen.session).toBeNull();
  });
});
