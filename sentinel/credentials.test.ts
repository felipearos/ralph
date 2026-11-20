// @vitest-environment node
/**
 * The sentinel's token checker (felipearos/ralph#681): a read-only token is
 * usable, a write-scoped or invalid one is refused, an outage hands the token
 * over unproved, and no message — which lands in the loop's log — ever
 * carries the token.
 */
import { describe, expect, it } from "vitest";

import type { SentinelRules } from "../project-config";
import { seedOf } from "../reporter/contract";
import { sentryEmulator } from "../reporter/sentry-emulator";
import { checkToken, SENTRY_TOKEN_ENV } from "./credentials";

const TOKEN = "sntrys_secret_token_value";

const RULES: SentinelRules = {
  reporter: { kind: "sentry", org: "acme", project: "web", environment: null },
  enabled: true,
  lookbackHours: 24,
  minEvents: 10,
  minUsers: 3,
  maxPerDay: 5,
  mode: "observe",
  language: "en",
};

const env = { [SENTRY_TOKEN_ENV]: ` ${TOKEN} ` };

describe("sentinel/credentials --check-token sentry", () => {
  it("proves a read-only token on the configured project", async () => {
    const seen: string[] = [];
    const result = await checkToken("sentry", { env, rules: RULES, fetcher: sentryEmulator(seedOf([]), seen) });
    expect(result.code).toBe(0);
    expect(result.message).toContain("Sentry token ok, reads acme/web");
    expect(seen.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(TOKEN);
  });

  it("refuses a token that can write, naming the scope", async () => {
    const seed = seedOf([], { scopes: ["project:read", "event:read", "project:write"] });
    const result = await checkToken("sentry", { env, rules: RULES, fetcher: sentryEmulator(seed) });
    expect(result.code).toBe(1);
    expect(result.message).toContain("project:write");
    expect(result.message).not.toContain(TOKEN);
  });

  it("refuses an invalid token", async () => {
    const result = await checkToken("sentry", { env, rules: RULES, fetcher: sentryEmulator(seedOf([], { tokenValid: false })) });
    expect(result.code).toBe(1);
    expect(result.message).not.toContain(TOKEN);
  });

  it("hands the token over unproved on an outage", async () => {
    const result = await checkToken("sentry", { env, rules: RULES, fetcher: sentryEmulator({ ...seedOf([]), outage: "no network" }) });
    expect(result.code).toBe(0);
    expect(result.message).toContain("unproved");
    expect(result.message).not.toContain(TOKEN);
  });

  it("refuses with no token, and with no sentinel block", async () => {
    const fetcher = sentryEmulator(seedOf([]));
    const none = await checkToken("sentry", { env: {}, rules: RULES, fetcher });
    expect(none).toEqual({ code: 1, message: `sentinel-credentials: no ${SENTRY_TOKEN_ENV} in the environment` });
    const block = await checkToken("sentry", { env, rules: null, fetcher });
    expect(block.code).toBe(1);
    expect(block.message).toContain("no 'sentinel' block");
  });
});
