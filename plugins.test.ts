// @vitest-environment node
/**
 * The plugin host: what a plugin is offered, and what it can never do to a loop.
 *
 * The fake plugins here are real processes run by the real host, because the
 * properties that matter are process properties: a plugin that hangs is
 * killed, one that crashes or answers garbage is recorded against itself, and
 * none of them can hold, stop or fail the caller. A mocked spawn could not
 * show any of that.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  PLUGIN_HEALTH_RELATIVE_PATH,
  availablePlugins,
  enabledPlugins,
  eventFromFlags,
  healthLine,
  offer,
  offerEvents,
  parsePluginHealth,
  parsePluginList,
} from "./plugins";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs plugin hooks through bash and bun");

const scratch: string[] = [];
afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Host {
  root: string;
  dir: string;
  env: Record<string, string>;
  /** Write `plugins/<name>/plugin.ts` with this body. */
  plugin: (name: string, body: string) => void;
  /** What the plugin wrote to its marker file, one line per invocation. */
  seen: (name: string) => string[];
  health: () => ReturnType<typeof parsePluginHealth>;
}

function host(label: string): Host {
  const root = mkdtempSync(join(tmpdir(), `ralph-plugins-${label}-`));
  scratch.push(root);
  const dir = join(root, "plugins");
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  mkdirSync(dir);
  return {
    root,
    dir,
    env: { PATH: process.env.PATH ?? "", RALPH_PLUGINS_DIR: dir, RALPH_STATE_ROOT: root, RALPH_RUN_ID: "run-1" },
    plugin: (name, body) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "plugin.ts"), body);
    },
    seen: (name) => {
      const path = join(root, `${name}.seen`);
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
    },
    health: () => {
      const path = join(root, PLUGIN_HEALTH_RELATIVE_PATH);
      return existsSync(path) ? parsePluginHealth(readFileSync(path, "utf8")) : null;
    },
  };
}

/** A plugin that appends `<hook> <stdin>` to `<root>/<name>.seen`, then answers. */
const recording = (name: string, answer = '{"ok":true}', extra = ""): string =>
  [
    'import { appendFileSync, readFileSync } from "node:fs";',
    'const input = readFileSync(0, "utf8");',
    `appendFileSync(process.env.RALPH_STATE_ROOT + "/${name}.seen", process.argv[2] + " " + input.replace(/\\n/g, " ") + "\\n");`,
    extra,
    `console.log('noise a loop must never see');`,
    `console.log(${JSON.stringify(answer)});`,
  ].join("\n");

describe("which plugins are enabled", () => {
  it("is none by default", () => {
    const h = host("default");
    h.plugin("board", recording("board"));
    expect(enabledPlugins(h.root, { RALPH_PLUGINS_DIR: h.dir }).names).toEqual([]);
  });

  it("is what the project turned on", () => {
    const h = host("project");
    h.plugin("board", recording("board"));
    const config = {
      repo: "o/r",
      owner: "o",
      baseBranch: "main",
      displayName: "P",
      secrets: { runner: "none", withhold: [] },
      refuseFiles: [],
      envCheck: [],
      requiredChecks: [],
      gates: {},
      promptFragment: ".ralph/prompt.md",
      coderFragment: ".ralph/coder.md",
      plan: ".ralph/plan.md",
      journal: { dir: "journal" },
      loops: ["ralph"],
      plugins: ["board"],
    };
    writeFileSync(join(h.root, ".ralph", "config.json"), JSON.stringify(config));
    expect(enabledPlugins(h.root, { RALPH_PLUGINS_DIR: h.dir })).toMatchObject({
      names: ["board"],
      source: "project",
    });
    // The per-run override wins, in both directions: an empty one turns the
    // project's plugins off for this run.
    expect(enabledPlugins(h.root, { RALPH_PLUGINS_DIR: h.dir, RALPH_PLUGINS: "" }).names).toEqual([]);
  });

  it("takes a per-run override, and names what it could not find", () => {
    const h = host("override");
    h.plugin("board", recording("board"));
    expect(enabledPlugins(h.root, { RALPH_PLUGINS_DIR: h.dir, RALPH_PLUGINS: "board, ghost" })).toEqual({
      names: ["board"],
      unknown: ["ghost"],
      source: "run",
    });
  });

  it("parses a list the way an operator types one", () => {
    expect(parsePluginList(" a,b  c,,a ")).toEqual(["a", "b", "c"]);
    expect(parsePluginList("none")).toEqual([]);
  });

  it("finds plugins by directory, and only well-named ones", () => {
    const h = host("available");
    h.plugin("board", recording("board"));
    h.plugin("Bad Name", recording("bad"));
    mkdirSync(join(h.dir, "empty"));
    expect(availablePlugins(h.dir)).toEqual(["board"]);
  });
});

describe("offering a hook", () => {
  it("makes no subprocess at all when nothing is enabled", () => {
    const h = host("none");
    h.plugin("board", recording("board"));
    expect(offer(h.root, "on-event", { events: [] }, { env: h.env })).toEqual([]);
    expect(h.seen("board")).toEqual([]);
    expect(h.health()).toBeNull();
  });

  it("hands the payload to every enabled plugin and records it healthy", () => {
    const h = host("ok");
    h.plugin("board", recording("board"));
    const results = offer(h.root, "on-event", { events: [{ name: "iteration-start" }] }, {
      env: { ...h.env, RALPH_PLUGINS: "board" },
    });
    expect(results).toEqual([{ plugin: "board", ran: true, ok: true, why: null }]);
    const seen = h.seen("board");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^on-event /);
    expect(JSON.parse(seen[0]!.slice("on-event ".length))).toMatchObject({
      hook: "on-event",
      events: [{ name: "iteration-start" }],
    });
    expect(h.health()?.plugins.board?.hooks["on-event"]).toMatchObject({ ok: true, why: null });
    expect(h.health()?.plugins.board?.degraded).toBeNull();
  });

  it("kills a plugin that hangs, records it degraded, and backs off from it", () => {
    const h = host("hang");
    h.plugin("slow", recording("slow", '{"ok":true}', "await new Promise((r) => setTimeout(r, 60_000));"));
    const env = { ...h.env, RALPH_PLUGINS: "slow", RALPH_PLUGIN_TIMEOUT_SECONDS: "1" };
    const started = Date.now();
    const [result] = offer(h.root, "on-event", { events: [] }, { env });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ plugin: "slow", ran: true, ok: false });
    expect(result?.why).toMatch(/timed out/);
    const health = h.health()?.plugins.slow;
    expect(health?.degraded?.why).toMatch(/timed out/);
    expect(health?.degraded?.retryAt).not.toBeNull();

    // Inside the back-off it is not run again, so a hung plugin costs one
    // timeout per window rather than one per event.
    const before = h.seen("slow").length;
    expect(offer(h.root, "on-event", { events: [] }, { env })).toEqual([
      { plugin: "slow", ran: false, ok: false, why: expect.stringMatching(/backing off/) },
    ]);
    expect(h.seen("slow")).toHaveLength(before);
  });

  it("still offers the loop's ending to a plugin it is backing off from", () => {
    const h = host("urgent");
    h.plugin("board", recording("board"));
    const env = { ...h.env, RALPH_PLUGINS: "board" };
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      join(h.root, PLUGIN_HEALTH_RELATIVE_PATH),
      JSON.stringify({
        version: 1,
        plugins: {
          board: { hooks: {}, degraded: { hook: "on-event", why: "timed out", at: future, retryAt: future } },
        },
      }),
    );
    expect(offer(h.root, "on-event", { events: [] }, { env })[0]?.ran).toBe(false);
    expect(offer(h.root, "on-event", { events: [] }, { env, urgent: true })[0]).toMatchObject({ ran: true, ok: true });
    // Answering again clears the back-off.
    expect(h.health()?.plugins.board?.degraded).toBeNull();
  });

  it("records a crash and a garbage answer against the plugin, never the caller", () => {
    const h = host("crash");
    h.plugin("crash", 'throw new Error("boom");');
    h.plugin("garbage", 'console.log("{not json");');
    h.plugin("silent", "");
    const env = { ...h.env, RALPH_PLUGINS: "crash garbage silent" };
    const results = offer(h.root, "notify", { alert: {} }, { env });
    expect(results.map((row) => [row.plugin, row.ok])).toEqual([
      ["crash", false],
      ["garbage", false],
      ["silent", false],
    ]);
    expect(results[0]?.why).toMatch(/exited 1/);
    expect(results[1]?.why).toMatch(/not a hook answer/);
    expect(results[2]?.why).toMatch(/not a hook answer/);
    const health = h.health()!;
    for (const name of ["crash", "garbage", "silent"]) {
      expect(health.plugins[name]?.degraded?.hook).toBe("notify");
      // Fast failures cost the loop nothing, so they are not backed off from.
      expect(health.plugins[name]?.degraded?.retryAt).toBeNull();
    }
  });

  it("backs off from a plugin that fails slowly, not only one that times out", () => {
    const h = host("slow-fail");
    h.plugin("sluggish", 'await new Promise((r) => setTimeout(r, 1_500)); console.log(\'{"ok":false,"why":"late and wrong"}\');');
    const env = { ...h.env, RALPH_PLUGINS: "sluggish", RALPH_PLUGIN_SLOW_SECONDS: "1" };
    expect(offer(h.root, "on-event", { events: [] }, { env })[0]).toMatchObject({ ran: true, ok: false });
    expect(h.health()?.plugins.sluggish?.degraded?.retryAt).not.toBeNull();
    expect(offer(h.root, "on-event", { events: [] }, { env })[0]?.ran).toBe(false);
  });

  it("offers a settled control command even to a plugin it is backing off from", () => {
    const h = host("control-urgent");
    h.plugin("board", recording("board"));
    const env = { ...h.env, RALPH_PLUGINS: "board" };
    const future = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(
      join(h.root, PLUGIN_HEALTH_RELATIVE_PATH),
      JSON.stringify({ version: 1, plugins: { board: { hooks: {}, degraded: { hook: "on-event", why: "timed out", at: future, retryAt: future } } } }),
    );
    const event = { name: "control", at: "T", run: "run-1", loop: "ralph", session: null, pid: null };
    expect(offerEvents(h.root, [event], env)[0]?.ran).toBe(false);
    expect(offerEvents(h.root, [{ ...event, control: { command: "stop" } }], env)[0]?.ran).toBe(true);
  });

  it("records a plugin's own degraded answer with its reason", () => {
    const h = host("says");
    h.plugin("board", recording("board", '{"ok":false,"why":"board unreachable"}'));
    const [result] = offer(h.root, "inbox", {}, { env: { ...h.env, RALPH_PLUGINS: "board" } });
    expect(result).toMatchObject({ ok: false, why: "board unreachable" });
    expect(healthLine(h.health(), ["board"])).toContain("board degraded (inbox) — board unreachable");
  });

  it("records a plugin that is enabled but not installed", () => {
    const h = host("ghost");
    const [result] = offer(h.root, "on-event", { events: [] }, { env: { ...h.env, RALPH_PLUGINS: "ghost" } });
    expect(result).toMatchObject({ plugin: "ghost", ran: false, ok: false });
    expect(h.health()?.plugins.ghost?.degraded?.why).toMatch(/not installed/);
  });
});

describe("the CLI a supervisor calls", () => {
  const BUN = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || "bun";
  const cli = (h: Host, args: string[], env: Record<string, string> = {}) =>
    spawnSync(BUN, [join(__dirname, "plugins.ts"), ...args], {
      encoding: "utf8",
      cwd: h.root,
      env: { ...process.env, ...h.env, RALPH_LOOP_NAME: "ralph", ...env },
      timeout: 30_000,
    });

  it("hands a recorded event over, prints nothing, and exits 0 whatever the plugin did", () => {
    const h = host("cli");
    h.plugin("board", recording("board"));
    h.plugin("crash", 'process.exit(7);');
    const ran = cli(h, ["event", "--event", "iteration-start", "--stage", "iteration", "--iteration", "2", "--max", "5"], {
      RALPH_PLUGINS: "board crash",
      RALPH_SESSION_ID: "sess-1",
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("");
    const input = JSON.parse(h.seen("board")[0]!.slice("on-event ".length));
    expect(input.events).toEqual([
      expect.objectContaining({
        name: "iteration-start",
        stage: "iteration",
        iteration: 2,
        max: 5,
        run: "run-1",
        loop: "ralph",
        session: "sess-1",
      }),
    ]);
    expect(h.health()?.plugins.crash?.degraded?.why).toMatch(/exited 7/);
  });

  it("does not hand over an event the durable record refused", () => {
    expect(eventFromFlags(["--event", "x", "--stage", "nonsense"], {}, "ralph")).toBeNull();
    expect(eventFromFlags(["--event", "x", "--stop", "maybe"], {}, "ralph")).toBeNull();
    expect(eventFromFlags(["--stage", "iteration"], {}, "ralph")).toBeNull();
  });

  it("ends a pulse watcher at once when nothing is enabled", () => {
    const h = host("pulse");
    const ran = cli(h, ["pulse", "--watch"], { RALPH_SUPERVISOR_PID: String(process.pid) });
    expect(ran.status).toBe(0);
    expect(ran.signal).toBeNull();
  });

  it("does not pulse for a supervisor that is gone", () => {
    // A pulse cannot prove a loop is alive once its supervisor is gone, so it
    // must not say one is: no pid is the same answer as a dead one.
    const h = host("pulse-dead");
    h.plugin("board", recording("board"));
    for (const pid of ["", String(2 ** 22)]) {
      const ran = cli(h, ["pulse", "--watch"], { RALPH_PLUGINS: "board", RALPH_SUPERVISOR_PID: pid });
      expect(ran.status).toBe(0);
    }
    expect(h.seen("board")).toEqual([]);

    // A live one is pulsed, as an ordinary `on-event`.
    cli(h, ["pulse"], { RALPH_PLUGINS: "board", RALPH_SUPERVISOR_PID: String(process.pid) });
    const pulse = JSON.parse(h.seen("board")[0]!.slice("on-event ".length));
    expect(pulse.events).toEqual([expect.objectContaining({ name: "pulse", run: "run-1", pid: process.pid })]);
  });

  it("says which plugins are on, and how they are", () => {
    const h = host("status");
    h.plugin("board", recording("board"));
    expect(cli(h, ["status", "--line"]).stdout.trim()).toBe("Plugins: none enabled");
    cli(h, ["event", "--event", "supervisor-start"], { RALPH_PLUGINS: "board" });
    expect(cli(h, ["status", "--line"], { RALPH_PLUGINS: "board" }).stdout.split("\n")[0]).toBe("Plugins: board ok");
    // A plugin's own panel lines, under the health line.
    h.plugin("panel", 'if (process.argv[2] === "status") console.log("panel: showing run 7");');
    expect(cli(h, ["status", "--line"], { RALPH_PLUGINS: "panel" }).stdout).toBe("Plugins: panel ok\n  panel: showing run 7\n");
  });
});
