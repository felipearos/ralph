// @vitest-environment node
/**
 * Configuration is absolute-path-typed and loud. These cases pin the two
 * failure modes that matter for a local tool: a relative root (a `cd` would
 * change what is observed) and a bad port (a server that never binds).
 */
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_ENV,
  DashboardConfigError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  configFromEnv,
} from "./config";

const cliDir = "/srv/ralph";
const root = "/srv/loggd";

describe("dashboard configuration", () => {
  it("binds localhost and a fixed default port with no environment", () => {
    const config = configFromEnv({}, { cliDir, root });
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.roots).toEqual(["/srv/loggd"]);
    // The default root only seeds a missing registry; it overrides nothing.
    expect(config.rootsOverride).toBe(false);
  });

  it("takes port, roots and bun from the environment but never the bind address", () => {
    const config = configFromEnv(
      {
        [DASHBOARD_ENV.port]: "0",
        [DASHBOARD_ENV.roots]: "/a/loggd, /b/loggd",
        [DASHBOARD_ENV.bun]: "/opt/bun",
      },
      { cliDir, root },
    );
    expect(config).toEqual({
      host: DEFAULT_HOST,
      port: 0,
      roots: ["/a/loggd", "/b/loggd"],
      rootsOverride: true,
      cliDir,
      bunPath: "/opt/bun",
      hosts: [],
    });
  });

  it("parses the extra Host names, lower-cased, and defaults to none", () => {
    // Unset means loopback and the tailnet only — `hostAllowed` holds those.
    expect(configFromEnv({}, { cliDir, root }).hosts).toEqual([]);
    expect(configFromEnv({ [DASHBOARD_ENV.hosts]: "" }, { cliDir, root }).hosts).toEqual([]);
    // A `Host` header is compared lower-cased, so the allowlist is stored that way.
    expect(
      configFromEnv({ [DASHBOARD_ENV.hosts]: "Box.Example, ralph.home.arpa" }, { cliDir, root }).hosts,
    ).toEqual(["box.example", "ralph.home.arpa"]);
    // The refusal an operator copies the name out of prints the raw `Host`,
    // port included, and `hostAllowed` compares port-less names: pasting it
    // back in has to work rather than silently never match.
    expect(
      configFromEnv({ [DASHBOARD_ENV.hosts]: "box.example:8791" }, { cliDir, root }).hosts,
    ).toEqual(["box.example"]);
  });

  it("takes an absolute starter from the environment, and refuses a relative one", () => {
    expect(configFromEnv({}, { cliDir, root }).startScript).toBeUndefined();
    expect(
      configFromEnv({ [DASHBOARD_ENV.start]: "/srv/harness/start.sh" }, { cliDir, root }).startScript,
    ).toBe("/srv/harness/start.sh");
    expect(() => configFromEnv({ [DASHBOARD_ENV.start]: "start.sh" }, { cliDir, root })).toThrow(
      DashboardConfigError,
    );
  });

  it("refuses a relative root rather than resolving it against the cwd", () => {
    expect(() =>
      configFromEnv({ [DASHBOARD_ENV.roots]: "loggd" }, { cliDir, root }),
    ).toThrow(DashboardConfigError);
  });

  it("refuses a port that is not a bindable integer", () => {
    for (const port of ["70000", "-1", "eighty", "8.5"]) {
      expect(() => configFromEnv({ [DASHBOARD_ENV.port]: port }, { cliDir, root })).toThrow(
        DashboardConfigError,
      );
    }
  });
});
