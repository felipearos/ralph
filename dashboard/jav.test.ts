// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { validateJav } from "../jav";
import { subprocessSuite } from "../test-timeouts";
import type { JavView } from "./contracts";
import { strandedLabels } from "./ui/jav-model";
import { createJavAdapter, JavError, narrowJavConfig, narrowJavView, type JavAdapter } from "./jav-adapter";
import { handleJavRoute } from "./jav-routes";
import { writeProjectConfig } from "./fixtures";
import { createRecordingExecutor } from "./recording-executor";

// The real-adapter cases below run `bun jav.ts`.
subprocessSuite("bun jav.ts");

const view: JavView = {
  path: "/h/jav.json",
  exists: true,
  project: "loggd",
  own: true,
  config: { enabled: true, labels: ["difficulty:hard"], routes: { ralph: ["difficulty:hard"] } },
  problems: [],
  loops: ["ralph", "rafa"],
  reserved: ["ready-for-agent"],
};

const fake = (overrides: Partial<JavAdapter> = {}): JavAdapter => ({
  read: vi.fn(async () => view),
  save: vi.fn(async () => ({ valid: true, problems: [] })),
  ...overrides,
});

const request = (path: string, init?: RequestInit) => new Request(`http://127.0.0.1${path}`, init);

describe("jav routes", () => {
  it("serves the read on GET and leaves other paths alone", async () => {
    const jav = fake();
    const response = await handleJavRoute(request("/api/jav"), "/api/jav", jav);
    expect(await response?.json()).toEqual(view);
    expect(await handleJavRoute(request("/api/loops"), "/api/loops", jav)).toBeNull();
  });

  it("saves the posted config, and answers 400 with every problem when refused", async () => {
    const save = vi.fn(async () => ({ valid: false, problems: ["a", "b"] }));
    const response = await handleJavRoute(
      request("/api/jav/save", { method: "POST", body: JSON.stringify({ config: { enabled: true } }) }),
      "/api/jav/save",
      fake({ save }),
    );
    expect(save).toHaveBeenCalledWith({ enabled: true });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "JavInvalid", message: "the routing was refused", valid: false, problems: ["a", "b"] });
  });

  it("refuses the wrong method and a body without a config, never reaching the adapter", async () => {
    const jav = fake();
    expect((await handleJavRoute(request("/api/jav", { method: "POST" }), "/api/jav", jav))?.status).toBe(405);
    expect((await handleJavRoute(request("/api/jav/save"), "/api/jav/save", jav))?.status).toBe(405);
    const bad = await handleJavRoute(request("/api/jav/save", { method: "POST", body: "{}" }), "/api/jav/save", jav);
    expect(bad?.status).toBe(400);
    expect(jav.save).not.toHaveBeenCalled();
  });
});

describe("narrowing", () => {
  it("keeps what it can of an invalid file, so the page can fix it", () => {
    expect(narrowJavConfig({ enabled: "yes", labels: ["a", 1], routes: { ralph: ["a"], rafa: "a" } })).toEqual({
      enabled: false,
      labels: [],
      routes: { ralph: ["a"] },
    });
  });

  it("refuses a report that is not the contract", () => {
    expect(() => narrowJavView({ path: "/x" })).toThrow(JavError);
  });
});

describe("the adapter over an injected executor", () => {
  const project = { id: "loggd", root: "/w/loggd" };
  const javOf = (exec: ReturnType<typeof createRecordingExecutor>) =>
    createJavAdapter({ cliDir: "/h", bunPath: "/bin/bun", project, exec: exec.exec });

  it("reads through `bun jav.ts --json` with the project in the environment", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/jav.ts", "--json"] }, { status: 0, stdout: JSON.stringify(view), stderr: "" });
    expect(await javOf(recorder).read()).toEqual(view);
    expect(recorder.calls).toHaveLength(1);
    const { invocation } = recorder.calls[0]!;
    expect(invocation).toMatchObject({ command: "/bin/bun", args: ["/h/jav.ts", "--json"], cwd: "/h", timeoutMs: 20_000 });
    expect(invocation.env).toMatchObject({ RALPH_PROJECT: "/w/loggd", RALPH_PROJECT_ID: "loggd" });
  });

  it("throws a JavError naming the failure when the read fails", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/jav.ts"] }, { status: 1, stdout: "", stderr: " no roster \n" });
    const error = await javOf(recorder).read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JavError);
    expect((error as Error).message).toBe("jav.ts --json failed: no roster");
  });

  it("throws a JavError quoting stdout when the read is not JSON", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/jav.ts"] }, { status: 0, stdout: "oops\n", stderr: "" });
    const error = await javOf(recorder).read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JavError);
    expect((error as Error).message).toBe("jav.ts --json did not print JSON: oops");
  });

  it("throws the narrow's JavError when the read is the wrong shape", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/jav.ts"] }, { status: 0, stdout: "{}", stderr: "" });
    const error = await javOf(recorder).read().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JavError);
    expect((error as Error).message).toMatch(/^jav\.ts --json printed an unexpected shape/);
  });

  it("saves with the candidate on stdin, and reads back its result", async () => {
    const recorder = createRecordingExecutor().on({ args: ["/h/jav.ts", "--save"] }, { status: 0, stdout: JSON.stringify({ valid: false, problems: ["x"] }), stderr: "" });
    const config = { enabled: true, labels: [], routes: {} };
    expect(await javOf(recorder).save(config)).toEqual({ valid: false, problems: ["x"] });
    const { invocation } = recorder.calls[0]!;
    expect(invocation).toMatchObject({ command: "/bin/bun", args: ["/h/jav.ts", "--save"], cwd: "/h", timeoutMs: 20_000 });
    expect(JSON.parse(invocation.input ?? "")).toEqual(config);
    expect(invocation.env).toMatchObject({ RALPH_PROJECT: "/w/loggd", RALPH_PROJECT_ID: "loggd" });
  });

  it("throws a JavError when the save fails or does not print JSON", async () => {
    const failed = createRecordingExecutor().on({ args: ["/h/jav.ts", "--save"] }, { status: 2, stdout: "", stderr: "boom\n" });
    await expect(javOf(failed).save({})).rejects.toThrow(new JavError("jav.ts --save failed: boom"));
    const garbled = createRecordingExecutor().on({ args: ["/h/jav.ts", "--save"] }, { status: 0, stdout: "nope", stderr: "" });
    await expect(javOf(garbled).save({})).rejects.toThrow(new JavError("jav.ts --save did not print JSON: nope"));
  });
});

describe("the adapter against the real jav.ts", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("offers the page only coders as route targets, over a mixed roster", async () => {
    // #144 made `routableLoops` the fence; this pins that the dashboard's own
    // read carries it, so the page cannot list a triager as a route target
    // however the roster is written (#147 AC 3).
    dir = mkdtempSync(join(tmpdir(), "jav-roles-"));
    const path = join(dir, "jav.json");
    const root = join(dir, "mixed");
    writeProjectConfig(root, ["ralph", { name: "tria", role: "triager" }, { name: "doc", role: "ci-doctor" }, "rafa"]);
    writeFileSync(path, JSON.stringify({}));
    const previous = process.env.RALPH_JAV;
    process.env.RALPH_JAV = path;
    try {
      const adapter = createJavAdapter({ cliDir: dirname(__dirname), bunPath: "bun", project: { id: "mixed", root } });
      const read = await adapter.read();
      expect(read.loops).toEqual(["ralph", "rafa"]);
      // The claim labels of every role are still reserved, roster-wide: a
      // difficulty label may not collide with a non-coder's claim either.
      expect(read.reserved).toContain("tria-wip");
      expect(read.reserved).toContain("doc-wip");
    } finally {
      if (previous === undefined) delete process.env.RALPH_JAV;
      else process.env.RALPH_JAV = previous;
    }
  });

  it("reads, refuses and saves one project's block through the CLI", async () => {
    dir = mkdtempSync(join(tmpdir(), "jav-adapter-"));
    const path = join(dir, "jav.json");
    const root = join(dir, "other");
    writeProjectConfig(root, ["nova", "vera"]);
    const loggd = { enabled: true, labels: ["difficulty:hard"], routes: { ralph: ["difficulty:hard"] } };
    writeFileSync(path, JSON.stringify({ loggd }));
    const previous = process.env.RALPH_JAV;
    process.env.RALPH_JAV = path;
    try {
      const adapter = createJavAdapter({ cliDir: dirname(__dirname), bunPath: "bun", project: { id: "other", root } });
      const read = await adapter.read();
      expect(read).toMatchObject({ project: "other", own: false, loops: ["nova", "vera"] });
      expect(read.config.enabled).toBe(false);

      // Judged against this project's roster, not another project's.
      const refused = await adapter.save({ enabled: true, labels: ["difficulty:hard"], routes: { ralph: ["difficulty:hard"] } });
      expect(refused.valid).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ loggd });

      const config = { enabled: true, labels: ["difficulty:hard"], routes: { nova: ["difficulty:hard"] } };
      expect(await adapter.save(config)).toEqual({ valid: true, problems: [] });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ loggd, other: config });
      expect((await adapter.read()).own).toBe(true);

      writeFileSync(path, "{");
      expect((await adapter.read()).problems[0]).toMatch(/not valid JSON/);
    } finally {
      if (previous === undefined) delete process.env.RALPH_JAV;
      else process.env.RALPH_JAV = previous;
    }
  }, 30_000);
});

/**
 * The page's warning and the save's refusal read the same rule. They are two
 * implementations — the page cannot import `jav.ts`'s validator, which reads the
 * file — so the config where they could diverge is pinned here.
 */
describe("the stranded-label warning and the validator", () => {
  it("agree about a `default` route nobody falls back to", () => {
    // Every routable loop has a route of its own, so `default` is reached only by
    // loops the page does not list — which take no frontier work.
    const config = {
      enabled: true,
      labels: ["difficulty:easy", "difficulty:hard"],
      routes: { ralph: ["difficulty:hard"], rafa: ["difficulty:hard"], default: ["difficulty:easy"] },
    };
    expect(strandedLabels(config, ["ralph", "rafa"])).toEqual(["difficulty:easy"]);
    expect(validateJav(config, ["ralph", "rafa"]).problems).toEqual([
      "no loop takes 'difficulty:easy', so its tickets would never be picked",
    ]);
  });

  it("agree when a routable loop does fall back to `default`", () => {
    const config = {
      enabled: true,
      labels: ["difficulty:easy", "difficulty:hard"],
      routes: { ralph: ["difficulty:hard"], default: ["difficulty:easy"] },
    };
    expect(strandedLabels(config, ["ralph", "rafa"])).toEqual([]);
    expect(validateJav(config, ["ralph", "rafa"]).problems).toEqual([]);
  });
});
