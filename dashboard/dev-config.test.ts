// @vitest-environment node
/**
 * `dev.ts`'s pure pieces: the arguments, the environment, and the Vite config
 * they build. Nothing here starts a server; `dev.test.ts` drives the real one.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_DEV_HOST, DEFAULT_DEV_PORT, devOptionsFromEnv, devViteConfig, parseDevArgs } from "./dev";

describe("parseDevArgs", () => {
  it("takes the target as a separate value or after =", () => {
    expect(parseDevArgs(["--target", "http://127.0.0.1:8791"])).toEqual({
      help: false,
      target: "http://127.0.0.1:8791",
    });
    expect(parseDevArgs(["--target=https://box.tail1234.ts.net"])).toEqual({
      help: false,
      target: "https://box.tail1234.ts.net",
    });
    expect(parseDevArgs([])).toEqual({ help: false });
  });

  it("refuses a missing, empty or non-http target and an unknown argument", () => {
    expect(() => parseDevArgs(["--target"])).toThrow(/needs a URL/);
    expect(() => parseDevArgs(["--target="])).toThrow();
    expect(() => parseDevArgs(["--target", "file:///etc/passwd"])).toThrow(/http\(s\)/);
    expect(() => parseDevArgs(["--bogus"])).toThrow(/unknown argument '--bogus'/);
  });

  it("reads --help", () => {
    expect(parseDevArgs(["--help"]).help).toBe(true);
  });
});

describe("devOptionsFromEnv", () => {
  it("defaults to loopback on 8794 with no extra hosts", () => {
    expect(DEFAULT_DEV_PORT).toBe(8794);
    expect(devOptionsFromEnv({})).toEqual({ host: DEFAULT_DEV_HOST, port: 8794, hosts: [] });
    expect(DEFAULT_DEV_HOST).toBe("127.0.0.1");
  });

  it("accepts port 0 and refuses a port that is not one", () => {
    expect(devOptionsFromEnv({ RALPH_DASHBOARD_DEV_PORT: "0" }).port).toBe(0);
    expect(() => devOptionsFromEnv({ RALPH_DASHBOARD_DEV_PORT: "abc" })).toThrow(/RALPH_DASHBOARD_DEV_PORT/);
    expect(() => devOptionsFromEnv({ RALPH_DASHBOARD_DEV_PORT: "70000" })).toThrow(/RALPH_DASHBOARD_DEV_PORT/);
  });

  it("normalises RALPH_DASHBOARD_HOSTS the way the server does", () => {
    expect(devOptionsFromEnv({ RALPH_DASHBOARD_HOSTS: "Box.Example:8080, x.y" }).hosts).toEqual([
      "box.example",
      "x.y",
    ]);
  });
});

describe("devViteConfig", () => {
  const config = devViteConfig({
    target: "http://127.0.0.1:8791",
    host: "127.0.0.1",
    port: 0,
    hosts: ["box.example"],
  });

  it("serves the SPA with no CORS grant on a port that does not move", () => {
    expect(config.appType).toBe("spa");
    expect(config.server?.cors).toBe(false);
    expect(config.server?.strictPort).toBe(true);
    expect(config.server?.port).toBe(0);
  });

  it("allows the tailnet and the extra hosts", () => {
    const allowed = config.server?.allowedHosts;
    expect(Array.isArray(allowed)).toBe(true);
    expect((allowed as string[])[0]).toBe(".ts.net");
    expect(allowed).toContain("box.example");
  });

  it("proxies /api to the target with the browser's Host and no websocket", () => {
    expect(config.server?.proxy?.["/api"]).toMatchObject({
      target: "http://127.0.0.1:8791",
      changeOrigin: false,
      ws: false,
    });
  });
});
