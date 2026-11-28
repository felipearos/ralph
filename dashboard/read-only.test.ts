// @vitest-environment node
/**
 * The read-only guarantee, pinned two ways.
 *
 * First statically: each module's imports are a closed allow-list, the
 * runtime, Jav, intake, project-sleep and learnings-file adapters run only the
 * closed list of declared surfaces (every argv written out, Jav's save, the
 * project's sleep and wake, and filing one learning the only writes), and no
 * mutating ralph verb appears in the adapter's source. Second
 * behaviorally: the HTTP handlers answer non-GET with 405 and never reach the
 * adapter for a method the tool does not serve.
 *
 * This is the regression guard the spec asks for: a later change that smuggles
 * a write path in has to delete or weaken a test to do it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { COMMAND_SURFACE } from "./adapter";
import { AGENT_SURFACE } from "./agents-adapter";
import { coderRoster } from "./contracts";
import type { Clock, RuntimeSnapshot } from "./contracts";
import { CONTROL_SURFACE, DISPATCH_ACTIONS } from "./control-adapter";
import { SIGNAL_SURFACE } from "./interrupt-adapter";
import {
  ASK_MODE,
  ASK_UNSANDBOXED,
  ASK_WRITE_FLAGS,
  askSettings,
  CHAT_COMMAND,
  CHAT_DRAFT,
  CHAT_READ_DENY,
  chatTmpDir,
  commandArgs,
  EXECUTOR_ENV,
  EXECUTOR_SETTINGS,
  executorDenies,
  executorReadDenies,
  fixSettings,
  gitDirsOf,
  modeArgs,
  SANDBOX,
  sandboxEnv,
  SHELL_READERS,
  toolRootsOf,
  type SandboxRoots,
} from "./chat";
import { REDACT_COMMAND } from "./iteration-output";
import { INTAKE_SURFACE } from "./intake-adapter";
import { JAV_SURFACE } from "./jav-adapter";
import { PROJECT_SLEEP_FLAGS, PROJECT_SLEEP_SURFACE } from "./project-sleep-adapter";
import { CLAUDE_ACCOUNTS_SURFACE } from "./claude-accounts-adapter";
import { LEARNINGS_FILE_FLAGS, LEARNINGS_FILE_SURFACE } from "./learnings-file-adapter";
import { ONBOARDING_SURFACE } from "./onboarding-adapter";
import { RECORDS_SURFACE } from "./records-adapter";
import { USAGEBAR_SURFACE } from "./usagebar-adapter";
import { createReconcileAdapter, RECONCILE_SURFACE } from "./reconcile";
import { NOTIFICATION_KINDS } from "../push-notification";
import { createHandbackAdapter, HANDBACK_SURFACE, PUBLISH_ENV } from "./chat-handback-adapter";
import { createRecordingExecutor } from "./recording-executor";
import { RELAY_ROUTES } from "./remote/relay";
import { LOCAL_ONLY_ROUTES, ROUTE_TABLE, SNAPSHOT_ROUTES } from "./route-table";
import { COMMAND_ROUTES } from "./ui/command-model";
import { createHandler } from "./server";

const HERE = __dirname;
const source = (name: string): string => readFileSync(join(HERE, name), "utf8");

/**
 * Static `from "x"`, bare `import "x"`, dynamic `import("x")` and `require("x")`
 * alike: all cross the boundary, and Bun's types let `require` typecheck.
 */
const IMPORTS = /(?:from\s+|\bimport\s*\(?|\brequire\s*\()\s*["']([^"']+)["']/g;
const importsOf = (text: string): string[] =>
  [...text.matchAll(IMPORTS)].map((match) => match[1]!);

/** The one import set each file is allowed, and nothing outside it. */
const ALLOWED: Record<string, string[]> = {
  "contracts.ts": [],
  // The command body parsers: the remote function imports them too, so they reach nothing but the contracts.
  "command-requests.ts": ["./contracts"],
  // The route index: the remote function imports it and the UI's browser bundle will, so it reaches only the contracts and the parser leaf.
  "route-table.ts": ["./command-requests", "./contracts"],
  "aggregate.ts": ["./contracts"],
  // `./ci-health` is the ci-doctor's store, read off the checkout's own `.git`
  // with `node:fs` alone — no subprocess, no ralph module. Its own entry below
  // pins that.
  "adapter.ts": ["node:fs", "node:path", "./ci-health", "./cli-read", "./contracts", "./executor", "./learnings"],
  // The CLI read module: it spawns nothing itself, only through the executor
  // port it is handed (and `guarded` from it).
  "cli-read.ts": ["node:path", "./contracts", "./executor"],
  // The executor port: the one module that spawns for the adapters.
  "executor.ts": ["node:child_process", "./contracts"],
  // `../learnings` is the learnings file format, parsed by the same leaf the
  // loop's reader and the journal publisher use — so the dashboard can never
  // disagree with them about what an open entry is. That module imports
  // NOTHING, so there is no loop code behind it and no state; the git reads
  // stay in the adapter, where the command surface is pinned.
  "learnings.ts": ["../learnings", "./contracts"],
  // Usage tails logs in a dedicated read-only worker, never a subprocess.
  "usage.ts": ["node:fs", "node:path", "node:worker_threads", "./contracts"],
  "usage-worker.ts": ["node:worker_threads", "./usage"],
  // UsageBar's reading: one read-only argv (`USAGEBAR_SURFACE`) over the executor port.
  "usagebar-adapter.ts": ["./contracts", "./executor"],
  // Its last good reading, kept in the operator's cache directory so a restart
  // during a Claude rate-limit cooldown still shows the bars. It writes that
  // one file and reaches no ralph module.
  "usagebar-memory.ts": ["node:fs", "node:os", "node:path", "./contracts"],
  "config.ts": ["node:path", "./contracts"],
  // The write-side sibling: it owns the control inbox and the durable records
  // dispatch reads, and can still reach no ralph TypeScript module.
  "control-adapter.ts": ["node:fs", "node:path", "./adapter", "./command-requests", "./contracts", "./executor"],
  "dispatch.ts": ["node:crypto", "./command-requests", "./contracts", "./control-adapter"],
  // `../paths` only resolves the harness and project directories; it runs no
  // loop code and holds no state, so it does not cross the process boundary.
  // `./build` bundles the React shell in memory; it runs no loop code either.
  // The two `../lineup/*` imports build the lineup editor's adapter, whose own
  // boundary test pins that it reaches `models.ts` by CLI and never a loop.
  "server.ts": [
    "../lineup/adapter",
    "../lineup/config",
    "../paths",
    "./adapter",
    "./agents",
    "./agents-routes",
    "./aggregate",
    "./build",
    "./chat",
    "./chat-routes",
    "./compose",
    "./compression",
    "./config",
    "./contracts",
    "./control-adapter",
    "./control-routes",
    "./control-view",
    "./doctor-routes",
    "./evals-adapter",
    "./evals-routes",
    "./gate-run",
    "./health",
    "./intake-adapter",
    "./intake-routes",
    "./iteration-output",
    "./jav-adapter",
    "./jav-routes",
    "./learnings-file-adapter",
    "./learnings-file-routes",
    "./lifecycle-routes",
    "./onboarding",
    "./onboarding-routes",
    "./project-sleep-adapter",
    "./project-sleep-routes",
    "./claude-accounts-adapter",
    "./claude-accounts-routes",
    "./projects",
    "./records-routes",
    "./reconcile",
    "./route-table",
    "./routes",
    "./snapshot-stream",
    "./usage",
  ],
  // The server's composition (#624): the wiring `main()` hands its real
  // dependencies to. It imports the adapter factories `server.ts` did, and
  // the executor port for its type alone: executors arrive as a dependency.
  "compose.ts": [
    "../lineup/server",
    "./adapter",
    "./agents",
    "./agents-adapter",
    "./build",
    "./chat",
    "./chat-handback-adapter",
    "./chat-routes",
    "./config",
    "./control-adapter",
    "./control-routes",
    "./control-view",
    "./doctor-adapter",
    "./doctor-routes",
    "./evals-adapter",
    "./gate-run",
    "./executor",
    "./health",
    "./intake-adapter",
    "./interrupt-adapter",
    "./iteration-output",
    "./jav-adapter",
    "./learnings-file-adapter",
    "./lifecycle-adapter",
    "./lifecycle-routes",
    "./onboarding",
    "./onboarding-adapter",
    "./project-sleep-adapter",
    "./claude-accounts-adapter",
    "./projects",
    "./records-adapter",
    "./reconcile",
    "./server",
    "./usage",
    "./usagebar-adapter",
    "./usagebar-memory",
  ],
  // The route shapes the remote Vercel function shares with the server. It
  // must import nothing, or the function bundle would reach this graph.
  "routes.ts": [],
  // The project registry: the one module that writes `projects.json`. It reads
  // a checkout's `.git` for the project's id and runs no subprocess. The id
  // rule is the harness's `../project-id` (fs/path only, no loop code), so a
  // loop and the registry agree on what a project is called.
  "projects.ts": ["node:fs", "node:path", "../project-id", "./contracts"],
  // The shell build. `writeShell` writes the bundle into the directory it is
  // given, the remote dashboard's static output; the server only ever calls
  // the in-memory `buildShell`. Vite builds it with the config next door.
  "build.ts": ["node:fs/promises", "node:path", "vite", "./vite-config"],
  // Response compression (#69): node's zlib and nothing else, no loop state.
  "compression.ts": ["node:util", "node:zlib"],
  // That Vite config: the UI root, its plugins and the `@/` alias, nothing of ralph's.
  "vite-config.ts": ["node:url", "@tailwindcss/vite", "@vitejs/plugin-react", "vite"],
  // The ci-doctor's CI health: one JSON cache read off the checkout's own
  // `.git`, and the project config for the retry cap it is read against. It
  // resolves the git common directory by reading `.git` rather than by
  // spawning `git rev-parse`, which is the whole reason it is not
  // `ci-doctor/store.ts`'s own reader.
  "ci-health.ts": ["node:fs", "node:path", "./contracts"],
  // Project health: a pure fold over reads it is handed (the adapter's local
  // read and `controls status`). No subprocess, no filesystem, no `gh`.
  "health.ts": ["./contracts", "./control-adapter"],
  // The live pane: it reads iteration logs and runs the harness's redactor as
  // a filter, and reaches no ralph module by import.
  "iteration-output.ts": ["node:child_process", "node:fs", "node:path", "./contracts"],
  // The snapshot change stream (#724): it watches loop directories, reads the
  // git common dir through the adapter's file reader, and hashes as the bridge does.
  "snapshot-stream.ts": ["node:fs", "node:path", "./adapter", "./remote/collect"],
  // The unblocker chat (#251): it resolves a session out of a loop's own logs
  // and runs two processes, `claude` in the loop's checkout and the live
  // pane's own redactor — which is why `./iteration-output` is here rather
  // than a second copy of the filter's argv. It reaches no ralph module.
  "chat.ts": ["node:child_process", "node:crypto", "node:fs", "node:path", "./chat-seed", "./iteration-output"],
  "chat-routes.ts": ["./command-requests", "./contracts", "./chat", "./chat-fix", "./chat-handback", "./chat-handback-adapter", "./chat-seed", "./control-routes"],
  // Unblock & resume (#255): the sequence over the lifecycle module the Start
  // and Resume work buttons use, and the one module naming its `gh` writes,
  // the journal publisher and the draft it hands that publisher.
  "chat-handback.ts": ["./contracts", "./chat", "./chat-handback-adapter", "./lifecycle", "./lifecycle-adapter"],
  "chat-handback-adapter.ts": ["node:fs", "node:path", "./adapter", "./contracts", "./control-adapter"],
  // Fix's gate and Stop & fix (#254): the lifecycle routes' liveness read and
  // dispatch's ordinary stop, and nothing of its own — no subprocess, no
  // file, no signal.
  "chat-fix.ts": ["./contracts", "./control-adapter", "./dispatch", "./lifecycle"],
  // The first turn's evidence (#253): text in, text out. It reads nothing —
  // the log tail comes through `iteration-output.ts` and the rest off the
  // dashboard's own snapshot — and redacts nothing; `chat.ts` does that.
  "chat-seed.ts": ["./contracts"],
  // The control view reads the record through the control adapter and builds
  // nothing itself: no subprocess, no filesystem, no ralph module.
  "control-view.ts": ["./aggregate", "./contracts", "./control-adapter"],
  // The HTTP write route: request validation over dispatch, nothing more.
  "control-routes.ts": ["./command-requests", "./contracts", "./control-adapter", "./dispatch"],
  // The plugin doctor: one harness script run for a loop's checkout, and its
  // route. Neither reaches a plugin but through that script.
  "doctor-adapter.ts": ["node:path", "./adapter", "./contracts", "./control-adapter"],
  "doctor-routes.ts": ["./command-requests", "./contracts", "./control-routes", "./doctor-adapter"],
  // Jav: reaches `jav.ts` by CLI only, and its route is a thin shell over that.
  "jav-adapter.ts": ["node:path", "./cli-read", "./contracts", "./executor"],
  "jav-routes.ts": ["./jav-adapter"],
  // The intake page (#459): reaches `clerk-intake.ts` by CLI only, two
  // read-only argv shapes, and its route is GET over that and nothing else.
  "intake-adapter.ts": ["./cli-read", "./contracts", "./executor"],
  "intake-routes.ts": ["./contracts", "./intake-adapter"],
  // The project's sleep: reaches `project-sleep.ts` by CLI only, three verbs,
  // and its route validates a body and calls one of them.
  "project-sleep-adapter.ts": ["node:path", "./adapter", "./contracts", "./executor"],
  "project-sleep-routes.ts": ["./command-requests", "./contracts", "./project-sleep-adapter"],
  // The host's Claude accounts: reaches `claude-account.ts` by CLI only, one
  // read and five writes, and its route validates a body and calls one.
  "claude-accounts-adapter.ts": ["node:path", "./adapter", "./contracts", "./executor"],
  "claude-accounts-routes.ts": ["./claude-accounts-adapter", "./command-requests", "./contracts"],
  // Filing one learning as a ticket: reaches `findings.ts file` by CLI only,
  // which publishes through the journal lock; its route validates a slug.
  "learnings-file-adapter.ts": ["node:path", "./adapter", "./contracts", "./executor"],
  "learnings-file-routes.ts": ["./command-requests", "./contracts", "./learnings-file-adapter"],
  "evals-adapter.ts": ["node:path", "./adapter", "./contracts", "./executor"],
  "evals-routes.ts": ["./command-requests", "./contracts", "./evals-adapter"],
  // The start/restart routes: request validation over lifecycle dispatch.
  "lifecycle-routes.ts": ["./command-requests", "./contracts", "./control-routes", "./interrupt", "./lifecycle"],
  // Stop now: the sequence over an injected adapter, and the one module that
  // may signal a process. Neither reaches a ralph module by import.
  "interrupt.ts": ["node:crypto", "./command-requests", "./contracts", "./control-adapter", "./interrupt-adapter"],
  "interrupt-adapter.ts": ["node:fs", "node:path", "./contracts"],
  // The notification feed and audit history: a pure projection, the one
  // module that names their files (reads, and the feed's read mark), and the
  // routes over them. No subprocess and no ralph module.
  "records.ts": ["./contracts"],
  "records-adapter.ts": ["node:fs", "node:path", "./records"],
  "records-routes.ts": ["./command-requests", "./contracts", "./control-routes", "./records-adapter", "./records"],
  // The loop reconciler (#346): it restarts a loop whose supervisor died
  // without an ending, through the very modules the Start button uses —
  // `./agents`'s gate into `./lifecycle`'s start — and reads the bound back
  // out of `./records-adapter`'s feed. `./adapter` is there for
  // `defaultBunPath` alone. It names `push-notification.ts push` and, for the
  // migration watchdog (#434), two read-only `gh` reads, all through an
  // injected executor, so it needs no
  // `node:child_process` and touches no file itself.
  "reconcile.ts": [
    "./adapter",
    "./agents",
    "./contracts",
    "./control-adapter",
    "./lifecycle",
    "./lifecycle-adapter",
    "./records",
    "./records-adapter",
  ],
  // Onboarding: the one module naming the git and gh commands that add and set
  // up a project, the sequences over it, and their routes. None reaches a ralph
  // module by import; `project-config` is run as a CLI.
  "onboarding-adapter.ts": ["node:path", "./adapter", "./contracts", "./control-adapter"],
  "onboarding.ts": ["node:fs", "node:os", "node:path", "./adapter", "./contracts", "./onboarding-adapter", "./projects"],
  "onboarding-routes.ts": ["./command-requests", "./contracts", "./onboarding"],
  // Agents: the one module that names worktree add/remove, the roster commit
  // and `gh pr`, the sequence over it, and the routes. None imports a ralph
  // module; the roster rules are reached through `project-config` by CLI.
  // `./gate-run` runs a new worktree's setup steps (#694) under the same
  // group-kill time limit the Settings page's gate runs use.
  "agents-adapter.ts": ["node:fs", "node:os", "node:path", "./adapter", "./contracts", "./control-adapter", "./gate-run", "./lifecycle-adapter"],
  "agents.ts": ["node:crypto", "./contracts", "./control-adapter", "./agents-adapter", "./lifecycle"],
  // The Settings overview: built over the agents adapter alone, like `agents.ts`.
  "settings.ts": ["./agents", "./agents-adapter", "./contracts"],
  // The Settings Prompts section (#695): its fragment reads and renders go through the adapter too.
  "settings-prompts.ts": ["./agents", "./contracts"],
  // Clean up worktrees (#696): built over the agents adapter alone, like `settings.ts`.
  "worktree-cleanup.ts": ["./agents", "./agents-adapter", "./contracts"],
  "agents-routes.ts": ["./command-requests", "./contracts", "./agents", "./lifecycle-routes", "./settings", "./settings-prompts", "./gate-run", "./worktree-cleanup"],
  // The Settings page's Run (#690): it spawns the project's own gate command,
  // read from its config, and signals only the process group it spawned.
  "gate-run.ts": ["node:child_process", "./contracts"],
  // The remote bridge (#171) and the modules it is built from. It is a client
  // of the running dashboard over loopback, so it imports no dashboard adapter
  // and no ralph module: `../contracts` (constants and types, importing
  // nothing) and `../route-table` (its snapshot and relay lists, reaching only
  // `./contracts` and the parser leaf, pinned above) are its reach outside
  // `remote/`. `bun:ffi` is `flock(2)`, so
  // the single-instance lock spawns nothing; its block below pins the rest.
  // The command relay (#173) takes the bridge's store type and nothing else.
  "remote/collect.ts": ["node:crypto", "node:zlib", "../route-table", "./scrub"],
  "remote/relay.ts": ["../contracts", "../route-table", "./bridge", "./wake"],
  // The bridge's client of the local change stream (#730): the table's stream
  // row and collect.ts's scoping, and nothing else.
  "remote/local-stream.ts": ["../route-table", "./collect"],
  "remote/scrub.ts": ["node:child_process", "node:os", "node:path", "node:url"],
  "remote/wake.ts": ["@supabase/supabase-js"],
  "remote/bridge.ts": [
    "node:crypto",
    "node:fs",
    "node:os",
    "node:path",
    "node:zlib",
    "postgres",
    "bun:ffi",
    "../contracts",
    "./collect",
    "./local-stream",
    "./relay",
    "./scrub",
    "./wake",
  ],
};

describe("the GUI imports no ralph TypeScript", () => {
  it.each(Object.entries(ALLOWED))("keeps %s inside its allow-list", (file, allowed) => {
    for (const specifier of importsOf(source(file))) {
      expect(allowed).toContain(specifier);
    }
  });

  it("pins that the leaf the learnings panel reaches across for really imports nothing", () => {
    // `learnings.ts` is allow-listed above on the stated ground that it imports
    // NOTHING, so no loop code and no state sits behind it. The allow-list
    // cannot check that — `../learnings` is outside `dashboard/` and does not
    // match the `ralph/` grep below — so one `import … from "./paths"` added to
    // it later would hand the dashboard the whole harness module graph with
    // this file still green. Every other reach-across here is pinned by a
    // positive assertion; this is that assertion.
    expect(importsOf(readFileSync(join(HERE, "..", "learnings.ts"), "utf8"))).toEqual([]);
  });

  it("does not cross the process boundary by import", () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(source(file)).not.toMatch(/from\s+["'][^"']*ralph\//);
    }
  });
});

describe("the remote bridge's surface", () => {
  /** A file's code with its comments dropped: prose may name a route, code may not. */
  const code = (file: string): string => source(file).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const REMOTE = ["remote/bridge.ts", "remote/collect.ts", "remote/local-stream.ts", "remote/scrub.ts", "remote/wake.ts"];
  /**
   * Spec #165 §3's local-only routes, which no remote path may reach: one
   * regex per distinct local-only path in the route table, so the fence grows
   * with the table. Each matches its path exactly (no further segment or word
   * character after it), so `/api/agents` (POST is local-only) does not match
   * the relayed `/api/agents/start`. The pin below keeps the derived fence
   * from silently shrinking.
   */
  const LOCAL_ONLY = [...new Set(LOCAL_ONLY_ROUTES.map((entry) => entry.path))].map(
    (path) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`),
  );

  // Spec #165 §3 by name: each of these is refused remotely or relayed, on
  // every method its path answers. Deriving LOCAL_ONLY from the table means a
  // row moved to a snapshot would quietly drop out of the fence; this is the
  // list it may not drop below.
  it("keeps every spec-named local-only path local-only or relayed in the route table", () => {
    // `/api/setup/*` by name, so dropping one of its rows fails here too; and
    // any further row under it must be local-only as well.
    const setup = ["/api/setup/defaults", "/api/setup/validate", "/api/setup/tracker/test", "/api/setup/tracker/save"];
    for (const path of new Set(ROUTE_TABLE.map((entry) => entry.path).filter((path) => path.startsWith("/api/setup/")))) {
      expect(setup, `${path} is pinned`).toContain(path);
    }
    const pinned = [
      "/api/projects/remove",
      ...setup,
      "/api/agents/delete",
      "/api/agents/start",
      "/api/agents/checkout",
      "/api/settings/worktrees/cleanup",
      "/api/agents/verifier",
      "/api/agents/sentinel",
      "/api/doctor",
      "/api/lineup/catalog",
      "/api/lineup/preview",
      "/api/lineup/edit",
      "/api/lineup/save",
      "/api/lineup/updates",
      "/api/lineup/updates/answer",
      "/api/jav/save",
      "/api/sleep",
      "/api/claude-accounts",
      "/api/github/repos",
    ];
    for (const path of pinned) {
      const rows = ROUTE_TABLE.filter((entry) => entry.path === path);
      expect(rows.length, `${path} is in the route table`).toBeGreaterThan(0);
      for (const entry of rows) expect(["local-only", "command"], `${entry.method} ${path}`).toContain(entry.kind);
    }
  });

  it("derives bridge lists that never reach a local-only row", () => {
    const localGets = new Set(LOCAL_ONLY_ROUTES.filter((entry) => entry.method === "GET").map((entry) => entry.path));
    const localPosts = new Set(LOCAL_ONLY_ROUTES.filter((entry) => entry.method === "POST").map((entry) => entry.path));
    for (const route of SNAPSHOT_ROUTES) expect(localGets.has(route.path.split("?")[0]!), route.key).toBe(false);
    // The old hand-written fence also refused anything under these: keep that,
    // so a new snapshot row there is a decision, not an accident.
    const SENSITIVE = /^\/api\/(setup\/|github\/|doctor|jav\/|sleep|lineup\/|projects\/remove|agents\/(delete|start|checkout|verifier|sentinel))/;
    for (const route of SNAPSHOT_ROUTES) expect(route.path, route.key).not.toMatch(SENSITIVE);
    for (const [kind, path] of Object.entries(RELAY_ROUTES)) expect(localPosts.has(path), kind).toBe(false);
  });

  it("reaches the local server only through collect.ts's SNAPSHOT_ROUTES or the table's stream row, by GET", () => {
    // The bridge names no route of its own: every local read is a collect call.
    expect(code("remote/bridge.ts")).not.toMatch(/["'`]\/api\//);
    expect(code("remote/bridge.ts")).toMatch(/SNAPSHOT_ROUTES/);
    expect(code("remote/bridge.ts")).not.toMatch(/\bfetch\(/);
    // And the collector reads by GET and nothing else.
    expect(code("remote/collect.ts")).toMatch(/method: "GET"/);
    // And it names no path of its own: its routes are the table's (#629). Only
    // the scoped `/api/p/` prefix and the `"/api"` it slices off remain.
    const paths = code("remote/collect.ts").match(/["'`]\/api[^"'`$]*/g) ?? [];
    expect([...new Set(paths.map((path) => path.slice(1)))].sort()).toEqual(["/api", "/api/p/"]);
    for (const file of REMOTE) expect(code(file), file).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/);
    // The change-stream client (#730) reads by GET too, and names no path at
    // all: its one route is the table's stream row, scoped by collect.ts.
    expect(code("remote/local-stream.ts")).toMatch(/method: "GET"/);
    expect(code("remote/local-stream.ts")).not.toMatch(/["'`]\/api/);
    expect(code("remote/local-stream.ts")).toMatch(/entry\.kind === "stream"/);
  });

  it("never names a local-only route", () => {
    for (const file of REMOTE) {
      for (const pattern of LOCAL_ONLY) expect(code(file), `${file} names ${pattern}`).not.toMatch(pattern);
    }
  });

  it("spawns nothing but the redactor", () => {
    for (const file of ["remote/bridge.ts", "remote/collect.ts", "remote/local-stream.ts", "remote/wake.ts"]) {
      expect(importsOf(source(file)), file).not.toContain("node:child_process");
      expect(code(file), file).not.toMatch(/Bun\.(spawn|spawnSync|\$)|\bexec(File)?(Sync)?\(/);
    }
    // The one spawn on the bridge's side is `processRedactor`'s `bun runner-failure.ts redact`.
    const scrub = code("remote/scrub.ts");
    expect(scrub.match(/\bspawn\(/g)).toHaveLength(1);
    expect(scrub).toMatch(/const REDACT_SCRIPT = "runner-failure\.ts";/);
    expect(scrub).toMatch(/const REDACT_ARGS = \["redact"\] as const;/);
  });

  it("imports no ralph module and no dashboard adapter", () => {
    for (const file of REMOTE) {
      for (const specifier of importsOf(source(file))) {
        if (!specifier.startsWith(".")) continue;
        // Its own siblings, and the dependency-free contracts module; nothing else on disk.
        expect(["./collect", "./local-stream", "./relay", "./scrub", "./wake", "../contracts", "../route-table"], `${file} imports ${specifier}`).toContain(specifier);
      }
    }
    expect(importsOf(source("contracts.ts"))).toEqual([]);
  });

  // The page follows a relay only on the routes its command table marks as
  // relayed, so that set and the bridge's map must be the same list (spec #607).
  // It lives here, not beside the model: the UI's tsconfig carries no node
  // types, and the bridge module behind RELAY_ROUTES needs them.
  it("relays from the page exactly the routes the bridge relays", () => {
    const relayed = Object.values(COMMAND_ROUTES).filter((route) => route.remote === "relay").map((route) => route.path);
    expect(new Set(relayed)).toEqual(new Set(Object.values(RELAY_ROUTES)));
  });

  // The command relay is the bridge's one POST surface, and its kind-to-route
  // map is the whole of it (spec §5 "Execute"). The map is the route table's
  // command rows, so relay.ts names none of their paths itself; Add agent's
  // start is a command row, not a local-only one, so the fence needs no
  // exception for it.
  it("POSTs only through the relay's closed kind-to-route map", () => {
    expect(RELAY_ROUTES).toEqual({
      control: "/api/control",
      start: "/api/start",
      restart: "/api/restart",
      "stop-now": "/api/stop-now",
      "resume-work": "/api/resume-work",
      "agent-start": "/api/agents/start",
      "mark-read": "/api/notifications/read",
      "eval-start": "/api/evals/start",
      "eval-stop": "/api/evals/stop",
      "eval-set-add": "/api/evals/set/add",
      "eval-set-edit": "/api/evals/set/edit",
      "eval-set-retire": "/api/evals/set/retire",
      "eval-set-check": "/api/evals/set/check",
      "eval-set-keep": "/api/evals/set/keep",
      "eval-inbox-add": "/api/evals/inbox/add",
      "eval-inbox-start": "/api/evals/inbox/start",
      "eval-inbox-dismiss": "/api/evals/inbox/dismiss",
      "eval-improve-propose": "/api/evals/improve/propose",
      "eval-set-calibrate": "/api/evals/set/calibrate",
      "eval-proposal-open-pr": "/api/evals/proposals/open-pr",
    });
    const relay = code("remote/relay.ts");
    // One request with a method of its own, and it is the map's POST; the History read is a GET.
    expect(relay.match(/\bmethod:/g)).toHaveLength(2);
    expect(relay.match(/method: "POST"/g)).toHaveLength(1);
    expect(relay.match(/method: "GET"/g)).toHaveLength(1);
    expect(relay).toMatch(/fetchLocal\(scoped\(row\.project, RELAY_ROUTES\[row\.kind\]\), \{\s*method: "POST"/);
    expect(relay.match(/\bfetchLocal\(/g)).toHaveLength(2);
    expect(relay).not.toMatch(/["'](PUT|PATCH|DELETE)["']/);
    // Every route it names: the scoped prefix and the History read.
    const named = new Set(relay.match(/\/api[^"'`$]*/g));
    expect([...named].sort()).toEqual(["/api", "/api/p/", "/api/loops/"].sort());
    expect(relay).toMatch(/`\/api\/loops\/\$\{encodeURIComponent\(loopOf\(row\.body\)\)\}\/history`/);
    for (const pattern of LOCAL_ONLY) expect(relay, `relay names ${pattern}`).not.toMatch(pattern);
    // And it spawns nothing.
    expect(importsOf(source("remote/relay.ts"))).not.toContain("node:child_process");
    expect(relay).not.toMatch(/Bun\.(spawn|spawnSync|\$)|\bexec(File)?(Sync)?\(|\bspawn\(/);
  });
});

describe("the intake page's surface (#459)", () => {
  it("is two read-only argv shapes of clerk-intake.ts, served by GET alone", () => {
    expect(INTAKE_SURFACE).toEqual({
      tickets: { script: "clerk-intake.ts", args: ["--json"] },
      metrics: { script: "clerk-intake.ts", args: ["--metrics", "--json"] },
    });
    // Whether it can spawn is the import check in "spawns nothing itself"
    // below; this pins that it writes no file of its own.
    expect(source("intake-adapter.ts")).not.toMatch(/writeFile|appendFile/);
    expect(source("intake-routes.ts")).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/);
  });
});

describe("the declared read surfaces are a closed list", () => {
  type Argv = { script?: string; command?: string; args: readonly string[] };
  // Every argv the runtime, Jav, intake, UsageBar and sleep adapters may run, by name. The
  // guarantee is this list: a surface added to any of the three constants
  // fails the names check first, and the diff names it.
  const declared: Record<string, Argv> = Object.fromEntries([
    ...Object.entries(COMMAND_SURFACE).map(([key, value]) => [`runtime.${key}`, value] as const),
    ...Object.entries(JAV_SURFACE).map(([key, value]) => [`jav.${key}`, value] as const),
    ...Object.entries(INTAKE_SURFACE).map(([key, value]) => [`intake.${key}`, value] as const),
    ...Object.entries(USAGEBAR_SURFACE).map(([key, value]) => [`usagebar.${key}`, value] as const),
    ...Object.entries(PROJECT_SLEEP_SURFACE).map(([key, value]) => [`sleep.${key}`, value] as const),
    ...Object.entries(LEARNINGS_FILE_SURFACE).map(([key, value]) => [`findings.${key}`, value] as const),
    ...Object.entries(CLAUDE_ACCOUNTS_SURFACE).map(([key, value]) => [`accounts.${key}`, value] as const),
  ]);
  const argvOf = ({ script, command, args }: Argv): Argv =>
    script === undefined ? { command, args: [...args] } : { script, args: [...args] };
  // The Jav page's one write: it saves the operator's edited config. It is
  // declared beside the reads so the list stays closed. The project's sleep
  // and wake are the other two: each sets or clears the one sleep marker
  // through `project-sleep.ts`, and touches nothing else. Filing a learning is
  // the last: one named entry through `findings.ts file`, which publishes it.
  // The Claude accounts' five writes edit the host's account registry, an
  // account's limit mark or the project's override, each through one verb of
  // `claude-account.ts`.
  const WRITES = ["jav.save", "sleep.sleep", "sleep.wake", "findings.file", "accounts.add", "accounts.remove", "accounts.clear", "accounts.assign", "accounts.unassign"];

  it("names exactly these surfaces", () => {
    expect(Object.keys(declared).sort()).toEqual([
      "accounts.add",
      "accounts.assign",
      "accounts.clear",
      "accounts.remove",
      "accounts.unassign",
      "accounts.view",
      "findings.file",
      "intake.metrics",
      "intake.tickets",
      "jav.read",
      "jav.save",
      "runtime.claims",
      "runtime.following",
      "runtime.frontier",
      "runtime.github",
      "runtime.journalList",
      "runtime.journalRead",
      "runtime.learningsRemote",
      "runtime.learningsShow",
      "runtime.loopState",
      "runtime.observe",
      "runtime.projectConfig",
      "runtime.pullsMerged",
      "runtime.pullsOpen",
      "runtime.runnerFailure",
      "runtime.timeline",
      "runtime.trackerIssues",
      "runtime.usage",
      "sleep.sleep",
      "sleep.status",
      "sleep.wake",
      "usagebar.cost",
      "usagebar.usage",
    ]);
  });

  it("pins every argv, written out rather than derived from the constants", () => {
    const argv = Object.fromEntries(Object.entries(declared).map(([name, value]) => [name, argvOf(value)]));
    expect(argv).toEqual({
      "runtime.loopState": { script: "loop-state.ts", args: ["status", "--json"] },
      "runtime.observe": { script: "observe.ts", args: ["--json"] },
      "runtime.claims": { script: "claim-lease.ts", args: ["status", "--json"] },
      "runtime.github": {
        command: "gh",
        args: ["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,labels"],
      },
      "runtime.trackerIssues": { script: "tracker.ts", args: ["list", "--json", "--limit", "1000"] },
      "runtime.pullsOpen": {
        command: "gh",
        args: ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,isDraft,closingIssuesReferences,statusCheckRollup"],
      },
      "runtime.pullsMerged": {
        command: "gh",
        args: ["pr", "list", "--state", "merged", "--limit", "300", "--json", "number,closingIssuesReferences,mergedAt"],
      },
      "runtime.projectConfig": { script: "project-config.ts", args: ["--json"] },
      "runtime.usage": { script: "usage.py", args: ["--json", "--no-record"] },
      "runtime.journalList": { command: "git", args: ["ls-tree", "--name-only"] },
      "runtime.journalRead": { command: "git", args: ["cat-file", "--batch"] },
      "runtime.learningsShow": { command: "git", args: ["show"] },
      "runtime.learningsRemote": { command: "git", args: ["remote", "get-url", "origin"] },
      "runtime.timeline": { script: "timeline.ts", args: ["--json"] },
      "runtime.runnerFailure": { script: "runner-failure.ts", args: ["status", "--json"] },
      "runtime.frontier": { script: join("frontier", "next-tasks.ts"), args: ["--dry-run", "--json"] },
      "runtime.following": { script: join("verifier", "following.ts"), args: ["--json"] },
      "jav.read": { script: "jav.ts", args: ["--json"] },
      // The one write, pinned to its flag so it cannot grow a second verb.
      "jav.save": { script: "jav.ts", args: ["--save"] },
      "intake.tickets": { script: "clerk-intake.ts", args: ["--json"] },
      "intake.metrics": { script: "clerk-intake.ts", args: ["--metrics", "--json"] },
      "usagebar.usage": { command: "codexbar", args: ["usage", "--format", "json"] },
      "usagebar.cost": { command: "codexbar", args: ["cost", "--format", "json", "--days", "90"] },
      "sleep.status": { script: "project-sleep.ts", args: ["status", "--json"] },
      // The two writes, each one verb; a sleep adds only `--why` and `--by dashboard`.
      "sleep.sleep": { script: "project-sleep.ts", args: ["sleep", "--json"] },
      "sleep.wake": { script: "project-sleep.ts", args: ["wake", "--json"] },
      // One entry by slug; the adapter adds only `<slug> --scope <scope>`.
      "findings.file": { script: "findings.ts", args: ["file"] },
      "accounts.view": { script: "claude-account.ts", args: ["view", "--json"] },
      "accounts.add": { script: "claude-account.ts", args: ["add"] },
      "accounts.remove": { script: "claude-account.ts", args: ["remove"] },
      "accounts.clear": { script: "claude-account.ts", args: ["clear"] },
      "accounts.assign": { script: "claude-account.ts", args: ["assign"] },
      "accounts.unassign": { script: "claude-account.ts", args: ["unassign"] },
    });
    expect(PROJECT_SLEEP_FLAGS).toEqual({ why: "--why", by: "--by", byPage: "dashboard" });
    expect(LEARNINGS_FILE_FLAGS).toEqual({ scope: "--scope" });
  });

  it("keeps the Jav save, the sleep, the wake and filing a learning the only entries outside the read set", () => {
    const writes = Object.keys(declared).filter(
      (name) =>
        declared[name]!.args.includes("--save") ||
        ["sleep", "wake", "file", "add", "remove", "clear", "assign", "unassign"].includes(declared[name]!.args[0]!),
    );
    expect(writes).toEqual(WRITES);
  });

  it("gives no read surface a mutating verb or flag", () => {
    const MUTATING = [
      "record",
      "claim",
      "renew",
      "abandon",
      "pause",
      "resume",
      "approve",
      "deny",
      "--stop",
      "--event",
      "--stage",
      "--why",
      "--record",
      "--record-external",
      "push",
      "commit",
      "redact",
      "--exit",
      // The frontier's claim, and the tracker's writes.
      "--take-one",
      "edit",
      "create",
      "close",
      "comment",
      "--add-label",
      "--remove-label",
    ];
    for (const [name, { args }] of Object.entries(declared)) {
      if (WRITES.includes(name)) continue;
      for (const verb of MUTATING) {
        expect(args, `${name} names ${verb}`).not.toContain(verb);
      }
    }
  });
});

describe("the adapter's command surface is read-only", () => {
  it("names no mutating ralph command or flag", () => {
    const text = source("adapter.ts");
    for (const literal of [
      '"record"',
      '"claim"',
      '"renew"',
      '"abandon"',
      '"pause"',
      '"resume"',
      '"approve"',
      '"deny"',
      '"--stop"',
      '"--event"',
      '"--stage"',
      '"--why"',
      // usage.py records unless told not to; the adapter only ever reads it.
      '"--record"',
      '"--record-external"',
      '"push"',
      '"commit"',
      // runner-failure's verbs that write or classify; the adapter only ever asks
      // it for status. `redact` runs elsewhere, in the live pane, and only as a
      // filter without `--done` — pinned below.
      '"redact"',
      '"--exit"',
    ]) {
      expect(text).not.toContain(literal);
    }
  });

  it("spawns nothing itself: the runtime, Jav and intake CLIs all run through the executor", () => {
    // Node's spawning needs `node:child_process` by import or `require` (both
    // read by `importsOf`), so pinning that it is absent cannot be out-grown
    // the way a count of call sites can (an aliased or destructured
    // `execFile`). Bun's globals need no import, so they are the one thing
    // still matched by name. The executor is the one module of the read path
    // that may reach `node:child_process`; the CLI reader only drives the port
    // it is handed.
    for (const file of ["adapter.ts", "jav-adapter.ts", "intake-adapter.ts", "project-sleep-adapter.ts", "claude-accounts-adapter.ts"]) {
      expect(importsOf(source(file)), file).not.toContain("node:child_process");
      expect(source(file), file).not.toMatch(/Bun\.(spawn|spawnSync|\$)/);
    }
    const spawning = ["adapter.ts", "jav-adapter.ts", "intake-adapter.ts", "project-sleep-adapter.ts", "executor.ts", "cli-read.ts"].filter((file) =>
      importsOf(source(file)).includes("node:child_process"),
    );
    expect(spawning).toEqual(["executor.ts"]);
    expect(source("adapter.ts")).not.toMatch(/writeFileSync|appendFileSync/);
  });

  it("reads the ci-health store and never writes it", () => {
    // `node:fs` is allow-listed wholesale for this module, so the import map
    // alone would pass a later edit that added a write. The store is the
    // doctor's, written under `withStore`'s lock by `ci-doctor/store.ts`; a
    // dashboard write would corrupt a 72-hour window nothing else can rebuild
    // without a full Buildkite scan. Same pin as `usage.ts` above.
    // Pinned as the import line rather than as a list of forbidden symbols:
    // `node:fs` is allow-listed wholesale for this module, and a deny-list
    // cannot be complete — `promises.writeFile`, `createWriteStream`,
    // `copyFileSync` and `truncateSync` are all writes a named-symbol regex
    // would miss. Three read symbols is the whole of what this file may reach,
    // so stating that cannot be out-grown by a new fs API. `readdirSync`
    // joined them for #163: the wait medians come from listing each coder
    // worktree's `.ralph/logs`.
    const text = source("ci-health.ts");
    expect(text).toMatch(/^import \{ readFileSync, readdirSync, statSync \} from "node:fs";$/m);
    expect(text.match(/from "node:fs"/g) ?? []).toHaveLength(1);
  });

  it("reads claims only: the lease status projection and gh issue list", () => {
    expect(COMMAND_SURFACE.claims.args).toEqual(["status", "--json"]);
    expect(COMMAND_SURFACE.github.args.slice(0, 2)).toEqual(["issue", "list"]);
    for (const verb of ["edit", "create", "close", "comment", "--add-label", "--remove-label", "--add-assignee"]) {
      expect(COMMAND_SURFACE.github.args).not.toContain(verb);
    }
  });

  it("reads the frontier only as a dry run: the flag parser refuses --json without it", () => {
    expect(COMMAND_SURFACE.frontier.args).toEqual(["--dry-run", "--json"]);
    expect(COMMAND_SURFACE.frontier.args).not.toContain("--take-one");
  });

  it("reads the verifier's watch store only as the Following projection", () => {
    expect(COMMAND_SURFACE.following.args).toEqual(["--json"]);
    expect(COMMAND_SURFACE.following.script).toBe(join("verifier", "following.ts"));
  });

  it("reads the timeline and runner failures only as JSON projections", () => {
    expect(COMMAND_SURFACE.timeline.args).toEqual(["--json"]);
    expect(COMMAND_SURFACE.runnerFailure.args).toEqual(["status", "--json"]);
  });

  it("gives the server and the shell build no subprocess surface at all", () => {
    expect(source("server.ts")).not.toMatch(/child_process|execFile|spawn/);
    expect(source("build.ts")).not.toMatch(/child_process|execFile|spawn/);
  });

  it("keeps the agent surface to a closed list, with no force: the base branch only ever fast-forwards", () => {
    expect(AGENT_SURFACE.git).toEqual({
      command: "git",
      fetch: ["fetch", "--quiet", "origin"],
      worktreeList: ["worktree", "list", "--porcelain"],
      worktreeAdd: ["worktree", "add"],
      worktreeRemove: ["worktree", "remove"],
      readTree: ["read-tree"],
      hashObject: ["hash-object", "-w", "--"],
      updateIndex: ["update-index", "--add", "--cacheinfo"],
      writeTree: ["write-tree"],
      commitTree: ["commit-tree"],
      push: ["push", "--no-verify", "origin"],
      remoteBranch: ["ls-remote", "--exit-code", "--heads", "origin"],
      status: ["status", "--porcelain"],
      isAncestor: ["merge-base", "--is-ancestor", "HEAD"],
      advance: ["checkout", "--detach", "--quiet"],
      // Two of these, HEAD and the base ref, are how a new agent's worktree
      // item compares exactly — `isAncestor` passes a worktree that is merely
      // behind, which is the stale checkout the item exists to catch.
      revParse: ["rev-parse"],
    });
    expect(AGENT_SURFACE.gh).toEqual({
      command: "gh",
      prCreate: ["pr", "create"],
      prList: ["pr", "list", "--state", "all", "--limit", "1", "--json", "url,state,headRefName"],
      openPrList: ["pr", "list", "--state", "open", "--limit", "100", "--json", "url,state,headRefName"],
      // Add agent creates a new loop's labels. `label create` adds one label
      // and cannot edit or delete an existing one, which is why the list has
      // no `label edit` or `label delete` beside it.
      labelList: ["label", "list", "--limit", "200", "--json", "name,color,description"],
      labelCreate: ["label", "create"],
      // Settings lists the check names a repo reported. `gh api` is pinned to
      // the bare verb: no `--method` or `-f`, so it only ever GETs.
      recentPrHeads: ["pr", "list", "--state", "all", "--limit", "5", "--json", "headRefOid"],
      api: ["api"],
    });
    expect(AGENT_SURFACE.preflight).toEqual({
      script: "preflight.ts",
      labels: "--labels",
      loop: "--loop",
      role: "--role",
      json: "--json",
    });
    // `project-config`'s flags: the roster, verifier, sentinel and project settings
    // edits, each printing the edited file for a PR, never writing it.
    expect(AGENT_SURFACE.config).toEqual({
      script: "project-config.ts",
      json: "--json",
      at: "--at",
      add: "--add-loop",
      remove: "--remove-loop",
      role: "--role",
      setVerifier: "--set-verifier",
      setSentinel: "--set-sentinel",
      setProject: "--set-project",
    });
    // The sentinel's issue store, read for its panel: `--json` is the CLI's
    // only flag, and the store's writer (`withStore`) is no CLI at all.
    expect(AGENT_SURFACE.sentinel).toEqual({ script: join("sentinel", "issues.ts"), json: "--json" });
    // Two more read-only JSON projections, for a new agent's readiness: which
    // lineup it would resolve, and whether Jav routes it. Neither flag writes
    // anything — `models.ts --save`/`--validate` and `jav.ts --save` are the
    // write verbs, and neither is in this surface. `--render-prompt` prints
    // the filled prompt to stdout and writes nothing either.
    expect(AGENT_SURFACE.models).toEqual({ script: "models.ts", json: "--json", role: "--role", render: "--render-prompt" });
    expect(AGENT_SURFACE.jav).toEqual({ script: "jav.ts", json: "--json" });
    // The guide is served as the harness file's own bytes, never as a copy.
    expect(AGENT_SURFACE.guide).toBe("adding-an-agent.md");
    expect(AGENT_SURFACE.nodeModules).toBe("node_modules");
    // The setup record is written only into an agent's own worktree logs (#694).
    expect(AGENT_SURFACE.worktreeSetupRecord).toBe(`${AGENT_SURFACE.logsDir}/worktree-setup.json`);
    // And the list is CLOSED, which per-group pins alone would not say: a new
    // top-level entry is a new thing the dashboard runs or reads, and it has to
    // arrive with a pin of its own rather than inside this one's blind spot.
    expect(Object.keys(AGENT_SURFACE).sort()).toEqual([
      "branchPrefix",
      "config",
      "gh",
      "git",
      "guide",
      "jav",
      "logsDir",
      "loopName",
      "models",
      "nodeModules",
      "preflight",
      "sentinel",
      "supervisors",
      "workspaces",
      "worktreeSuffix",
      "worktreeSetupRecord",
      "configPath",
    ].sort());
    const text = source("agents-adapter.ts");
    for (const literal of ['"--force"', '"-f"', '"reset"', '"clean"', '"stash"', '"-D"', '"delete"']) {
      expect(text).not.toContain(literal);
    }
    // The only directory it deletes is its own scratch dir for a roster commit;
    // the only file, the setup record's temp file a failed write left (#694).
    expect(text.match(/rmSync\(/g)).toEqual(["rmSync(", "rmSync("]);
    expect(text).toContain("rmSync(dir, { recursive: true, force: true })");
    expect(text).toContain("rmSync(temp, { force: true })");
    for (const file of ["agents.ts", "agents-routes.ts"]) {
      expect(source(file)).not.toMatch(/child_process|execFile|spawn|node:fs/);
    }
  });

  it("keeps the project registry to its own file, with no subprocess", () => {
    const text = source("projects.ts");
    expect(text).not.toMatch(/child_process|execFile|spawn|appendFileSync|rmSync|process\.kill/);
    // Every write goes through the atomic writer; the only other file touched is the lock.
    expect(text.match(/writeSync\(|renameSync\(/g)).toEqual(["writeSync(", "renameSync("]);
    expect(text.match(/openSync\([^)]*"wx"\)/g)).toEqual(['openSync(lock, "wx")']);
  });

  it("lets the usage reader open logs for reading and nothing more", () => {
    const text = source("usage.ts");
    for (const file of ["usage.ts", "usage-worker.ts"]) {
      expect(source(file)).not.toMatch(/child_process|execFile|spawn|writeFileSync|appendFileSync|writeSync|mkdirSync|renameSync|unlinkSync|rmSync/);
    }
    expect(text.match(/openSync\(/g)).toEqual(["openSync("]);
    expect(text).toContain('openSync(path, "r")');
    expect(text.match(/new Worker\(/g)).toEqual(["new Worker("]);
    expect(text).toContain('new Worker(new URL("./usage-worker.ts", import.meta.url))');
  });
});

describe("the feed and the history read records and write only the read mark", () => {
  it("open the loop's records for reading, and write one file in the control directory", () => {
    const text = source("records-adapter.ts");
    expect(text).not.toMatch(/child_process|execFile|spawn|appendFileSync|unlinkSync|rmSync|process\.kill/);
    expect(text.match(/openSync\(\s*path,\s*"r"\s*\)/g)).toEqual(['openSync(path, "r")']);
    // Every write is in markRead: the read mark, and the control directory's own .gitignore.
    const writes = text.slice(text.indexOf("markRead: (through)"));
    expect(text.match(/writeFileSync\(|renameSync\(|mkdirSync\(/g)?.length).toBe(writes.match(/writeFileSync\(|renameSync\(|mkdirSync\(/g)?.length);
    expect(RECORDS_SURFACE.readMark.path.startsWith(`${RECORDS_SURFACE.readMark.dir}/`)).toBe(true);
    expect(RECORDS_SURFACE.readMark.dir).toBe(CONTROL_SURFACE.inbox.dir);
  });

  it("keep the projection and the routes free of any file, process or CLI", () => {
    expect(source("records.ts")).not.toMatch(/node:|child_process|spawn|readFileSync/);
    expect(source("records-routes.ts")).not.toMatch(/node:|child_process|spawn|RALPH_|\.ts["']/);
  });
});

describe("the loop reconciler's command surface", () => {
  const text = source("reconcile.ts");
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("is one command: push-notification's push, with the three variables that attribute it", async () => {
    expect(RECONCILE_SURFACE).toEqual({
      push: {
        script: "push-notification.ts",
        args: ["push"],
        kinds: {
          restarted: "loop-restarted",
          capped: "loop-restart-capped",
          retried: "loop-retried",
          retryCapped: "loop-retry-capped",
          migrationStalled: "migration-applied-stalled",
        },
        env: { root: "RALPH_STATE_ROOT", loop: "RALPH_LOOP_NAME", run: "RALPH_RUN_ID" },
      },
      // The migration watchdog's two reads (#434): read-only `gh`, nothing that writes.
      gh: {
        command: "gh",
        label: "migration-applied",
        list: ["pr", "list", "--state", "open", "--label", "migration-applied", "--json", "number,title,url"],
        events: [
          "api",
          "--paginate",
          "repos/{owner}/{repo}/issues/{number}/events",
          "--jq",
          '.[] | select(.event == "labeled" and .label.name == "migration-applied") | .created_at',
        ],
      },
      watchdog: { run: "migration-watchdog" },
    });
    expect(NOTIFICATION_KINDS as readonly string[]).toContain("migration-applied-stalled");
    // Every kind is the harness's own, so the feed and the page know them.
    for (const kind of Object.values(RECONCILE_SURFACE.push.kinds)) {
      expect(NOTIFICATION_KINDS as readonly string[]).toContain(kind);
    }
    const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "", stderr: "" } });
    await createReconcileAdapter({ cliDir: "/h", bunPath: "bun", env: {}, exec: recorder.exec }).push({
      kind: RECONCILE_SURFACE.push.kinds.restarted,
      occurrence: "loop-restarted:p:ralph:2026-10-20T12:00:00.000Z",
      subject: "s",
      body: "b",
      priority: "normal",
      worktree: "/w/loop",
      loop: "ralph",
      run: "ralph-run-dead",
    });
    expect(recorder.calls).toHaveLength(1);
    const { invocation } = recorder.calls[0]!;
    expect(invocation.args.slice(0, 2)).toEqual(["/h/push-notification.ts", "push"]);
    expect(invocation.cwd).toBe("/w/loop");
    expect(invocation.env[RECONCILE_SURFACE.push.env.root]).toBe("/w/loop");
    expect(invocation.env[RECONCILE_SURFACE.push.env.run]).toBe("ralph-run-dead");
    // The one `push-notification` verb it may ever name. `record`, `claim`,
    // `finalize` and `reserve` are the loop's own.
    expect(code.match(/"push-notification\.ts"/g)).toHaveLength(1);
    for (const verb of ['"record"', '"claim"', '"finalize"', '"reserve"', '"observation"']) {
      expect(code).not.toContain(verb);
    }
  });

  it("spawns nothing, writes nothing, and signals nothing of its own", () => {
    // The restart is `start.sh` through the start route's own path; the
    // reconciler itself may not reach a process or the disk.
    expect(code).not.toMatch(/child_process|spawn|execFile|(?<![.\w])exec\(|process\.kill/);
    expect(code).not.toMatch(/node:fs|readFileSync|writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/);
    // And it names no start of its own: `start.sh` is the lifecycle adapter's,
    // and `gatedStart` is the ONE way in. `./lifecycle` is allow-listed for
    // `readRecord`, so without these a later edit could call `start`,
    // `resumeWork`, `restartToApply` or the lifecycle adapter's own `start()`
    // directly and step around the new-agent gate with this file still green
    // — the same pin `chat-fix.ts` carries below.
    expect(code).not.toContain("start.sh");
    expect(code.match(/gatedStart\(/g)).toHaveLength(1);
    expect(code).not.toMatch(/(?<![.\w])start\(|lifecycle\.start\(|resumeWork|restartToApply|startAgent/);
    // `readRecord` is the one other thing it may take from `./lifecycle`: the
    // unconfirmed stop a new supervisor would adopt.
    expect(code.match(/readRecord\(/g)).toHaveLength(1);
  });
});

describe("the unblocker chat's command surface", () => {
  const text = source("chat.ts");
  // The prose says what the module refuses to do, so it names the very flags
  // and APIs the assertions below forbid; they judge the code.
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  /** A linked loop worktree, as the sandbox is drawn around one. */
  const ROOTS: SandboxRoots = {
    worktree: "/w/loop",
    harness: "/h",
    gitDirs: { own: "/r/.git/worktrees/loop", common: "/r/.git" },
    tmp: "/tmp/ralph-chat-c1",
    tools: ["/home/u/.bun"],
  };

  it("pins Ask's OS sandbox: fail closed, reads only its roots, no writes, no network", () => {
    const settings = JSON.parse(askSettings(["Read(~/.ssh/**)"], ROOTS)) as { sandbox: unknown };
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: ["gh issue view *", "gh pr view *", "gh pr checks *", "bun /h/bk-log.ts *", "bun /h/tracker.ts view *"],
      filesystem: {
        denyRead: ["/tmp", "/var/tmp", "/dev/shm", "/run/user"],
        allowRead: ["/w/loop", "/h", "/r/.git", "/r/.git/worktrees/loop", "/tmp/ralph-chat-c1"],
        allowWrite: ["/tmp/ralph-chat-c1"],
        // Not the worktree root: bwrap writes its mask files there (probed).
        denyWrite: ["/h", "/r/.git", "/r/.git/worktrees/loop", "/w/loop/.git"],
      },
      network: { allowedDomains: [] },
    });
    // The commands that leave the sandbox are exactly the allowlist's gh and
    // bk-log reads: never a git command, never anything the allowlist lacks.
    expect(ASK_UNSANDBOXED("/h").map((pattern) => `Bash(${pattern.replace(/ \*$/, ":*")})`)).toEqual(
      ASK_MODE.allowed("/h").filter((rule) => !rule.startsWith("Bash(git ")),
    );
    // The deny lists are still there under it, as the second layer.
    const both = JSON.parse(askSettings(["Read(~/.ssh/**)"], ROOTS)) as { permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean } };
    expect(both.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(both.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/**)", "Read(**/.env*)", "Bash(grep *)"]));
    // And the allowlist's one write — `git log --output=<file>`, probed to
    // write into the worktree — is denied, since the sandbox cannot make the
    // worktree root read-only.
    expect(ASK_WRITE_FLAGS).toEqual(["Bash(*--output*)"]);
    expect(both.permissions.deny).toContain("Bash(*--output*)");
  });

  it("pins Fix's OS sandbox: fail closed, writes only the worktree, its git dir and temp, no network", () => {
    const settings = JSON.parse(fixSettings(["Read(~/.ssh/**)", "Bash(git push *)"], ROOTS)) as {
      sandbox: unknown;
      permissions: { deny: string[] };
    };
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: ["/tmp", "/var/tmp", "/dev/shm", "/run/user"],
        // The harness too: the executor guard's shims lead a Fix turn's PATH.
        allowRead: ["/w/loop", "/h", "/r/.git", "/r/.git/worktrees/loop", "/tmp/ralph-chat-c1", "/home/u/.bun"],
        allowWrite: ["/r/.git/worktrees/loop", "/tmp/ralph-chat-c1"],
      },
      network: { allowedDomains: [] },
    });
    // No command leaves a Fix turn's sandbox.
    expect(settings.sandbox).not.toHaveProperty("excludedCommands");
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash(git push *)", "Read(**/.env*)", "Bash(cat *)"]));
  });

  it("runs every turn with the sandbox's shell and private temp dir, and withholds a turn the CLI would not sandbox", () => {
    expect(sandboxEnv(ROOTS)).toEqual({
      CLAUDE_CODE_SHELL: "/bin/bash",
      CLAUDE_CODE_TMPDIR: "/tmp/ralph-chat-c1",
      BUN_TMPDIR: "/tmp/ralph-chat-c1",
    });
    expect(chatTmpDir("c1")).toBe("/tmp/ralph-chat-c1");
    expect(code).toContain("this.deps.claude(args, chat.loop.worktree, mode, sandboxEnv(roots))");
    expect(SANDBOX.unavailable.test("Error: sandbox required but unavailable: sandbox is enabled but dependencies are missing")).toBe(true);
  });

  it("finds a linked worktree's git dirs, and bun's install root", () => {
    const files: Record<string, string> = {
      "/w/loop/.git": "gitdir: /r/.git/worktrees/loop\n",
      "/r/.git/worktrees/loop/commondir": "../..\n",
    };
    const io = {
      readFileSync: (path: string) => {
        if (path in files) return files[path]!;
        throw new Error("ENOENT");
      },
      readdirSync: () => [],
    } as unknown as Parameters<typeof gitDirsOf>[1];
    expect(gitDirsOf("/w/loop", io)).toEqual({ own: "/r/.git/worktrees/loop", common: "/r/.git" });
    // A main checkout's `.git` is a directory, inside the worktree already.
    expect(gitDirsOf("/elsewhere", io)).toEqual({ own: null, common: null });
    expect(toolRootsOf("/home/u/.bun/bin/bun")).toEqual(["/home/u/.bun"]);
    expect(toolRootsOf("/usr/bin/bun")).toEqual(["/usr"]);
    expect(toolRootsOf("bun")).toEqual([]);
  });

  it("runs `claude` and the live pane's redactor, and nothing else", () => {
    // Two spawns: `claude` here, and `createRedactor`'s inside
    // `iteration-output.ts` — reached by import rather than re-declared, so
    // there is one definition of the filter the dashboard trusts.
    expect(code.match(/\bspawn\(/g)).toEqual(["spawn("]);
    expect(CHAT_COMMAND.bin).toBe("claude");
    expect(code).not.toContain('"--done"');
  });

  it("pins the argv that refuses rather than prompts", () => {
    // Probed against the CLI: `dontAsk` denies whatever no allow rule names,
    // `--permission-prompts none` denies whatever would still have prompted,
    // and `--setting-sources ""` stops the loop worktree's own
    // `.claude/settings.json` being loaded over the mode's rules. Drop any
    // one of them and an Ask turn either hangs on a prompt nobody can answer
    // or takes the loop's settings, so all are pinned by value.
    expect(CHAT_COMMAND.args).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--setting-sources",
      "",
    ]);
    expect(commandArgs("ask")).toEqual(CHAT_COMMAND.args);
    // The executor's bypass has no business in Ask: a chat is a conversation.
    // It is spelt exactly once, in Fix's flags (#254), which only
    // `commandArgs("fix")` reaches and the routes gate on a stopped loop.
    expect(CHAT_COMMAND.args.join(" ")).not.toContain("dangerously");
    expect(code.match(/dangerously/g)).toEqual(["dangerously"]);
    expect(code).toMatch(/fix: \[\s*"--output-format",\s*"stream-json",\s*"--verbose",\s*"--dangerously-skip-permissions"/);
    expect(code).not.toContain("bypassPermissions");
    expect(code).not.toContain("acceptEdits");
  });

  it("pins Fix mode to the loop's claude executor's own flags, settings and environment", () => {
    // The flags `delegate.sh` gives the executor, by value, and read off the
    // script itself so the two cannot drift: one more flag here is a reach the
    // loop's own executor does not have.
    expect(commandArgs("fix")).toEqual(CHAT_COMMAND.fix);
    expect(CHAT_COMMAND.fix).toEqual([
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--setting-sources",
      "project",
    ]);
    const delegate = readFileSync(join(HERE, "..", "delegate.sh"), "utf8");
    const invocation = delegate.slice(delegate.indexOf("    claude -p \\"), delegate.indexOf('"${SESSION_ARGS[@]}"'));
    for (const flag of [
      '--settings "${RALPH_HOME}/claude-executor-settings.json" \\',
      "--dangerously-skip-permissions \\",
      "--strict-mcp-config \\",
      "--setting-sources project \\",
      "--output-format stream-json --verbose \\",
    ]) {
      expect(invocation).toContain(flag);
    }
    // And the executor is given no other permission flag the chat lacks.
    expect(invocation).not.toMatch(/--permission-mode|--allowedTools|--add-dir|--tools/);
    // Nothing but the settings: no mounted-tool list, no allowlist, no second root.
    const executor = executorDenies(readFileSync(join(HERE, "..", EXECUTOR_SETTINGS), "utf8"));
    expect(modeArgs("fix", "/h", executor, ROOTS)).toEqual(["--settings", fixSettings(executor, ROOTS)]);
    // The environment is the executor's allowlist, as `delegate.sh` builds it.
    for (const name of EXECUTOR_ENV.passthrough) expect(delegate).toMatch(new RegExp(`for passthrough in [^\\n]*\\b${name}\\b`));
    expect(delegate).toContain('EXECUTOR_PATH="${RALPH_HOME}/executor-guard/bin:${PATH}"');
    expect(EXECUTOR_ENV.guard).toBe("executor-guard/bin");
  });

  it("denies, in a Fix turn, everything the executor denies, and Ask's secret paths and shell readers too", () => {
    const text = readFileSync(join(HERE, "..", EXECUTOR_SETTINGS), "utf8");
    const all = (JSON.parse(text) as { permissions: { deny: string[] } }).permissions.deny;
    expect(executorDenies(text)).toEqual(all);
    const settings = JSON.parse(fixSettings(all, ROOTS)) as { permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean } };
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([...all, ...CHAT_READ_DENY]));
    for (const rule of ["Bash(git push *)", "Bash(gh *)", "Bash(curl *)", "Agent", "WebFetch", "Read(~/.ssh/**)"]) {
      expect(settings.permissions.deny).toContain(rule);
    }
    // The executor's rails deny no shell reader, and a Fix turn's output goes
    // to a browser: Ask's `grep -r SECRET .` hole stays closed here too.
    for (const reader of SHELL_READERS) expect(settings.permissions.deny).toContain(`Bash(${reader} *)`);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    // And it refuses a file it cannot vouch for, as Ask's reader does.
    expect(() => executorDenies("{}")).toThrow(/no permissions.deny/);
    expect(() => executorDenies('{"permissions":{"deny":["Bash(gh *)"]}}')).toThrow(/denies no Read/);
  });

  it("pins Ask mode to #253's command allowlist, file tools confined to two roots, and every edit refused", () => {
    // The command allowlist is the ticket's, verbatim, with `$RALPH_HOME`
    // expanded. Read, Grep and Glob are deliberately NOT on it: a bare allow
    // rule lets them read anywhere (probed: `/etc/hostname`), while without
    // one `dontAsk` confines them to the cwd and `--add-dir`. One more rule
    // here is one more thing an operator's chat can do in a loop's checkout,
    // so a change to it has to change this test too.
    const args = modeArgs("ask", "/h", ["Read(~/.ssh/**)"], ROOTS);
    expect(args.slice(0, -1)).toEqual([
      "--tools",
      "Read,Grep,Glob,Bash",
      "--add-dir",
      "/h",
      "--allowedTools",
      "Bash(gh issue view:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr checks:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      "Bash(bun /h/bk-log.ts:*)",
      // A Linear or Jira ticket's read, through the project's tracker (#339).
      "Bash(bun /h/tracker.ts view:*)",
      "--disallowedTools",
      "Edit,Write,NotebookEdit",
      "--settings",
    ]);
    expect(args.at(-1)).toBe(askSettings(["Read(~/.ssh/**)"], ROOTS));
    // No editing tool is even mounted.
    for (const tool of ["Edit", "Write", "NotebookEdit"]) expect(ASK_MODE.tools.split(",")).not.toContain(tool);
    // Every turn runs a mode: the argv is built from the pinned flags and the
    // mode's, with nothing between them.
    expect(text).toContain("const args = [\"-p\", ...commandArgs(mode), ...modeArgs(mode, this.harness, executor, roots)]");
  });

  it("denies, in an Ask turn, every Read path the executor denies, and more", () => {
    // Read at run time from the executor's own file, so the two cannot drift;
    // this pins that the reading really yields that file's whole Read list.
    const executor = JSON.parse(readFileSync(join(HERE, "..", EXECUTOR_SETTINGS), "utf8")) as { permissions: { deny: string[] } };
    const executorReads = executor.permissions.deny.filter((rule) => rule.startsWith("Read("));
    expect(executorReadDenies(readFileSync(join(HERE, "..", EXECUTOR_SETTINGS), "utf8"))).toEqual(executorReads);
    for (const rule of ["Read(~/.ssh/**)", "Read(~/.config/**)", "Read(~/.doppler/**)", "Read(~/.claude/**)", "Read(~/.netrc)"]) {
      expect(executorReads).toContain(rule);
    }

    const settings = JSON.parse(askSettings(executorReads, ROOTS)) as {
      permissions: { deny: string[]; blockReadsOutsideWorkingDirectories: boolean };
    };
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([...executorReads, ...CHAT_READ_DENY]));
    // The secrets the coordinator named: dotenv files, and the aws, gcloud,
    // gh and doppler config dirs (the last three under the executor's
    // `~/.config/**` and `~/.doppler/**`).
    for (const rule of ["Read(**/.env*)", "Read(~/.aws/**)"]) expect(settings.permissions.deny).toContain(rule);
    // Every shell reader the CLI would otherwise approve on its own, in all
    // three spellings, and none of the ticket's allowed prefixes among them.
    for (const reader of ["cat", "grep", "rg", "sed", "awk", "xargs", "find", "git grep", "git cat-file"]) {
      for (const spelling of [`Bash(${reader} *)`, `Bash(${reader}:*)`, `Bash(${reader})`]) {
        expect(settings.permissions.deny).toContain(spelling);
      }
    }
    for (const allowed of ASK_MODE.allowed("/h")) expect(settings.permissions.deny).not.toContain(allowed);
    expect(SHELL_READERS).not.toContain("git log");
    expect(SHELL_READERS).not.toContain("git show");
    expect(SHELL_READERS).not.toContain("git diff");
    expect(SHELL_READERS).not.toContain("gh");
  });

  it("refuses to read the executor's rails it cannot vouch for", () => {
    expect(() => executorReadDenies("{not json")).toThrow();
    expect(() => executorReadDenies("{}")).toThrow(/no permissions.deny/);
    expect(() => executorReadDenies('{"permissions":{"deny":["Bash(gh *)"]}}')).toThrow(/denies no Read/);
  });

  it("keeps the operator's text out of the argv", () => {
    // `-p` takes its prompt from stdin, so a message beginning with a dash is
    // a message and not an option. The `-p` the module passes is the LAST
    // argv element before the pinned flags, with no text beside it.
    expect(text).toContain('const args = ["-p", ...commandArgs(mode)');
    expect(CHAT_COMMAND.args).not.toContain("-p");
    expect(CHAT_COMMAND.fix).not.toContain("-p");
  });

  it("bounds the handback's draft turn, on top of the mode's rails and never in their place", () => {
    // One reply with no tool loop, and a spend cap: the draft (#255) is a
    // summary, and nothing in its flags may widen what the mode allows.
    expect(CHAT_DRAFT.args).toEqual(["--max-turns", "1", "--max-budget-usd", "1"]);
    expect(code).toContain("if (draft) args.push(...CHAT_DRAFT.args);");
    expect(code.indexOf("if (draft) args.push(...CHAT_DRAFT.args);")).toBeGreaterThan(
      code.indexOf('const args = ["-p", ...commandArgs(mode), ...modeArgs(mode, this.harness, executor, roots)]'),
    );
  });

  it("writes only the transcript, and only by appending", () => {
    // A chat writes one file in a loop's checkout — `chat-<id>.jsonl`, its own
    // — and the module may reach no other write API.
    expect(code.match(/appendFileSync/g)?.length).toBeGreaterThan(0);
    // `exec(` is spelt with a negative lookbehind: this module matches
    // regexes with `RegExp.exec`, and only a BARE `exec(` is a subprocess.
    expect(code).not.toMatch(/writeFileSync|writeSync|mkdirSync|renameSync|unlinkSync|rmSync|truncateSync|ftruncate|execFile|(?<![.\w])exec\(/);
    expect(code).toMatch(/chat-\$\{id\}\.jsonl/);
  });

  it("names no mutating ralph command", () => {
    for (const literal of ['"record"', '"claim"', '"push"', '"commit"', '"--event"', '"--stop"', '"redact"']) {
      expect(code).not.toContain(literal);
    }
  });

  it("builds the turn's end marker from a nonce, never from anything on disk", () => {
    // #253 gives an agent Read over the loop's worktree, where the chat id is
    // a filename. A marker derived from it would be a marker an agent could
    // forge, ending a turn early with a second then accepted over the first's
    // still-running process.
    expect(text).toMatch(/nonce = `\\u0001ralph-chat-\$\{process\.pid\}-\$\{Date\.now\(\)\}-\$\{Math\.random/);
    expect(text).toContain("line === chat.endMarker");
  });
});

describe("Unblock & resume's command surface", () => {
  const text = source("chat-handback-adapter.ts");
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("is a closed list: one ticket read, one comment, one label removal, and the journal publisher", async () => {
    expect(HANDBACK_SURFACE).toEqual({
      gh: { command: "gh", view: ["issue", "view"], fields: "comments,labels", comment: ["issue", "comment"], unlabel: ["issue", "edit"] },
      tracker: { script: "tracker.ts", view: ["view"], comment: ["comment"], unlabel: ["label", "remove"] },
      publish: { script: "publish-journal.ts" },
      drafts: ".ralph/logs",
    });
    const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "", stderr: "" } });
    const adapter = createHandbackAdapter({ cliDir: "/h", root: "/w", loop: "ralph", bunPath: "bun", env: {}, exec: recorder.exec });
    await adapter.readIssue(7);
    // The body and the label each travel as ONE `--flag=value` argument.
    await adapter.comment(7, "-- not a flag");
    await adapter.unlabel(7, "ralph-blocked");
    await adapter.publish("/w/.ralph/logs/journal-draft-x.md", null);
    expect(recorder.calls).toHaveLength(4);
    const [view, comment, unlabel, publish] = recorder.calls.map((call) => call.invocation);
    expect(view!.args).toEqual(["issue", "view", "7", "--json", "comments,labels"]);
    expect(comment!.args).toEqual(["issue", "comment", "7", "--body=-- not a flag"]);
    expect(unlabel!.args).toEqual(["issue", "edit", "7", "--remove-label=ralph-blocked"]);
    expect(publish!.args).toEqual(["/h/publish-journal.ts", "--draft", "/w/.ralph/logs/journal-draft-x.md", "--issue", "none"]);
    // The harness is named, never left to the script's own location.
    expect(publish!.env[PUBLISH_ENV.home]).toBe("/h");
  });

  it("reads and writes a Linear or Jira ticket through tracker.ts, the comment on stdin (#339)", async () => {
    const root = mkdtempSync(join(tmpdir(), "handback-keyed-"));
    try {
      mkdirSync(join(root, ".ralph"));
      writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ tracker: { kind: "linear", team: "AND", workspace: "acme" } }));
      const recorder = createRecordingExecutor({ fallback: { status: 0, stdout: "", stderr: "" } });
      const adapter = createHandbackAdapter({ cliDir: "/h", root, loop: "ralph", bunPath: "bun", env: {}, exec: recorder.exec });
      await adapter.readIssue(7);
      await adapter.comment(7, "-- not a flag");
      await adapter.unlabel(7, "ralph-blocked");
      expect(recorder.calls).toHaveLength(3);
      const [view, comment, unlabel] = recorder.calls.map((call) => call.invocation);
      expect(view).toMatchObject({ command: "bun", args: ["/h/tracker.ts", "view", "7", "--json"] });
      expect(comment!.args).toEqual(["/h/tracker.ts", "comment", "7", "--body-file", "-"]);
      expect(comment!.input).toBe("-- not a flag");
      expect(unlabel!.args).toEqual(["/h/tracker.ts", "label", "remove", "7", "ralph-blocked"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spawns nothing itself, writes only the draft, and labels nothing but by removal", () => {
    expect(code).not.toMatch(/child_process|spawn|execFile|(?<![.\w])exec\(/);
    expect(code.match(/writeFileSync/g)).toEqual(["writeFileSync", "writeFileSync"]);
    expect(code).not.toMatch(/rmSync|unlinkSync|renameSync|appendFileSync/);
    expect(code).not.toMatch(/--add-label|"close"|"delete"|"lock"|"pr"/);
    // The sequence names no command of its own: only the adapter does.
    const sequence = source("chat-handback.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(sequence).not.toMatch(/node:|child_process|spawn|"gh"|publish-journal/);
  });
});

describe("the live output pane is read-only", () => {
  const text = source("iteration-output.ts");

  it("runs only the harness's redactor, as a filter that writes no file", () => {
    expect(REDACT_COMMAND).toEqual({ script: "runner-failure.ts", args: ["redact"] });
    expect(text.match(/\bspawn\(/g)).toEqual(["spawn("]);
    // `--done` is the one flag that makes the filter touch the disk.
    expect(text).not.toContain('"--done"');
    expect(text).not.toMatch(/execFile|exec\(|writeFileSync|appendFileSync|writeSync|mkdirSync|renameSync|unlinkSync|rmSync|truncateSync|ftruncate/);
  });

  it("opens logs for reading only, and feeds the filter from nothing but them", () => {
    expect(text.match(/openSync\(/g)).toEqual(["openSync("]);
    expect(text).toContain('io.openSync(path, "r")');
    // The one write is into the filter's stdin, through `feed`.
    expect(text.match(/stdin\.write\(/g)).toEqual(["stdin.write("]);
    expect(text).not.toMatch(/\bRequest\b|\brequest\.|\.json\(\)|\.text\(\)/);
  });

  it("signals only the filter it started", () => {
    expect(text.match(/\.kill\(/g)).toEqual([".kill("]);
    expect(text).toContain('child.kill("SIGTERM")');
    expect(text).not.toMatch(/process\.kill|pkill|SIGKILL/);
  });

  it("serves the pane over GET only, starting no follower for any other method", async () => {
    const read = vi.fn(async () => runtimeFor("ralph"));
    const output = vi.fn(() => ({ stop: () => undefined }));
    const handler = createHandler({ adapter: { read }, shell: "", clock: () => ({ nowMs: 0 }), output });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await handler(
        new Request("http://127.0.0.1/api/loops/ralph/output", { method, body: "echo hi\n" }),
      );
      expect(response.status).toBe(405);
    }
    expect(read).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });
});

describe("the shell polls without overlapping", () => {
  it("leaves every shell read to the Query layer, which never polls on an interval", () => {
    // `setInterval` would stack a second adapter read on top of a slow one,
    // multiplying subprocesses and letting responses render out of order. The
    // rule lives in query-reads.ts, the only read layer since #738, and is
    // tested there ("never overlaps a slow read with the next one"). This
    // pins that the shell keeps no poll loop or GET of its own that could
    // route around it, and that the layer polls on no interval.
    const shell = readFileSync(join(HERE, "ui", "app.tsx"), "utf8");
    expect(shell).not.toContain("setInterval(");
    expect(shell).not.toContain("usePolled");
    expect(shell).not.toContain("fetch(");
    const queryReads = readFileSync(join(HERE, "ui", "query-reads.ts"), "utf8");
    expect(queryReads).not.toContain("setInterval(");
    // The deleted store must not come back beside it as a second layer.
    expect(existsSync(join(HERE, "ui", "read-store.ts")), "ui/read-store.ts is back").toBe(false);
  });

  it("leaves every view's GET to the Query layer, keeping only its writes (#614)", () => {
    // The GETs belong to the read layer (#614, the Query layer since #738): a
    // view that fetched one of its own would route around the layer's sharing (one read per URL however
    // many panels show it) and its no-overlap rule. A view keeps its POSTs,
    // so every `fetch(` left in one must name a write method. Comments are dropped
    // so a docstring that mentions a read does not count as one.
    const views = ["factory.tsx", "lineup.tsx", "verifier.tsx", "jav.tsx", "agent-guide.tsx", "setup.tsx", "add-project.tsx"];
    for (const view of views) {
      const code = readFileSync(join(HERE, "ui", view), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      const calls = code.split("fetch(").slice(1);
      for (const call of calls) expect(call.slice(0, 300), `a GET left in ui/${view}`).toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    }
    // The factory floor polls through the Query layer alone: no fetch and no timer of its own.
    const factory = readFileSync(join(HERE, "ui", "factory.tsx"), "utf8");
    expect(factory).not.toContain("fetch(");
    expect(factory).not.toContain("setTimeout(");
  });
});

describe("the control surface is the documented one", () => {
  it("writes commands only into the loop's local inbox, and names no Orca verb", () => {
    expect(CONTROL_SURFACE.inbox.path).toBe(".ralph/control/inbox");
    expect([...DISPATCH_ACTIONS]).toEqual([
      "pause",
      "resume",
      "stop",
      "approve",
      "deny",
      "arm-gate",
      "disarm-gate",
      "retry",
      "abandon",
      "release",
      "retry-phase",
    ]);
    // The one poll the page runs: an operator's, recovery commands only, never `--supervised`.
    expect(CONTROL_SURFACE.recoveryPoll.args).toEqual(["poll", "--only", "retry,abandon,release"]);
    expect(CONTROL_SURFACE.recoveryPoll.env.plugins).toBe("RALPH_PLUGINS");
    expect(CONTROL_SURFACE.recoveryPoll.lock).toEqual({ command: "flock", path: ".ralph/logs/supervisor.lock" });
    expect(CONTROL_SURFACE.recoveryPoll.busy).toBe(75);
    // The write path no longer depends on Orca: no `orca` binary, no verb.
    for (const file of ["control-adapter.ts", "dispatch.ts"]) {
      const text = source(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const literal of ['"orca"', '"orchestration"', "RALPH_ORCA_CLI", "orchestration send"]) {
        expect(text, `${file} names ${literal}`).not.toContain(literal);
      }
    }
  });

  it("never signals a process", () => {
    for (const file of ["control-adapter.ts", "executor.ts", "dispatch.ts", "control-routes.ts", "lifecycle-routes.ts", "doctor-adapter.ts", "doctor-routes.ts", "server.ts"]) {
      const text = source(file);
      for (const dangerous of ["process.kill", "SIGTERM", "SIGKILL", "SIGINT", "worker-stop", "pkill"]) {
        expect(text, file).not.toContain(dangerous);
      }
    }
  });

  it("records a Stop now through the loop's own CLI, under the supervisor lock, with no plugin", () => {
    expect(CONTROL_SURFACE.interruptRecord.args).toEqual(["interrupted"]);
    expect(CONTROL_SURFACE.interruptRecord.lock).toEqual(CONTROL_SURFACE.recoveryPoll.lock);
    expect(CONTROL_SURFACE.interruptRecord.busy).toBe(75);
    expect(CONTROL_SURFACE.interruptRecord.env.plugins).toBe("RALPH_PLUGINS");
  });
});

describe("onboarding writes only onto what it creates", () => {
  /** Every argv a surface names, its builders called with placeholder arguments. */
  const argvsOf = (surface: Record<string, unknown>): string[][] =>
    Object.values(surface).flatMap((value) =>
      typeof value === "function"
        ? [(value as (...args: string[]) => string[])("main", "x", "y")]
        : Array.isArray(value)
          ? [value as string[]]
          : [],
    );

  it("never resets, cleans, stashes or force-pushes, and deletes only its own setup branch, at the commit it made it", () => {
    for (const argv of [...argvsOf(ONBOARDING_SURFACE.git), ...argvsOf(ONBOARDING_SURFACE.gh)]) {
      expect(["reset", "clean", "stash", "rm", "branch", "merge", "rebase"]).not.toContain(argv[0]);
      for (const flag of ["--force", "-f", "--force-with-lease", "-D", "--delete", "--hard"]) expect(argv).not.toContain(flag);
    }
    const deletes = argvsOf(ONBOARDING_SURFACE.git).filter((argv) => argv[0] === "update-ref");
    // With its old value, the delete fails if the branch moved since.
    expect(deletes).toEqual([["update-ref", "-d", "refs/heads/ralph-setup", "main"]]);
  });

  it("runs gh only to list, clone, view, read the login and the base branch's checks, list PRs and create the setup PR", () => {
    const verbs = argvsOf(ONBOARDING_SURFACE.gh).map((argv) => `${argv[0]} ${argv[1]}`);
    expect(verbs.sort()).toEqual([
      "api repos/main/commits/x/check-runs?per_page=100",
      "api repos/main/commits/x/status",
      "api user",
      "pr create",
      "pr list",
      "pr list",
      "repo clone",
      "repo list",
      "repo view",
    ]);
    // `gh api` only ever reads: no method, no fields.
    for (const argv of argvsOf(ONBOARDING_SURFACE.gh).filter((argv) => argv[0] === "api")) {
      for (const flag of ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]) expect(argv).not.toContain(flag);
    }
  });

  it("runs no subprocess outside the executor it is handed", () => {
    expect(source("onboarding.ts")).not.toMatch(/child_process|execFile|spawn|process\.kill/);
    expect(source("onboarding-routes.ts")).not.toMatch(/child_process|execFile|spawn|node:fs/);
  });
});

describe("the one module that may signal", () => {
  const text = source("interrupt-adapter.ts");
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("signals only a process group, through one call, with the two signals Stop now sends", () => {
    expect(SIGNAL_SURFACE.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(SIGNAL_SURFACE.pidFile).toBe(".ralph/logs/supervisor.pid");
    // One signalling call, to a negated group, and one probe of the same group.
    expect(code.match(/process\.kill\(/g)).toEqual(["process.kill(", "process.kill("]);
    expect(code).toContain("process.kill(-group, signal)");
    expect(code).toContain("process.kill(-group, 0)");
    expect(code).not.toMatch(/child_process|execFile|spawn|pkill|killall|SIGINT|SIGHUP/);
  });

  it("finds its target in the checkout's pid file, never by pattern", () => {
    expect(code).not.toMatch(/readdirSync|pgrep/);
    expect(code).toContain("SIGNAL_SURFACE.pidFile");
  });

  it("is reached only through Stop now", () => {
    for (const file of Object.keys(ALLOWED)) {
      if (file === "interrupt-adapter.ts") continue;
      // The gate runner signals only the process group it spawned itself for
      // a gate run, never a loop; the test below pins exactly that.
      if (file === "gate-run.ts") continue;
      expect(source(file), file).not.toMatch(/process\.kill\(/);
    }
    const importers = Object.entries(ALLOWED)
      .filter(([, list]) => list.includes("./interrupt-adapter"))
      .map(([file]) => file);
    expect(importers.sort()).toEqual(["compose.ts", "interrupt.ts"]);
  });
});

describe("the gate runner signals only its own child", () => {
  const code = source("gate-run.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("kills only the process group of the gate it spawned, never a loop found by pid file or pattern", () => {
    expect(code.match(/process\.kill\(/g)).toEqual(["process.kill("]);
    expect(code).toContain("process.kill(-pid, signal)");
    // The pid it signals is the child it spawned itself, at every call site.
    expect(code.match(/signalGroup\(([^,]+),/g)?.map((call) => call.replace(/\s+/g, ""))).toEqual([
      "signalGroup(spawned.pid,",
      "signalGroup(spawned.pid,",
      "signalGroup(spawned.pid,",
    ]);
    expect(code).not.toMatch(/pgrep|pkill|killall|pidFile|supervisor\.pid|readFileSync|readdirSync|node:fs/);
  });
});

describe("Stop & fix sends the ordinary soft stop and nothing else", () => {
  it("dispatches one stop, at iteration scope, and signals nothing", () => {
    const code = source("chat-fix.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code.match(/\bdispatch\(/g)).toEqual(["dispatch("]);
    expect(code.match(/action: "[\w-]+"/g)).toEqual(['action: "stop"']);
    expect(code).toContain('scope: "iteration"');
    expect(code).not.toMatch(/process\.kill|stopNow|interrupt|deliver\(|spawn|execFile|lifecycle\.start\(|restartToApply|resumeWork/);
  });
});

describe("the control route stays thin", () => {
  it("names no CLI, flag or environment variable, and sends only through dispatch", () => {
    const text = source("control-routes.ts");
    for (const literal of ["controls.ts", "orchestration", "--payload", "--run", "RALPH_", "process.env"]) {
      expect(text).not.toContain(literal);
    }
    expect(text).toMatch(/\bdispatch\(/);
    expect(text).not.toMatch(/deliver\(|execFile|spawn/);
  });

  it("keeps the lifecycle routes as thin: no CLI, flag or environment variable, only lifecycle dispatch", () => {
    const text = source("lifecycle-routes.ts");
    for (const literal of ["start.sh", "loop-state", "controls.ts", "orchestration", "git", "RALPH_", "process.env"]) {
      expect(text).not.toContain(literal);
    }
    expect(text).toMatch(/\bstart\(/);
    expect(text).toMatch(/\brestartToApply\(/);
    expect(text).not.toMatch(/Invocation\(\)|execFile|spawn/);
  });
});

describe("the loop controls", () => {
  // All three: the controls live in controls.tsx, their rules and routes in
  // control-model.ts, but a control POST or a confirmation added back to the
  // shell must still be counted here.
  const controls = ["controls.tsx", "control-model.ts", "app.tsx"].map((file) => readFileSync(join(HERE, "ui", file), "utf8")).join("\n");

  it("posts every control to the one write route with its loop and action", () => {
    expect(controls).toContain('"/api/control"');
    expect(controls).toMatch(/\{ loop: entry\.loop, action, \.\.\.run, \.\.\.body \}/);
  });

  it("sends stop's, Stop now's, restart's, abandon's and release's confirmation only from their second, confirming step", () => {
    // Exactly one place per destructive action sets the field, and it is that
    // action's confirm button handler; abandon and release share the claim's,
    // and the interrupted ticket's release has its own beside Resume work.
    expect(controls.match(/confirm:\s*true/g) ?? []).toHaveLength(5);
    expect(controls).toMatch(/void send\("stop-now", \{ \.\.\.\(nowWhy[^\n]*confirm: true \}\)\s*\}\s*>\s*<Zap className="size-3\.5" \/>\s*Confirm stop now/);
    expect(controls).toMatch(/void send\("release", \{ issue: ticket, confirm: true \}\)\}\s*>\s*<Undo2 className="size-3\.5" \/>\s*Confirm release #\{ticket\}/);
    expect(controls).toMatch(/void send\(claimArmed\.action, \{ issue: claimArmed\.issue, confirm: true \}\)\}\s*>[\s\S]{0,160}Confirm \{action\}/);
    expect(controls).toMatch(/void send\("stop", \{[^}]*confirm: true \}\)\s*\}\s*>\s*<CircleStop className="size-3\.5" \/>\s*Confirm stop/);
    expect(controls).toMatch(/void send\("restart", \{[^}]*confirm: true,?\s*\}\)\s*\}\s*>\s*<RotateCcw className="size-3\.5" \/>\s*Confirm restart/);
  });

  it("posts start and restart to their routes, start without a confirmation", () => {
    expect(controls).toContain('"/api/restart"');
    expect(controls).toMatch(/\["\/api\/start", \{ loop: entry\.loop \}\]/);
  });

  it("warns about a dirty or mid-ticket checkout before a restart, from the checkout report", () => {
    expect(controls).toContain("/checkout`");
    expect(controls).toMatch(/checkout\.dirty/);
    expect(controls).toMatch(/checkout\.midTicket/);
  });

  it("surfaces restart's stop confirmation and start result", () => {
    expect(controls).toMatch(/last\.confirmation/);
    expect(controls).toMatch(/last\.start/);
    expect(controls).toMatch(/last\.halt/);
  });

  it("offers approve and deny only for a pending approval hold", () => {
    expect(controls).toMatch(/hold\?\.kind\s*===\s*"approval"/);
  });

  it("asks for a re-issue on needs-reconfirmation rather than resending", () => {
    expect(controls).toContain('"needs-reconfirmation"');
    expect(controls).toMatch(/Re-issue/);
    // A reconfirm flag would send the command to the run the operator named;
    // the page re-issues against the current run instead.
    expect(controls).not.toMatch(/reconfirm:\s*true/);
  });
});

describe("the control view is read-only", () => {
  it("reaches the control record only through the status read", () => {
    const text = source("control-view.ts");
    // The adapter is narrowed to its status read by type, and that is the one call made on it.
    expect(text).toContain('Pick<ControlAdapter, "readControlStatus">');
    expect(text).toContain("adapter.readControlStatus()");
    for (const write of ["deliver(", "dispatch(", "writeFileSync", "child_process"]) {
      expect(text).not.toContain(write);
    }
  });

  it("serves the control view over GET only, without reading the runtime for other methods", async () => {
    const read = vi.fn(async () => runtimeFor("ralph"));
    const controlStatus = vi.fn(async () => ({ kind: "none" as const }));
    const handler = createHandler({ adapter: { read }, shell: "", clock: () => ({ nowMs: 0 }), controlStatus });
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await handler(new Request("http://127.0.0.1/api/loops/ralph/control", { method }));
      expect(response.status).toBe(405);
    }
    expect(read).not.toHaveBeenCalled();
    expect(controlStatus).not.toHaveBeenCalled();
  });

  it("serves every loop's control view from one runtime read", async () => {
    const read = vi.fn(async () => runtimeFor("ralph", "rafa", "remo"));
    const controlStatus = vi.fn(async () => ({ kind: "none" as const }));
    const handler = createHandler({ adapter: { read }, shell: "", clock: () => ({ nowMs: 0 }), controlStatus });
    const response = await handler(new Request("http://127.0.0.1/api/controls"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { loops: Record<string, { loop: string }> };
    expect(Object.keys(body.loops).sort()).toEqual(["rafa", "ralph", "remo"]);
    expect(body.loops.rafa?.loop).toBe("rafa");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers a non-GET to the batched control view 405 without reading the runtime", async () => {
    const read = vi.fn(async () => runtimeFor("ralph"));
    const controlStatus = vi.fn(async () => ({ kind: "none" as const }));
    const handler = createHandler({ adapter: { read }, shell: "", clock: () => ({ nowMs: 0 }), controlStatus });
    const response = await handler(new Request("http://127.0.0.1/api/controls", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(read).not.toHaveBeenCalled();
    expect(controlStatus).not.toHaveBeenCalled();
  });
});

const runtimeFor = (...names: string[]): RuntimeSnapshot => ({
  roster: coderRoster(...names),
  loops: [],
  reconciliation: { orphaned: [], prunable: [] },
});

describe("handlers never invoke a write path", () => {
  const runtime: RuntimeSnapshot = { roster: coderRoster("ralph"), loops: [], reconciliation: { orphaned: [], prunable: [] } };
  const clock = (): Clock => ({ nowMs: 0 });

  const handlerWith = () => {
    const read = vi.fn(async () => runtime);
    return { read, handler: createHandler({ adapter: { read }, shell: "<html></html>", clock }) };
  };

  it("refuses every non-GET without reading the runtime", async () => {
    const { read, handler } = handlerWith();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await handler(new Request("http://127.0.0.1/api/loops", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("serves the shell without reading the runtime", async () => {
    const { read, handler } = handlerWith();
    const response = await handler(new Request("http://127.0.0.1/"));
    expect(response.status).toBe(200);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the project list and every project-scoped observation route GET-only", async () => {
    const { read, handler } = handlerWith();
    for (const path of ["/api/projects", "/api/p/default/loops", "/api/p/default/loops/ralph", "/api/p/default/usage", "/api/p/default/frontier"]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect((await handler(new Request(`http://127.0.0.1${path}`, { method }))).status).toBe(405);
      }
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("reads other projects' health without their full snapshot, over GET only", async () => {
    const project = (id: string) => {
      const read = vi.fn(async () => runtime);
      const health = vi.fn(async () => ({
        project: id,
        readAt: "2026-09-23T00:00:00.000Z",
        health: "idle" as const,
        needsYou: 0,
        needs: [],
        loops: 0,
        running: 0,
        problem: null,
      }));
      return { read, health, scope: { project: { id, path: `/${id}`, addedAt: "", source: "local" as const }, adapter: { read }, health } };
    };
    const alpha = project("alpha");
    const beta = project("beta");
    const handler = createHandler({ projects: () => [alpha.scope, beta.scope], shell: "", clock });
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await handler(new Request("http://127.0.0.1/api/projects/health", { method }))).status).toBe(405);
    }
    expect(beta.health).not.toHaveBeenCalled();
    const response = await handler(new Request("http://127.0.0.1/api/projects/health?selected=alpha"));
    expect(((await response.json()) as { projects: { project: string }[] }).projects.map((view) => view.project)).toEqual(["beta"]);
    // The selected project is not read at all; the other only through its health read.
    expect(alpha.health).not.toHaveBeenCalled();
    expect(beta.health).toHaveBeenCalledTimes(1);
    expect(alpha.read).not.toHaveBeenCalled();
    expect(beta.read).not.toHaveBeenCalled();
  });

  it("keeps the health fold free of any process, file or gh", () => {
    expect(source("health.ts")).not.toMatch(/child_process|execFile|spawn|node:fs|"gh"/);
  });

  it("reads once for the roster", async () => {
    const { read, handler } = handlerWith();
    const response = await handler(new Request("http://127.0.0.1/api/loops"));
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("hands lineup paths to the mounted editor and nothing else", async () => {
    const read = vi.fn(async () => runtime);
    const lineup = vi.fn(async () => new Response("lineup"));
    const handler = createHandler({ adapter: { read }, shell: "<html></html>", clock, lineup });
    for (const path of ["/api/lineup", "/api/lineup/preview", "/api/lineup/save", "/api/roots"]) {
      const response = await handler(new Request(`http://127.0.0.1${path}`, { method: "POST" }));
      expect(await response.text()).toBe("lineup");
    }
    expect(lineup).toHaveBeenCalledTimes(4);
    expect(read).not.toHaveBeenCalled();
    // The observer's own routes are still GET-only with the editor mounted.
    expect((await handler(new Request("http://127.0.0.1/api/loops", { method: "POST" }))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1/api/lineups", { method: "POST" }))).status).toBe(405);
  });

  it("refuses lineup writes outright when no editor is mounted", async () => {
    const { read, handler } = handlerWith();
    const response = await handler(new Request("http://127.0.0.1/api/lineup/save", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(read).not.toHaveBeenCalled();
  });

  it("hands the control route to the mounted controls and refuses it otherwise", async () => {
    const read = vi.fn(async () => runtime);
    const controls = vi.fn();
    const mounted = createHandler({ adapter: { read }, shell: "<html></html>", clock, controls });
    // A malformed command is answered by the route itself, before any loop is resolved or sent to.
    const malformed = await mounted(new Request("http://127.0.0.1/api/control", { method: "POST", body: "{}" }));
    expect(malformed.status).toBe(400);
    expect(controls).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    // The observer's own loop and control-view routes stay GET-only beside the mounted controls.
    expect((await mounted(new Request("http://127.0.0.1/api/loops/ralph", { method: "POST" }))).status).toBe(405);
    expect((await mounted(new Request("http://127.0.0.1/api/loops/ralph/control", { method: "POST" }))).status).toBe(405);

    const { read: bare, handler } = handlerWith();
    const refused = await handler(new Request("http://127.0.0.1/api/control", { method: "POST", body: "{}" }));
    expect(refused.status).toBe(405);
    expect(bare).not.toHaveBeenCalled();
  });
});

describe("only adapters call an Executor (#640)", () => {
  // Every non-test module of the dashboard, read off the directory so a new
  // one is classified the moment it lands instead of when someone lists it.
  const modules = readdirSync(HERE)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .sort();

  // The modules that may hold and call an Executor. Each command path's
  // adapter owns its exec (#633–#639); widening this set is a visible decision.
  const isAdapter = (name: string): boolean =>
    name === "adapter.ts" ||
    name.endsWith("-adapter.ts") ||
    name === "cli-read.ts" ||
    name === "executor.ts" ||
    // Test infrastructure: the executor the suites record invocations with.
    name === "recording-executor.ts" ||
    // Test infrastructure too: the adapter suites' scripted world, which
    // answers invocations on top of the recording executor (#613).
    name === "adapter-script.ts" ||
    // `createReconcileAdapter` lives in the reconciler's own module (#637).
    name === "reconcile.ts";
  // The composition root: it constructs executors and hands them to the
  // composition, which hands each to an adapter factory (#624).
  const ROOT = "server.ts";
  const COMPOSITION = "compose.ts";
  const others = modules.filter((name) => !isAdapter(name) && name !== ROOT && name !== COMPOSITION);

  const EXEC_NAMES = ["guarded", "Executor", "Invocation", "ExecResult", "createProcessExecutor"];
  // Double-quoted strings are blanked before comments are stripped, so a glob
  // like "src/**" or a URL cannot open a "comment" that hides code after it.
  const codeOf = (text: string): string =>
    text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  // `allowImportingTsExtensions` is on, so "./executor.ts" is the same module.
  const specifier = (raw: string): string => raw.replace(/\.ts$/, "");
  const PORT = ["./executor", "./control-adapter"];
  // Every import of the two specifiers that carry the executor, as written.
  const portImportsOf = (text: string): string[] =>
    [...text.matchAll(/^import\s+([^;]*?)\s+from\s*["']([^"']+)["']/gm)]
      .filter((match) => PORT.includes(specifier(match[2]!)))
      .map((match) => match[1]!);
  // The names those imports bind, with any `type` modifier and alias dropped.
  const execImportsOf = (text: string): string[] =>
    portImportsOf(text)
      .flatMap((clause) => (/\{([^}]*)\}/.exec(clause)?.[1] ?? "").split(","))
      .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter((name) => name.length > 0);
  // A `*Invocation(` call builds an argv for an executor; `RegExp.prototype.exec`
  // and a local `guarded` helper are not, which is why the rules are name-based.
  const INVOCATION_CALL = /\b\w+Invocation\s*\(/;

  it("classifies every command-path module as a non-adapter", () => {
    // Named, so renaming one into the `-adapter.ts` exemption fails here.
    for (const name of [
      "dispatch.ts",
      "lifecycle.ts",
      "interrupt.ts",
      "agents.ts",
      "chat-handback.ts",
      "chat-fix.ts",
      "onboarding.ts",
      "control-routes.ts",
      "lifecycle-routes.ts",
      "chat-routes.ts",
      "doctor-routes.ts",
      "agents-routes.ts",
      "onboarding-routes.ts",
    ]) {
      expect(modules, name).toContain(name);
      expect(others, name).toContain(name);
    }
  });

  it("parses real port imports, so the patterns cannot pass by matching nothing", () => {
    const importers = modules.filter(isAdapter).filter((name) => execImportsOf(source(name)).includes("guarded"));
    expect(importers.length).toBeGreaterThan(0);
    expect(execImportsOf('import { guarded, type Executor as E } from "./executor.ts";')).toEqual(["guarded", "Executor"]);
    expect(portImportsOf('import * as port from "./control-adapter";')).toEqual(["* as port"]);
  });

  it("lets the composition root construct executors only for the composition's `executor:`", () => {
    const text = source(ROOT);
    expect(execImportsOf(text).sort(), ROOT).toEqual(["ControlStatusRead", "createProcessExecutor"]);
    expect(portImportsOf(text).every((clause) => clause.startsWith("{")), ROOT).toBe(true);
    const code = codeOf(text);
    expect(code, ROOT).not.toMatch(INVOCATION_CALL);
    // The root builds executors in one place: the `executor:` dependency it
    // hands `composeServer`, which returns each without calling it.
    expect(code.match(/createProcessExecutor\s*\(/g), ROOT).toHaveLength(1);
    const factory = /executor:\s*\(timeoutMs\)\s*=>\s*\{([\s\S]*?)\n\s*\},/.exec(code)?.[1];
    expect(factory, ROOT).toMatch(/createProcessExecutor\s*\(/);
    expect(factory, ROOT).toMatch(/return built;\s*$/);
    expect(code, ROOT).not.toMatch(/\bbuilt\s*\(/);
  });

  it("lets the composition hand each executor it is given to an adapter as `exec:`, and nothing else", () => {
    const text = source(COMPOSITION);
    // The port for its type alone; the control adapter for a type and its factory.
    expect(execImportsOf(text).sort(), COMPOSITION).toEqual(["ControlStatusRead", "Executor", "createRalphControlAdapter"]);
    expect(
      portImportsOf(text).filter((clause) => /\bExecutor\b/.test(clause)),
      COMPOSITION,
    ).toEqual(["type { Executor }"]);
    const code = codeOf(text);
    expect(code, COMPOSITION).not.toMatch(INVOCATION_CALL);
    // Its own `guarded` is the passes' try/catch, not the port's; the import
    // check above is what keeps the port's out.
    expect(code, COMPOSITION).not.toMatch(/\bcreateProcessExecutor\b/);
    // Every executor comes from `deps.executor(...)`, bound once, and is named
    // after that only as an adapter factory's `exec:`.
    const built = [...code.matchAll(/\bconst\s+(\w+)\s*=\s*deps\.executor\s*\(/g)].map((match) => match[1]!);
    expect(built.length, COMPOSITION).toBeGreaterThan(0);
    expect(code.match(/deps\.executor\s*\(/g)!.length, COMPOSITION).toBe(built.length);
    for (const binding of built) {
      const uses = [...code.matchAll(new RegExp(String.raw`(.{0,6})\b${binding}\b(?!\s*=)`, "g"))].map((match) => match[1]!);
      expect(uses.filter((before) => !/exec:\s*$/.test(before)), `${COMPOSITION}: ${binding}`).toEqual([]);
    }
  });

  it("keeps the executor out of every other module", () => {
    for (const name of others) {
      const text = source(name);
      // The port itself is an adapter's to take, in any import form.
      expect(
        [...text.matchAll(IMPORTS)].map((match) => specifier(match[1]!)),
        name,
      ).not.toContain("./executor");
      // control-adapter is imported for its types; a namespace import would
      // reach its re-exported `guarded` and `createProcessExecutor` unnamed.
      expect(portImportsOf(text).filter((clause) => !clause.replace(/^type\s+/, "").startsWith("{")), name).toEqual([]);
      expect(execImportsOf(text).filter((imported) => EXEC_NAMES.includes(imported)), name).toEqual([]);
      const code = codeOf(text);
      expect(code, name).not.toMatch(INVOCATION_CALL);
      expect(code, name).not.toMatch(/\b(?:Executor|createProcessExecutor)\b/);
    }
  });
});
