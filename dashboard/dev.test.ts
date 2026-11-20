// @vitest-environment node
/**
 * `bun dashboard/dev.ts --target <server>`: the Vite dev server in front of the
 * REAL local server, both spawned. What only this pair can show is that the
 * proxy is transparent: the server's two refusals (`UnknownHost` on a name it
 * does not answer to, `CrossOrigin` on a write the browser reports as
 * cross-site) still judge the browser's own headers, and an SSE stream flows
 * through unbuffered. Every request goes to the dev server's URL only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bunPath, cleanupFixtures, createFixture, writeLoopState } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

// Explicit: `beforeAll` starts two children, and a slow start must fail on
// the inner 45s timer, which prints the child's log, not the hook's budget.
subprocessSuite("starts the dashboard server and the Vite dev server under bun", 120_000);

const REPO_ROOT = join(__dirname, "..");
const SERVER = join(REPO_ROOT, "dashboard", "server.ts");
const DEV = join(REPO_ROOT, "dashboard", "dev.ts");

const children: ChildProcess[] = [];
afterAll(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  cleanupFixtures();
});

/** Spawn bun and resolve with the URL its `listening on` line names. */
function startListening(script: string, args: string[], env: Record<string, string | undefined>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunPath(), script === "" ? args : [script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script || args[0]} did not start within 45s:\n${output}`));
    }, 45_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${script || args[0]} exited with ${code}:\n${output}`));
    });
  });
}

/** A GET naming its own `Host`, which `fetch` will not let a caller set. */
function getWithHost(base: string, path: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let dev = "";
let projectId = "";
/** A second dev server, in front of a target that holds its answer. */
let heldDev = "";

/** Answers `/api/held` only after 12s: past Bun's 10s default idle timeout. */
const HELD_TARGET = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/api/held") return new Response("not found", { status: 404 });
    await Bun.sleep(12_000);
    return new Response("held answer");
  },
});
console.log("listening on http://127.0.0.1:" + server.port);
`;

beforeAll(async () => {
  const f = createFixture("dev-proxy");
  const ralph = f.worktree("wt-ralph");
  writeLoopState(ralph, { loop: "ralph" });
  f.registry([ralph]);
  // The registry is seeded into the config home: keep it inside the fixture.
  const configHome = join(f.root, "config");
  mkdirSync(configHome);
  const shared = { XDG_CONFIG_HOME: configHome, PATH: `${f.bin}:${process.env.PATH ?? ""}` };
  const server = await startListening(SERVER, [], {
    ...shared,
    // Left on, the reconciler would read the fixture loop as dead and start it.
    RALPH_DASHBOARD_RECONCILE_MS: "0",
    RALPH_DASHBOARD_PORT: "0",
    RALPH_DASHBOARD_ROOTS: f.root,
    RALPH_DASHBOARD_HOSTS: "",
  });
  // The dev server allows a name the local server does not, so a request
  // under it reaches the server and shows which Host the server judged.
  dev = await startListening(DEV, ["--target", server], {
    ...shared,
    RALPH_DASHBOARD_DEV_PORT: "0",
    RALPH_DASHBOARD_HOSTS: "devonly.example",
  });
  const projects = (await (await fetch(`${dev}/api/projects`)).json()) as { projects: { id: string }[] };
  projectId = projects.projects[0]!.id;

  const held = await startListening("", ["-e", HELD_TARGET], {});
  heldDev = await startListening(DEV, ["--target", held], { ...shared, RALPH_DASHBOARD_DEV_PORT: "0" });
});

const controlPost = (site: string) =>
  fetch(`${dev}/api/control`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": site },
    // Confirmed, so the request gets past parsing to the roster lookup, which
    // refuses a loop it does not name before any command runs.
    body: JSON.stringify({ loop: "nobody", action: "stop", confirm: true }),
  });

describe("dashboard:dev in front of the local server", () => {
  it("proxies the reads, unscoped and scoped", async () => {
    const loops = await fetch(`${dev}/api/loops`);
    expect(loops.status).toBe(200);
    const body = (await loops.json()) as { loops: { loop: string }[] };
    expect(body.loops.map((entry) => entry.loop)).toContain("ralph");
    expect((await fetch(`${dev}/api/p/${projectId}/loops`)).status).toBe(200);
  });

  it("sends no CORS grant, so another localhost page cannot read /api", async () => {
    const loops = await fetch(`${dev}/api/loops`, { headers: { origin: "http://localhost:9999" } });
    expect(loops.status).toBe(200);
    expect(loops.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("forwards fetch metadata, so a same-origin write passes and a cross-site one is refused", async () => {
    const same = await controlPost("same-origin");
    expect(same.status).not.toBe(403);
    expect(((await same.json()) as { error?: string }).error).toBe("UnknownLoop");

    const cross = await controlPost("cross-site");
    expect(cross.status).toBe(403);
    expect(await cross.json()).toMatchObject({ error: "CrossOrigin" });
  });

  it("forwards the browser's Host unchanged to the server's fence", async () => {
    // Refused by Vite itself: not a name the dev server allows.
    expect((await getWithHost(dev, "/api/loops", "evil.example")).status).toBe(403);
    // Allowed by Vite, refused by the server: the server saw this very name.
    const devOnly = await getWithHost(dev, "/api/loops", "devonly.example");
    expect(devOnly.status).toBe(403);
    expect(JSON.parse(devOnly.body)).toMatchObject({ error: "UnknownHost" });
    // A tailnet name is allowed by both.
    expect((await getWithHost(dev, "/api/loops", "box.tail1234.ts.net")).status).toBe(200);
  });

  it("streams the change feed without buffering it", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${dev}/api/p/${projectId}/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    // The first bytes arrive while the response is still open.
    const reader = stream.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    controller.abort();
  });

  it(
    "does not cut a response held past Bun's 10s idle timeout, as the chat long-poll is",
    async () => {
      const held = await fetch(`${heldDev}/api/held`);
      expect(held.status).toBe(200);
      expect(await held.text()).toBe("held answer");
    },
    45_000,
  );

  it("answers a nested client route with Vite's index.html", async () => {
    const page = await fetch(`${dev}/p/${projectId}/loops/x`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/@vite/client");
  });
});
