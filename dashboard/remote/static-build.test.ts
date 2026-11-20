// @vitest-environment node
/**
 * The remote dashboard's static half: the shell written to disk, and the
 * route constants the Vercel function shares with the local server.
 *
 * The build is driven through real `bun` processes, as Vercel and the local
 * server run it: `build-static.ts` itself, and a short script that compares
 * `writeShell` with the in-memory `buildShell` the local server serves.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { bunPath } from "../fixtures";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("bundles the dashboard shell with bun, twice", 120_000);

const DASHBOARD = join(import.meta.dirname, "..");
const REMOTE_META = '<meta name="ralph-remote" content="1">';
const INTAKE_SURFACE_META = '<meta name="ralph-surface" content="intake">';

const scratch = mkdtempSync(join(tmpdir(), "ralph-static-build-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("dashboard/routes.ts", () => {
  it("imports nothing, so the Vercel function never reaches the server's graph", () => {
    const source = readFileSync(join(DASHBOARD, "routes.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(import|export\s+[^;]*\bfrom)\b/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it("is where server.ts takes its route constants from", () => {
    const server = readFileSync(join(DASHBOARD, "server.ts"), "utf8");
    expect(server).toMatch(/from "\.\/routes"/);
    expect(server).not.toMatch(/SHELL_PAGES = /);
    expect(server).not.toMatch(/SCOPED_API_PATH = /);
  });
});

describe("bun dashboard/remote/build-static.ts", () => {
  it("writes the remote shell, flagged with the ralph-remote meta, and its assets", () => {
    const out = join(scratch, "dist");
    execFileSync(bunPath(), [join(DASHBOARD, "remote", "build-static.ts"), out], { stdio: "pipe" });

    const files = readdirSync(out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain(REMOTE_META);
    expect(html).not.toContain(INTAKE_SURFACE_META);
    const linked = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]);
    expect(linked.some((name) => name?.endsWith(".js"))).toBe(true);
    expect(linked.some((name) => name?.endsWith(".css"))).toBe(true);
    for (const name of linked) expect(files).toContain(name);

    // Every link is absolute and names a top-level file: the shell is also
    // served at nested paths (`/p/x/loops/y`), where a relative or nested
    // link would miss. Hashed names let the files be cached forever.
    const refs = [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^\/[^/]+$/);
      expect(existsSync(join(out, ref.slice(1)))).toBe(true);
      if (/\.(js|css)$/.test(ref)) expect(ref).toMatch(/-[A-Za-z0-9_-]{8,}\.(js|css)$/);
    }
  });

  it("flags the intake deployment's shell when RALPH_REMOTE_SURFACE=intake, as Vercel's build env sets it", () => {
    const out = join(scratch, "intake-dist");
    execFileSync(bunPath(), [join(DASHBOARD, "remote", "build-static.ts"), out], {
      stdio: "pipe",
      env: { ...process.env, RALPH_REMOTE_SURFACE: "intake" },
    });
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain(REMOTE_META);
    expect(html).toContain(INTAKE_SURFACE_META);
  });
});

describe("writeShell beside buildShell", () => {
  it("leaves the local shell alone and writes the same bytes, plus the meta when remote", () => {
    const script = join(scratch, "compare.ts");
    writeFileSync(
      script,
      `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildShell, writeShell } from ${JSON.stringify(join(DASHBOARD, "build.ts"))};
// Hashes, not bodies: the bundle is too large to pass back through a pipe.
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shell = await buildShell();
const read = async (dir: string, remote: boolean) => {
  await writeShell(dir, { remote });
  const files: Record<string, string> = {};
  for (const path of shell.assets.keys()) files[path] = hash(readFileSync(join(dir, path)));
  return { html: readFileSync(join(dir, "index.html"), "utf8"), files };
};
const assets: Record<string, string> = {};
for (const [path, asset] of shell.assets) assets[path] = hash(asset.body);
console.log(JSON.stringify({
  html: shell.html,
  assets,
  local: await read(${JSON.stringify(join(scratch, "local"))}, false),
  remote: await read(${JSON.stringify(join(scratch, "remote"))}, true),
}));
`,
    );
    const result = JSON.parse(execFileSync(bunPath(), [script], { encoding: "utf8" })) as {
      html: string;
      assets: Record<string, string>;
      local: { html: string; files: Record<string, string> };
      remote: { html: string; files: Record<string, string> };
    };

    // The local shell: no meta, every asset linked by absolute path.
    expect(result.html).not.toContain("ralph-remote");
    expect(result.html).not.toMatch(/(href|src)="\.\//);
    expect(Object.keys(result.assets).length).toBeGreaterThan(0);

    expect(result.local.html).toBe(result.html);
    expect(result.local.files).toEqual(result.assets);
    expect(result.remote.files).toEqual(result.assets);
    expect(result.remote.html).toBe(result.html.replace("</head>", `${REMOTE_META}</head>`));
  });
});

describe("buildShell and the process environment", () => {
  // The dashboard builds before it starts any loop, and every loop copies its
  // environment: Vite sets NODE_ENV on the process when it is unset, which
  // would put the loops' gates in React's production mode.
  it("leaves NODE_ENV as it found it, and builds the same production bundle whatever it was", () => {
    const script = join(scratch, "node-env.ts");
    writeFileSync(
      script,
      `
import { createHash } from "node:crypto";
import { buildShell } from ${JSON.stringify(join(DASHBOARD, "build.ts"))};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = (shell: Awaited<ReturnType<typeof buildShell>>) =>
  hash(new TextEncoder().encode(shell.html + [...shell.assets.values()].map((a) => hash(a.body)).join()));
delete process.env.NODE_ENV;
// Two at once, as the preview's watcher can ask: they run one after the other.
const [first, second] = await Promise.all([buildShell(), buildShell()]);
const unset = process.env.NODE_ENV === undefined;
process.env.NODE_ENV = "development";
const dev = await buildShell();
console.log(JSON.stringify({ unset, kept: process.env.NODE_ENV, same: digest(first) === digest(second) && digest(first) === digest(dev) }));
`,
    );
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.NODE_ENV;
    const result = JSON.parse(execFileSync(bunPath(), [script], { encoding: "utf8", env })) as { unset: boolean; kept: string; same: boolean };
    expect(result).toEqual({ unset: true, kept: "development", same: true });
  });
});
