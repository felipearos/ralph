// @vitest-environment node
/**
 * The intake metrics password (felipearos/ralph#459), as a unit: no password
 * locks everyone out, a wrong one waits and counts, a right one signs a
 * session that expires and dies with the password, and a flood is refused.
 */
import { describe, expect, it } from "vitest";

import { clientOf, constantTimeEqual, createIntakeGate, FAILURE_DELAY_MS, FAILURE_WINDOW_MS, INTAKE_COOKIE, MAX_FAILURES, SESSION_SECONDS } from "./intake-auth";

const withCookie = (cookie: string): Request => new Request("https://x.test/api/p/a/intake/metrics", { headers: { cookie: cookie.split(";")[0]! } });

function gate(password: string | null | undefined) {
  let now = Date.parse("2026-10-22T12:00:00.000Z");
  const slept: number[] = [];
  const g = createIntakeGate({ password, now: () => now, sleep: async (ms) => void slept.push(ms) });
  return { g, slept, advance: (ms: number) => void (now += ms) };
}

describe("the intake gate", () => {
  it("is locked for everyone with the password unset or empty: no guess opens it", async () => {
    for (const password of [undefined, null, ""]) {
      const { g } = gate(password);
      expect(g.configured).toBe(false);
      expect(await g.login("", "1.1.1.1")).toEqual({ ok: false, reason: "unconfigured" });
      expect(await g.login("anything", "1.1.1.1")).toEqual({ ok: false, reason: "unconfigured" });
      expect(await g.session(withCookie(`${INTAKE_COOKIE}=v1.9999999999999.${"A".repeat(43)}`))).toBe(false);
    }
  });

  it("answers a wrong password after the delay, and opens no session", async () => {
    const { g, slept } = gate("s3cret-intake");
    expect(await g.login("s3cret-intak", "1.1.1.1")).toEqual({ ok: false, reason: "wrong" });
    expect(await g.login(42, "1.1.1.1")).toEqual({ ok: false, reason: "wrong" });
    expect(slept).toEqual([FAILURE_DELAY_MS, FAILURE_DELAY_MS]);
    expect(await g.session(new Request("https://x.test/"))).toBe(false);
  });

  it("signs an HttpOnly, Secure, SameSite=Strict session for the right one, valid until it expires", async () => {
    const { g, slept, advance } = gate("s3cret-intake");
    const result = await g.login("s3cret-intake", "1.1.1.1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(slept).toEqual([]);
    expect(result.cookie).toMatch(new RegExp(`^${INTAKE_COOKIE}=v1\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}$`));
    expect(await g.session(withCookie(result.cookie))).toBe(true);
    advance(SESSION_SECONDS * 1000);
    expect(await g.session(withCookie(result.cookie))).toBe(false);
  });

  it("refuses a forged or altered cookie, and one signed under another password", async () => {
    const { g } = gate("s3cret-intake");
    const result = await g.login("s3cret-intake", "1.1.1.1");
    if (!result.ok) throw new Error("login failed");
    const value = result.cookie.split(";")[0]!;
    const [, expires, mac] = /=v1\.(\d+)\.(.+)$/.exec(value)!;
    // A later expiry with the same signature.
    expect(await g.session(withCookie(`${INTAKE_COOKIE}=v1.${Number(expires) + 1}.${mac}`))).toBe(false);
    expect(await g.session(withCookie(`${INTAKE_COOKIE}=v1.${expires}.${"A".repeat(43)}`))).toBe(false);
    expect(await g.session(withCookie(`${INTAKE_COOKIE}=garbage`))).toBe(false);
    const other = gate("another-password").g;
    expect(await other.session(withCookie(value))).toBe(false);
  });

  it("refuses a client past MAX_FAILURES until the window passes, and only that client", async () => {
    const { g, advance } = gate("s3cret-intake");
    for (let i = 0; i < MAX_FAILURES; i += 1) expect((await g.login("nope", "6.6.6.6")).ok).toBe(false);
    const refused = await g.login("s3cret-intake", "6.6.6.6");
    expect(refused).toMatchObject({ ok: false, reason: "throttled" });
    expect((refused as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((await g.login("s3cret-intake", "7.7.7.7")).ok).toBe(true);
    advance(FAILURE_WINDOW_MS);
    expect((await g.login("s3cret-intake", "6.6.6.6")).ok).toBe(true);
  });

  it("keys a client by its first forwarded address", () => {
    expect(clientOf(new Request("https://x.test/", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
    expect(clientOf(new Request("https://x.test/"))).toBe("unknown");
  });

  it("compares without regard to where the bytes differ", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
