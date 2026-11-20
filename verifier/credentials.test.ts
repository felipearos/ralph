// @vitest-environment node
/**
 * The verifier's token checker (felipearos/ralph#561): each answer a vendor
 * can give maps onto the supervisor's 0 usable / 1 refused / 2 unreachable,
 * and no message — which lands in the loop's log — ever carries the token.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fetch } from "./credentials";
import { scratchDir } from "../test-scratch";
import { checkToken } from "./credentials";

const FIXTURE = join(__dirname, "..", "fixtures", "loggd", ".ralph", "config.json");
const TOKEN = "sntrys_secret_token_value";

/** A temp project carrying loggd's config with `verifier` as its block (none when undefined). */
function project(verifier?: Record<string, unknown>): string {
  const root = scratchDir("ralph-verifier-credentials-");
  mkdirSync(join(root, ".ralph"));
  const config = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(
    join(root, ".ralph", "config.json"),
    JSON.stringify(verifier === undefined ? config : { ...config, loops: [...config.loops, { name: "sent", role: "verifier" }], verifier }),
  );
  return root;
}

const VERCEL = {
  productionUrl: "https://loggd.app",
  deploy: { source: "vercel", project: "prj_loggd", team: "team_loggd" },
  sentry: { org: "loggd", project: "web" },
};
const GITHUB = { ...VERCEL, deploy: { source: "github-deployments", environment: "production" } };

/** A fetcher answering `status` (or throwing when given an Error), recording each call. */
function fake(answer: number | Error): { fetcher: Fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return new Response(answer < 300 ? "{}" : `bad token ${TOKEN}`, { status: answer });
  };
  return { fetcher, calls };
}

const sentryEnv = { RALPH_VERIFIER_SENTRY_TOKEN: TOKEN };
const vercelEnv = { RALPH_VERIFIER_VERCEL_TOKEN: TOKEN };

describe("verifier/credentials --check-token", () => {
  it("proves a Sentry token on the configured project, with the token as a bearer", async () => {
    const { fetcher, calls } = fake(200);
    const result = await checkToken("sentry", sentryEnv, project(VERCEL), fetcher);
    expect(result).toEqual({ code: 0, message: "verifier-credentials: Sentry token ok, reads loggd/web" });
    expect(calls[0]!.url).toBe("https://sentry.io/api/0/projects/loggd/web/");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a token Sentry rejects or cannot see the project with, naming why", async () => {
    const unauthorized = await checkToken("sentry", sentryEnv, project(VERCEL), fake(401).fetcher);
    expect(unauthorized.code).toBe(1);
    expect(unauthorized.message).toContain("401");
    const missing = await checkToken("sentry", sentryEnv, project(VERCEL), fake(404).fetcher);
    expect(missing.code).toBe(1);
    expect(missing.message).toContain("verifier.sentry");
  });

  it("hands the token over unproved on a vendor outage or no network, never withholding it", async () => {
    // Any non-zero exit makes the supervisor withhold the token and preflight
    // deny the loop, so an outage at startup must not be one (#561 review).
    for (const answer of [500, 503, 429]) {
      const outage = await checkToken("sentry", sentryEnv, project(VERCEL), fake(answer).fetcher);
      expect(outage.code, String(answer)).toBe(0);
      expect(outage.message).toContain(`sentry.io answered ${answer}; handing the token over unproved`);
    }
    const offline = await checkToken("sentry", sentryEnv, project(VERCEL), fake(new Error("ECONNREFUSED")).fetcher);
    expect(offline.code).toBe(0);
    expect(offline.message).toContain("sentry.io could not be reached");
  });

  it("refuses a missing or blank token without calling anyone", async () => {
    const { fetcher, calls } = fake(200);
    expect(await checkToken("sentry", {}, project(VERCEL), fetcher)).toEqual({
      code: 1,
      message: "verifier-credentials: no RALPH_VERIFIER_SENTRY_TOKEN in the environment",
    });
    expect((await checkToken("vercel", { RALPH_VERIFIER_VERCEL_TOKEN: "  " }, project(VERCEL), fetcher)).code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("refuses a project with no verifier block, or no config at all", async () => {
    const none = await checkToken("sentry", sentryEnv, project(), fake(200).fetcher);
    expect(none).toEqual({ code: 1, message: "verifier-credentials: the project's .ralph/config.json has no 'verifier' block" });
    const unreadable = await checkToken("sentry", sentryEnv, scratchDir("ralph-verifier-credentials-empty-"), fake(200).fetcher);
    expect(unreadable.code).toBe(1);
    expect(unreadable.message).toContain("could not be read");
  });

  it("proves a Vercel token on the project, under its team", async () => {
    const { fetcher, calls } = fake(200);
    const result = await checkToken("vercel", vercelEnv, project(VERCEL), fetcher);
    expect(result).toEqual({ code: 0, message: "verifier-credentials: Vercel token ok, reads prj_loggd (team team_loggd)" });
    expect(calls[0]!.url).toBe("https://api.vercel.com/v9/projects/prj_loggd?teamId=team_loggd");
    const solo = fake(200);
    await checkToken("vercel", vercelEnv, project({ ...VERCEL, deploy: { source: "vercel", project: "prj_loggd" } }), solo.fetcher);
    expect(solo.calls[0]!.url).toBe("https://api.vercel.com/v9/projects/prj_loggd");
    // A team written as its URL slug is asked by slug, not passed off as an id.
    const slug = fake(200);
    await checkToken("vercel", vercelEnv, project({ ...VERCEL, deploy: { source: "vercel", project: "prj_loggd", team: "example" } }), slug.fetcher);
    expect(slug.calls[0]!.url).toBe("https://api.vercel.com/v9/projects/prj_loggd?slug=example");
    expect((await checkToken("vercel", vercelEnv, project(VERCEL), fake(403).fetcher)).code).toBe(1);
  });

  it("refuses a Vercel check on a project that deploys through GitHub deployments", async () => {
    const { fetcher, calls } = fake(200);
    const result = await checkToken("vercel", vercelEnv, project(GITHUB), fetcher);
    expect(result.code).toBe(1);
    expect(result.message).toContain("deploy source is github-deployments, not vercel");
    expect(calls).toHaveLength(0);
  });

  it("never prints the token, whatever the vendor answers", async () => {
    for (const answer of [200, 401, 403, 404, 500, new Error(`boom ${TOKEN}`)]) {
      for (const kind of ["sentry", "vercel"] as const) {
        const env = { ...sentryEnv, ...vercelEnv };
        const { message } = await checkToken(kind, env, project(VERCEL), fake(answer).fetcher);
        expect(message).not.toContain(TOKEN);
      }
    }
  });
});
