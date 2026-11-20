// @vitest-environment node
/**
 * The two predicates the local server gates every request with. The page has
 * no login by design, so these are the whole of its request authenticity, and
 * the cases that matter are the ones that must be REFUSED: a name shaped like
 * loopback but owned by someone else (`127.0.0.1.evil.example`), a bare
 * `ts.net`, and a write a browser reports as `cross-site` or `same-site`.
 *
 * The one case that must be allowed and reads like a hole is a request with
 * neither header: the bridge relay and `curl` send none, so no other site can
 * be riding their cookies, and refusing them would break the bridge.
 */
import { describe, expect, it } from "vitest";

import { hostAllowed, sameSiteWrite } from "./routes";

describe("hostAllowed", () => {
  it.each(["127.0.0.1", "127.0.0.1:8791", "localhost:8791", "[::1]:8791", "LOCALHOST"])("allows %s", (host) => {
    expect(hostAllowed(host)).toBe(true);
  });
  it.each(["box.tail1234.ts.net", "box.tail1234.ts.net:8791"])("allows the tailnet name %s", (host) => {
    expect(hostAllowed(host)).toBe(true);
  });
  it.each(["evil.example", "evil.example:8791", "127.0.0.1.evil.example", "ts.net", "", null])("refuses %s", (host) => {
    expect(hostAllowed(host)).toBe(false);
  });
  it("allows a configured extra name", () => {
    expect(hostAllowed("ralph.home.arpa:8791", new Set(["ralph.home.arpa"]))).toBe(true);
  });
});

describe("sameSiteWrite", () => {
  const at = (headers: Record<string, string>): Request =>
    new Request("http://127.0.0.1:8791/api/loops/ralph/control", { method: "POST", headers });
  it("lets a non-browser client through (no Origin, no Sec-Fetch-Site)", () => {
    expect(sameSiteWrite(at({}))).toBe(true);
  });
  it("takes the browser's own account of the sender", () => {
    expect(sameSiteWrite(at({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameSiteWrite(at({ "sec-fetch-site": "none" }))).toBe(true);
    expect(sameSiteWrite(at({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameSiteWrite(at({ "sec-fetch-site": "same-site" }))).toBe(false);
    // `Sec-Fetch-Site` wins over a matching `Origin`: a script sets neither,
    // but when both arrive the fetch-metadata one is the newer, stricter
    // signal, so a forged-looking `Origin` cannot talk its way past it.
    expect(sameSiteWrite(at({ "sec-fetch-site": "cross-site", origin: "http://127.0.0.1:8791" }))).toBe(false);
  });
  it("falls back to Origin", () => {
    expect(sameSiteWrite(at({ origin: "http://127.0.0.1:8791" }))).toBe(true);
    expect(sameSiteWrite(at({ origin: "https://evil.example" }))).toBe(false);
  });
});
