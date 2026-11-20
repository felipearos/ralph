// @vitest-environment node
/**
 * The dashboard and bridge as systemd user units (#170): what the unit files
 * say, that systemd itself accepts them, and that the installer copies them
 * into the user's unit directory and nothing else.
 *
 * Nothing here talks to the real user manager. `systemd-analyze verify` only
 * parses files, and every installer run gets a fake `systemctl` and `loginctl`
 * first on PATH, a scratch HOME and a scratch XDG_CONFIG_HOME.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../../test-scratch";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs install-units.sh and systemd-analyze");

const UNITS_DIR = join(__dirname, "systemd");
const INSTALLER = join(__dirname, "install-units.sh");
const DASHBOARD = "ralph-dashboard.service";
const BRIDGE = "ralph-bridge.service";

/** Every `Key=value` in a unit, by section; repeated keys keep each value. */
function parseUnit(file: string): Record<string, Record<string, string[]>> {
  const sections: Record<string, Record<string, string[]>> = {};
  let current: Record<string, string[]> | undefined;
  for (const raw of readFileSync(join(UNITS_DIR, file), "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = sections[header[1]!] = {};
      continue;
    }
    const eq = line.indexOf("=");
    if (current === undefined || eq < 0) throw new Error(`${file}: unparsed line ${line}`);
    (current[line.slice(0, eq)] ??= []).push(line.slice(eq + 1));
  }
  return sections;
}

/** The one value of a key that must appear once. */
function one(unit: Record<string, Record<string, string[]>>, section: string, key: string): string | undefined {
  const values = unit[section]?.[key];
  expect(values?.length ?? 0, `${section}.${key} set once`).toBeLessThanOrEqual(1);
  return values?.[0];
}

describe("unit files", () => {
  const dashboard = parseUnit(DASHBOARD);
  const bridge = parseUnit(BRIDGE);

  it("runs the existing dashboard wrapper, restarting it, at login", () => {
    expect(one(dashboard, "Service", "ExecStart")).toBe("%h/.local/bin/ralph-dashboard");
    expect(one(dashboard, "Service", "WorkingDirectory")).toBe("%h/ralph");
    expect(one(dashboard, "Service", "Restart")).toBe("always");
    expect(one(dashboard, "Service", "RestartSec")).toBe("5");
    expect(one(dashboard, "Install", "WantedBy")).toBe("default.target");
  });

  // Loops normally live in their own scopes now (start.sh), but a loop started
  // on start.sh's `nohup setsid` fallback is still in this cgroup, and a plain
  // restart must not control-group-kill it.
  it("stops the wrapper alone, so a loop on start.sh's fallback path survives a restart", () => {
    expect(one(dashboard, "Service", "KillMode")).toBe("process");
  });

  it("runs the bridge under Doppler, after and bound to the dashboard", () => {
    expect(one(bridge, "Service", "ExecStart")).toBe(
      "doppler run --scope %h/doppler-new-ws --project software-factory --config bridge -- bun %h/ralph/dashboard/remote/bridge.ts",
    );
    expect(one(bridge, "Unit", "Requires")).toBe(DASHBOARD);
    expect(one(bridge, "Unit", "After")?.split(/\s+/)).toContain(DASHBOARD);
    expect(one(bridge, "Service", "Restart")).toBe("always");
    expect(one(bridge, "Service", "RestartSec")).toBe("5");
    expect(one(bridge, "Install", "WantedBy")).toBe("default.target");
  });

  it("keeps the bridge out of the loops' way", () => {
    expect(one(bridge, "Service", "Nice")).toBe("10");
    expect(one(bridge, "Service", "IOSchedulingClass")).toBe("idle");
    expect(one(bridge, "Service", "MemoryMax")).toBe("512M");
  });

  it("holds no secrets and no literal home directory", () => {
    for (const file of [DASHBOARD, BRIDGE]) {
      const unit = parseUnit(file);
      const env = Object.values(unit).flatMap((section) => [...(section.Environment ?? []), ...(section.EnvironmentFile ?? [])]);
      expect(unit.Service?.EnvironmentFile, file).toBeUndefined();
      for (const assignment of env) expect(assignment, file).not.toMatch(/TOKEN|SECRET|KEY|PASSWORD|SUPABASE/i);
      expect(readFileSync(join(UNITS_DIR, file), "utf8"), file).not.toMatch(/\/home\/(?!linuxbrew\/)/);
    }
  });
});

const systemdAnalyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).status === 0;

describe("systemd-analyze verify", () => {
  // `verify` checks that each ExecStart resolves to an executable. A scratch
  // HOME carries a stand-in wrapper, so `%h/.local/bin/ralph-dashboard` needn't
  // exist on the host; `doppler` is looked up on systemd's own search path,
  // which no environment variable redirects, so on a host without it that one
  // diagnostic is expected and set aside.
  it.skipIf(!systemdAnalyze)("accepts both unit files", () => {
    const home = scratchDir("ralph-units-verify-");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const wrapper = join(home, ".local", "bin", "ralph-dashboard");
    writeFileSync(wrapper, "#!/bin/sh\nexit 0\n");
    chmodSync(wrapper, 0o755);

    const result = spawnSync(
      "systemd-analyze",
      ["--user", "--man=no", "verify", join(UNITS_DIR, DASHBOARD), join(UNITS_DIR, BRIDGE)],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    const hasDoppler = spawnSync("sh", ["-c", "command -v doppler"]).status === 0;
    const diagnostics = `${result.stdout}${result.stderr}`
      .split("\n")
      .filter((line) => line.trim() !== "")
      .filter((line) => hasDoppler || !/Command doppler is not executable/.test(line));
    expect(diagnostics).toEqual([]);
    if (hasDoppler) expect(result.status).toBe(0);
  });
});

/** A scratch HOME, config home and fake `systemctl`/`loginctl` that log their argv. */
function installerSandbox(): { home: string; config: string; calls: string; env: NodeJS.ProcessEnv } {
  const root = scratchDir("ralph-install-units-");
  const home = join(root, "home");
  const config = join(home, ".config");
  const bin = join(root, "bin");
  const calls = join(root, "calls.log");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(calls, "");
  for (const tool of ["systemctl", "loginctl"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s %s\\n' ${tool} "$*" >> ${JSON.stringify(calls)}\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, PATH: `${bin}:${process.env.PATH}` };
  return { home, config, calls, env };
}

function install(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("bash", [INSTALLER, ...args], { encoding: "utf8", env });
}

/** Every file under `dir`, relative to it, with its mtime. */
function tree(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path)] = statSync(path).mtimeMs;
  }
  return out;
}

describe("install-units.sh", () => {
  it("copies both units into the user unit dir and reloads the manager, idempotently", () => {
    const { home, config, calls, env } = installerSandbox();

    const first = install(env);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const unitDir = join(config, "systemd", "user");
    for (const unit of [DASHBOARD, BRIDGE]) {
      expect(readFileSync(join(unitDir, unit), "utf8")).toBe(readFileSync(join(UNITS_DIR, unit), "utf8"));
      expect(statSync(join(unitDir, unit)).mode & 0o777).toBe(0o644);
    }
    // Touches the user unit directory and nothing else in HOME.
    const after = tree(home);
    expect(Object.keys(after).sort()).toEqual([`.config/systemd/user/${BRIDGE}`, `.config/systemd/user/${DASHBOARD}`]);

    const second = install(env);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`${DASHBOARD} unchanged`);
    expect(second.stdout).toContain(`${BRIDGE} unchanged`);
    expect(tree(home)).toEqual(after);

    expect(readFileSync(calls, "utf8")).toBe("systemctl --user daemon-reload\nsystemctl --user daemon-reload\n");
  });

  it("prints the enable and linger commands without running them", () => {
    const { calls, env } = installerSandbox();
    const { stdout, status } = install(env);
    expect(status).toBe(0);
    expect(stdout).toContain(`systemctl --user enable --now ${DASHBOARD} ${BRIDGE}`);
    expect(stdout).toMatch(/loginctl enable-linger \S+/);
    expect(stdout).toContain("journalctl --user -u ralph-bridge -f");
    expect(readFileSync(calls, "utf8")).not.toMatch(/enable|start|linger/);
  });

  it("installs the dashboard alone with --dashboard-only", () => {
    const { home, calls, env } = installerSandbox();
    const { stdout, status } = install(env, "--dashboard-only");
    expect(status).toBe(0);
    expect(Object.keys(tree(home))).toEqual([`.config/systemd/user/${DASHBOARD}`]);
    expect(stdout).toContain(`systemctl --user enable --now ${DASHBOARD}\n`);
    expect(stdout).not.toContain("ralph-bridge");
    expect(readFileSync(calls, "utf8")).toBe("systemctl --user daemon-reload\n");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const { home, env } = installerSandbox();
    delete env.XDG_CONFIG_HOME;
    expect(install(env, "--dashboard-only").status).toBe(0);
    expect(Object.keys(tree(home))).toEqual([`.config/systemd/user/${DASHBOARD}`]);
  });

  it("refuses an unknown argument before touching anything", () => {
    const { home, calls, env } = installerSandbox();
    const { stderr, status } = install(env, "--enable");
    expect(status).toBe(2);
    expect(stderr).toContain("unknown argument: --enable");
    expect(tree(home)).toEqual({});
    expect(readFileSync(calls, "utf8")).toBe("");
  });
});
