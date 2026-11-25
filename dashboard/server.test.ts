// @vitest-environment node
/**
 * The dashboard as a real process: `bun dashboard/server.ts`, spawned as a
 * subprocess on an ephemeral localhost port and driven with `fetch` and raw
 * sockets. The routes themselves are `server-handler.test.ts`'s, driven
 * in-process; what stays here is what only the entrypoint can show, because
 * vitest runs under Node, where `Bun.serve` does not exist:
 *
 *   - the shell at `/`, its deep links and overview pages, and its assets —
 *     the real shell build `main()` serves, not a stub;
 *   - that the server binds loopback whatever host the environment asks for,
 *     and answers a socket that sends no `Host` at all — `Bun.serve`'s own;
 *   - that a missing registry is seeded from `RALPH_DASHBOARD_ROOTS`, which then
 *     overrides the file — the env-parsed registry `main()` builds at boot;
 *   - that `RALPH_DASHBOARD_RECONCILE_MS=0` turns the reconciler off — the
 *     schedule `main()` alone starts;
 *   - the Usage route, whose source reads the logs in a `node:worker_threads`
 *     worker (`usage-worker.ts`) that only Bun can load.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { bunPath, cleanupFixtures, createFixture, writeLoopState, type Fixture } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";
import { fileScratchDir, scratchDir } from "../test-scratch";

// Every server this suite boots remembers its UsageBar reading under the XDG
// cache home: point it at a scratch directory, never the operator's own.
const CACHE_HOME = fileScratchDir("ralph-test-cache-");

subprocessSuite("starts the dashboard server under bun");

const REPO_ROOT = join(__dirname, "..");
const SERVER = join(REPO_ROOT, "dashboard", "server.ts");

const children: ChildProcess[] = [];
afterAll(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  cleanupFixtures();
});

interface RunningServer {
  base: string;
  stop: () => void;
  /** Everything the child has written to stdout and stderr so far. */
  log: () => string;
}

function startServer(env: Record<string, string | undefined>): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunPath(), [SERVER], {
      cwd: REPO_ROOT,
      // The loop reconciler is OFF for every server this suite boots unless a
      // case asks for it: left on, its startup pass would read these fixture
      // worktrees — whose records name no `stopReason` and whose supervisors
      // do not exist — as dead loops, and run the real `start.sh` on them.
      env: { ...process.env, XDG_CACHE_HOME: CACHE_HOME, RALPH_DASHBOARD_RECONCILE_MS: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start within 20s:\n${output}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ base: match[1]!, stop: () => child.kill("SIGKILL"), log: () => output });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });
}

const serverFor = (f: Fixture) =>
  startServer({
    RALPH_DASHBOARD_PORT: "0",
    RALPH_DASHBOARD_ROOTS: f.root,
    PATH: `${f.bin}:${process.env.PATH ?? ""}`,
  });

describe("the dashboard over HTTP", () => {
  it("serves the shell, its deep links and overview pages, and the shell's assets", async () => {
    const f = createFixture("http");
    const ralph = f.worktree("wt-ralph");
    const rafa = f.worktree("wt-rafa");
    writeLoopState(ralph, { loop: "ralph" });
    writeLoopState(rafa, { loop: "rafa" });
    const gone = join(f.root, "wt-remo");
    f.registry([ralph, rafa, gone]);

    const server = await serverFor(f);
    try {
      const shell = await fetch(`${server.base}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain("text/html");
      expect(await shell.text()).toContain("Ralph dashboard");
      // The per-loop route is client-side; a deep link must get the shell.
      const deep = await fetch(`${server.base}/loops/ralph`);
      expect(deep.status).toBe(200);
      // ...and so must each overview page the sidebar links to.
      for (const page of ["/notifications", "/usage", "/backlog", "/ci", "/learnings", "/ownership", "/reconciliation"]) {
        expect((await fetch(`${server.base}${page}`)).status).toBe(200);
      }
      expect(deep.headers.get("content-type")).toContain("text/html");
      // ...and the shell's assets must resolve from that nested path too.
      const deepHtml = await deep.text();
      expect(deepHtml).not.toMatch(/(href|src)="\.\//);
      for (const [, asset] of deepHtml.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
        expect((await fetch(`${server.base}${asset}`)).status).toBe(200);
      }
    } finally {
      server.stop();
    }
  });

  it("binds loopback only, whatever host the environment asks for", async () => {
    const f = createFixture("http-loopback");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph" });
    f.registry([ralph]);
    const server = await startServer({
      RALPH_DASHBOARD_PORT: "0",
      RALPH_DASHBOARD_ROOTS: f.root,
      RALPH_DASHBOARD_HOST: "0.0.0.0",
      HOST: "0.0.0.0",
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
    });
    try {
      expect(new URL(server.base).hostname).toBe("127.0.0.1");
    } finally {
      server.stop();
    }
  });
});

describe("projects over HTTP", () => {
  /** A config home of its own, so each server sees only the registry the test wrote. */
  const configHome = (): string => scratchDir("ralph-dashboard-config-");
  const registryIn = (home: string): string => join(home, "ralph", "projects.json");
  const entry = (id: string, path: string) => ({ id, path, addedAt: "2026-09-23T00:00:00.000Z", source: "local" });

  it("seeds a missing registry from RALPH_DASHBOARD_ROOTS, which then overrides the file for the run", async () => {
    const f = createFixture("http-seed");
    const alpha = f.project("alpha");
    const beta = f.project("beta");
    const home = configHome();

    const seeded = await startServer({
      RALPH_DASHBOARD_PORT: "0",
      RALPH_DASHBOARD_ROOTS: alpha.root,
      XDG_CONFIG_HOME: home,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
    });
    try {
      expect(JSON.parse(readFileSync(registryIn(home), "utf8"))).toEqual([
        expect.objectContaining({ id: "alpha", path: alpha.root, source: "local" }),
      ]);
      expect(await (await fetch(`${seeded.base}/api/projects`)).json()).toEqual({
        projects: [expect.objectContaining({ id: "alpha", path: alpha.root })],
      });
    } finally {
      seeded.stop();
    }

    // With a registry on disk, the variable still wins for the run, and the file is left alone.
    const registered = JSON.stringify([entry("alpha", alpha.root), entry("beta", beta.root)]);
    writeFileSync(registryIn(home), registered);
    const overridden = await startServer({
      RALPH_DASHBOARD_PORT: "0",
      RALPH_DASHBOARD_ROOTS: beta.root,
      XDG_CONFIG_HOME: home,
      PATH: `${f.bin}:${process.env.PATH ?? ""}`,
    });
    try {
      const body = (await (await fetch(`${overridden.base}/api/projects`)).json()) as { projects: { id: string }[] };
      expect(body.projects.map((project) => project.id)).toEqual(["beta"]);
      expect((await fetch(`${overridden.base}/api/p/alpha/loops`)).status).toBe(404);
      expect(readFileSync(registryIn(home), "utf8")).toBe(registered);
    } finally {
      overridden.stop();
    }
  }, 60_000);

  /**
   * Two projects on one scratch machine, both registered: alpha, with one
   * ralph checkout, and beta, whose ralph waits on an approval and whose rafa
   * stopped on an error.
   */
  const twoProjects = (label: string) => {
    const f = createFixture(label);
    const alpha = f.project("alpha");
    const beta = f.project("beta");
    const alphaRalph = alpha.worktree("ralph-loop");
    const betaRalph = beta.worktree("ralph-loop");
    const betaRafa = beta.worktree("rafa-loop");
    writeLoopState(alphaRalph, { loop: "ralph" });
    writeLoopState(betaRalph, { loop: "ralph" });
    writeLoopState(betaRafa, { loop: "rafa" });
    const statePath = join(betaRafa, ".ralph", "logs", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, stage: "stopped", stopReason: { kind: "failed", why: "gate failed", at: "2026-09-23T10:00:00.000Z" } }),
    );
    writeFileSync(
      join(betaRalph, ".ralph", "logs", "controls.json"),
      JSON.stringify({
        version: 1,
        ralphRun: "run-ralph",
        loop: "ralph",
        ownerChangedAt: null,
        applied: [],
        hold: { kind: "approval", why: "decision gate g1: ship it?", since: "2026-09-23T10:10:00.000Z", key: null, gate: "g1" },
        stop: null,
        retries: [],
        abandoned: [],
        released: [],
        deferrals: [],
        lastPolledAt: null,
      }),
    );
    alpha.registry([alpha.root, alphaRalph]);
    beta.registry([beta.root, betaRalph, betaRafa]);
    const home = configHome();
    mkdirSync(join(home, "ralph"), { recursive: true });
    writeFileSync(registryIn(home), JSON.stringify([entry("alpha", alpha.root), entry("beta", beta.root)]));
    const start = () =>
      startServer({
        RALPH_DASHBOARD_PORT: "0",
        RALPH_DASHBOARD_ROOTS: "",
        XDG_CONFIG_HOME: home,
        PATH: `${f.bin}:${process.env.PATH ?? ""}`,
      });
    return { f, alpha, beta, alphaRalph, betaRalph, start };
  };

  /**
   * The usage source reads every loop's logs in a `node:worker_threads`
   * worker, `usage-worker.ts`, whose extensionless imports only Bun resolves:
   * under vitest's Node the worker cannot load, so this route is driven
   * against the real process.
   */
  it("scopes Usage to the project's loops, beside the account's plan across every project", async () => {
    const { f, alphaRalph, betaRalph, start } = twoProjects("http-usage-split");
    const tagged = (at: string) => ({ ralph_stage: "orchestrator", ralph_iteration: 1, ralph_run: "run-ralph", ralph_received_at: at });
    const result = (uuid: string, at: string, cost: number) =>
      JSON.stringify({ type: "result", uuid, session_id: `s-${uuid}`, total_cost_usd: cost, modelUsage: {}, ...tagged(at) });
    const rate = (at: string, status: string, utilization: number) =>
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization } } },
        ...tagged(at),
      });
    const events = (worktree: string, lines: string[]) =>
      writeFileSync(join(worktree, ".ralph", "logs", "iter-run-ralph-1.events.jsonl"), `${lines.join("\n")}\n`);
    const recent = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    events(alphaRalph, [result("a1", recent(2), 1.25), rate(recent(2), "allowed", 0.3)]);
    // Beta reported the account's newer reading.
    events(betaRalph, [result("b1", recent(1), 4), rate(recent(1), "allowed_warning", 0.8)]);
    // UsageBar's CLI, stubbed on the server's PATH: the suite must never ask
    // the real providers. It exits 3, as the CLI does when any provider failed,
    // and still prints every provider's entry.
    const codexbar = join(f.bin, "codexbar");
    writeFileSync(
      codexbar,
      [
        "#!/bin/sh",
        `printf '%s\\n' '[{"provider":"codex","source":"oauth","usage":{"primary":{"usedPercent":58,"windowMinutes":43200,"resetsAt":"2026-11-23T00:48:27Z"}},"rateWindowLabels":{"primary":"Session"}},{"provider":"claude","error":{"message":"rate limited"}}]'`,
        "exit 3",
        "",
      ].join("\n"),
    );
    chmodSync(codexbar, 0o755);

    const server = await start();
    try {
      const response = await fetch(`${server.base}/api/p/alpha/usage`);
      expect(response.status).toBe(200);
      const report = (await response.json()) as {
        spend: { total: number };
        loops: { loop: string; costUsd: number }[];
        plan: { status: string } | null;
        account: {
          scope: string;
          plan: { project: string; status: string; fiveHour: { utilization: number } | null } | null;
          projects: string[];
          unread: unknown[];
          spend: { total: number };
          projectSpend: { project: string; spend: { total: number } }[];
        };
        usagebar: unknown;
      };
      // The project's spend is alpha's loops' alone.
      expect(report.loops).toEqual([expect.objectContaining({ loop: "ralph", costUsd: 1.25 })]);
      expect(report.spend.total).toBe(1.25);
      expect(report.plan).toMatchObject({ status: "allowed" });
      // The plan is the account's: the newest reading across both projects.
      expect(report.account).toEqual({
        scope: "all-projects",
        plan: expect.objectContaining({ project: "beta", status: "allowed_warning", fiveHour: expect.objectContaining({ utilization: 0.8 }) }),
        projects: ["alpha", "beta"],
        unread: [],
        // Spend across every project, beside each project's own share.
        spend: expect.objectContaining({ total: 5.25 }),
        projectSpend: [
          { project: "alpha", spend: expect.objectContaining({ total: 1.25 }) },
          { project: "beta", spend: expect.objectContaining({ total: 4 }) },
        ],
        daily: expect.any(Array),
      });
      // Both projects' runs, merged into the daily series; summed, not by date,
      // so a run just before midnight cannot move the figure.
      const daily = (report.account as unknown as { daily: { models: { costUsd: number | null }[] }[] }).daily;
      expect(daily.flatMap((day) => day.models).reduce((sum, model) => sum + (model.costUsd ?? 0), 0)).toBe(5.25);
      // The machine's UsageBar reading: a failed provider keeps its row.
      expect(report.usagebar).toMatchObject({
        state: "read",
        providers: [
          { provider: "codex", windows: [{ label: "Monthly", usedPercent: 58 }], error: null },
          { provider: "claude", windows: [], error: "rate limited" },
        ],
      });

      const beta = (await (await fetch(`${server.base}/api/p/beta/usage`)).json()) as typeof report;
      expect(beta.spend.total).toBe(4);
      expect(beta.account.plan).toMatchObject({ project: "beta" });
      // Usage reads loop state and logs, never gh, for either project.
      expect(f.githubCalls()).toEqual([]);
    } finally {
      server.stop();
    }
  }, 60_000);
});

describe("request authenticity", () => {
  it("refuses a socket that sends no Host with UnknownHost, before any route", async () => {
    const f = createFixture("http-hostless");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph" });
    f.registry([ralph]);

    const server = await serverFor(f);
    try {
      const { port } = new URL(server.base);
      // A socket that sends no `Host` at all (HTTP/1.0) reaches the gate
      // rather than the dispatcher: Bun hands over a relative url, which
      // `new URL` cannot parse, so before the gate this answered 500 with
      // Bun's dev error page — fifty kilobytes quoting the source and the cwd.
      const hostless = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(port), "127.0.0.1", () => socket.write("GET /api/projects HTTP/1.0\r\n\r\n"));
        let seen = "";
        socket.on("data", (chunk: Buffer) => { seen += chunk.toString(); });
        socket.on("close", () => resolve(seen));
        socket.on("error", reject);
      });
      expect(hostless.split("\r\n")[0]).toContain("403");
      expect(hostless).toContain("UnknownHost");
      // ...and the log says the header was absent rather than empty.
      expect(server.log()).toContain("refused a request with (no Host header)");
    } finally {
      server.stop();
    }
  }, 60_000);
});

describe("the reconcile schedule", () => {
  it("is off, and says so, when RALPH_DASHBOARD_RECONCILE_MS is 0", async () => {
    const f = createFixture("http-reconcile-off");
    const ralph = f.worktree("wt-ralph");
    writeLoopState(ralph, { loop: "ralph" });
    f.registry([ralph]);

    // `startServer` sets the interval to 0 unless a case overrides it.
    const server = await serverFor(f);
    try {
      // Printed after `listening on`, so it may not be in the log yet.
      await vi.waitFor(() => expect(server.log()).toContain("the loop reconciler is off"), { timeout: 10_000, interval: 50 });
    } finally {
      server.stop();
    }
  });
});
