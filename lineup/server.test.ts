// @vitest-environment node
/**
 * HTTP is exercised against the actual Bun server, spawned as a subprocess and
 * bound to an ephemeral localhost port, then driven with `fetch`. That is the
 * only way to prove the Bun entrypoint works — vitest runs under Node, where
 * `Bun.serve` does not exist — and it keeps the assertions on observable
 * responses rather than on a handler called in-process.
 *
 * The properties: `GET /api/lineup` reads the current file and the resolved
 * lineup with source tags and the runtime schema; `POST /api/lineup/preview`
 * re-resolves a candidate without writing; `POST /api/lineup/save` refuses an
 * invalid candidate with the resolver's complete problem list and leaves the
 * file untouched, and commits a valid one; an environment override yields a
 * shadow naming the exact variable; and the server is loopback-only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { JsonObject } from "./contracts";
import { block, bunPath, cleanupFixtures, config, rootWith } from "./fixtures";
import {
  buildChange,
  createLineupClient,
  draftFor,
  draftProblems,
  loopNames,
  previewRows,
} from "./static/lineup-view.js";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("starts the lineup server under bun");

const REPO_ROOT = join(__dirname, "..");
const CLI = join(REPO_ROOT, "models.ts");
const SERVER = join(REPO_ROOT, "lineup", "server.ts");

const children: ChildProcess[] = [];
afterAll(() => {
  children.forEach((child) => child.kill("SIGKILL"));
  cleanupFixtures();
});

interface RunningServer {
  base: string;
  stop: () => void;
}

function startServer(env: Record<string, string | undefined>): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunPath(), [SERVER], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
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
        resolve({ base: match[1]!, stop: () => child.kill("SIGKILL") });
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

const serverFor = (roots: string | string[], env: Record<string, string> = {}) =>
  startServer({
    RALPH_LINEUP_PORT: "0",
    RALPH_LINEUP_ROOTS: Array.isArray(roots) ? roots.join(",") : roots,
    PATH: process.env.PATH,
    ...env,
  });

const post = (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the lineup editor over HTTP", () => {
  it("reads the current file, the resolved lineup, the rules, and the shadows", async () => {
    const root = rootWith();
    const server = await serverFor(root, { RALPH_LOOP_NAME: "rafa" });
    try {
      const response = await fetch(`${server.base}/api/lineup`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        root: string;
        loop: string;
        config: JsonObject;
        resolved: { loop: string; stages: Record<string, { model: string; source: string }> };
        schema: { stages: string[]; runnersFor: Record<string, string[]>; aliases: string[] };
        shadows: unknown[];
      };
      expect(body.root).toBe(root);
      expect(body.loop).toBe("rafa");
      expect(body.config).toEqual({ default: config().default });
      expect(body.resolved.stages.mapper).toMatchObject({ model: "sonnet", source: "default" });
      expect(body.schema.runnersFor.orchestrator).toEqual(["claude", "codex"]);
      expect(body.schema.aliases).toContain("opus");
      expect(body.shadows).toEqual([]);
    } finally {
      server.stop();
    }
  });

  it("carries a caller-supplied role through to the rules it serves (#147)", async () => {
    // The dashboard sends `?role=` because the resolver cannot read the
    // project's roster from a harness checkout. Without it the same loop comes
    // back as a coder, with two stages it never runs. `sift`, not `tria`: this
    // checkout's own roster names a `tria` triager.
    const root = rootWith();
    const server = await serverFor(root, { RALPH_LOOP_NAME: "sift" });
    try {
      const stagesOf = async (query: string): Promise<string[]> => {
        const response = await fetch(`${server.base}/api/lineup${query}`);
        expect(response.status).toBe(200);
        return ((await response.json()) as { schema: { stages: string[] } }).schema.stages;
      };
      expect(await stagesOf("?role=triager")).toEqual(["orchestrator", "mapper", "review.spec"]);
      expect(await stagesOf("")).toEqual(["orchestrator", "executor", "mapper", "review.standards", "review.spec", "review.correctness"]);
    } finally {
      server.stop();
    }
  });

  it("serves the configured roots", async () => {
    const first = rootWith();
    const second = rootWith();
    const server = await serverFor([first, second]);
    try {
      const body = (await (await fetch(`${server.base}/api/roots`)).json()) as { roots: string[] };
      expect(body.roots).toEqual([first, second]);
    } finally {
      server.stop();
    }
  });

  it("names the exact overriding variable when the environment shadows a stage", async () => {
    const root = rootWith();
    const server = await serverFor(root, {
      RALPH_MODEL_MAPPER: "haiku",
      RALPH_MODEL_ORCHESTRATOR_EFFORT: "high",
    });
    try {
      const body = (await (await fetch(`${server.base}/api/lineup`)).json()) as {
        resolved: { stages: Record<string, { model: string; source: string; effort?: string }> };
        shadows: { stage: string; field: string; variable: string }[];
      };
      expect(body.resolved.stages.mapper).toMatchObject({ model: "haiku", source: "env" });
      expect(body.shadows).toContainEqual({
        stage: "mapper",
        field: "model",
        variable: "RALPH_MODEL_MAPPER",
      });
      expect(body.shadows).toContainEqual({
        stage: "orchestrator",
        field: "effort",
        variable: "RALPH_MODEL_ORCHESTRATOR_EFFORT",
      });
    } finally {
      server.stop();
    }
  });

  it("previews a candidate without writing it", async () => {
    const root = rootWith();
    const before = readFileSync(join(root, "models.json"), "utf8");
    const server = await serverFor(root);
    try {
      const candidate = config();
      ((candidate.default as JsonObject).executor as JsonObject).model = "claude-haiku-4-5";
      const response = await post(server.base, "/api/lineup/preview", { loop: "ralph", config: candidate });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        valid: boolean;
        problems: string[];
        resolved: { stages: Record<string, { model: string; source: string }> } | null;
        schema: { runnersFor: Record<string, string[]>; aliases: string[]; modelId: { pattern: string } };
      };
      expect(body.valid).toBe(true);
      expect(body.resolved?.stages.executor).toMatchObject({ model: "claude-haiku-4-5", source: "project" });
      // The form's constraints travel with the preview, straight from `--schema`.
      expect(body.schema.runnersFor.orchestrator).toEqual(["claude", "codex"]);
      expect(body.schema.aliases).toContain("sonnet");
      expect(body.schema.modelId.pattern).toBeTypeOf("string");
      expect(readFileSync(join(root, "models.json"), "utf8")).toBe(before);
    } finally {
      server.stop();
    }
  });

  it("returns the complete problem list on an invalid preview", async () => {
    const root = rootWith();
    const server = await serverFor(root);
    try {
      const candidate = config();
      const defaultBlock = candidate.default as JsonObject;
      defaultBlock.orchestrator = { runner: "codex", model: "openai/gpt-5.6-terra" };
      defaultBlock.executor = { runner: "opencode", model: "opus" };

      const response = await post(server.base, "/api/lineup/preview", { config: candidate });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { valid: boolean; problems: string[]; resolved: unknown };
      expect(body.valid).toBe(false);
      expect(body.problems).toHaveLength(2);
      expect(body.resolved).toBeNull();
    } finally {
      server.stop();
    }
  });

  it("saves a valid candidate and refuses an invalid one without writing", async () => {
    const root = rootWith();
    const before = readFileSync(join(root, "models.json"), "utf8");
    const server = await serverFor(root);
    try {
      const valid = config();
      ((valid.default as JsonObject).executor as JsonObject).model = "claude-haiku-4-5";
      const saved = await post(server.base, "/api/lineup/save", { loop: "ralph", config: valid });
      expect(saved.status).toBe(200);
      const written = readFileSync(join(root, "models.json"), "utf8");
      expect(written).not.toBe(before);
      expect(JSON.parse(written)).toMatchObject({
        $comment: config().$comment,
        default: config().default,
        loggd: { default: { executor: { model: "claude-haiku-4-5" } } },
      });

      const invalid = config();
      (invalid.default as JsonObject).orchestrator = { runner: "opencode", model: "gpt-5.6-terra" };
      (invalid.default as JsonObject).executor = { runner: "opencode", model: "opus" };
      const refused = await post(server.base, "/api/lineup/save", { config: invalid });
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as { error: string; valid: boolean; problems: string[] };
      expect(body.valid).toBe(false);
      // The refusal shape the dashboard's command module reads its problems from.
      expect(body.error).toBe("LineupInvalid");
      // The complete list, not the first failure.
      expect(body.problems).toHaveLength(2);
      expect(body.problems.join("\n")).toMatch(/cannot run 'orchestrator'/);
      expect(readFileSync(join(root, "models.json"), "utf8")).toBe(written);
    } finally {
      server.stop();
    }
  });

  it("rejects a bad request body as a client error", async () => {
    const root = rootWith();
    const server = await serverFor(root);
    try {
      expect((await fetch(`${server.base}/api/lineup/preview`, { method: "POST", body: "{bad" })).status).toBe(400);
      expect((await post(server.base, "/api/lineup/preview", { config: 5 })).status).toBe(400);
      expect((await post(server.base, "/api/lineup/preview", { root: "/not/configured", config: config() })).status).toBe(400);
    } finally {
      server.stop();
    }
  });

  it("routes, methods and unknown roots are refused", async () => {
    const root = rootWith();
    const server = await serverFor(root);
    try {
      expect((await fetch(`${server.base}/api/nope`)).status).toBe(404);
      expect((await fetch(`${server.base}/api/lineup`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${server.base}/api/lineup/preview`)).status).toBe(405);
    } finally {
      server.stop();
    }
  });

  it("surfaces the resolver's restore guidance through HTTP", async () => {
    const root = rootWith();
    rmSync(join(root, "models.json"));
    const server = await serverFor(root);
    try {
      const response = await fetch(`${server.base}/api/lineup`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("LineupRefusedError");
      expect(body.message).toContain(`Restore it from git: git -C ${root} checkout -- models.json`);
    } finally {
      server.stop();
    }
  });

  it("surfaces the resolver's wording for a malformed file through HTTP", async () => {
    const root = rootWith('{ "default": ');
    const server = await serverFor(root);
    try {
      const response = await fetch(`${server.base}/api/lineup`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe("LineupRefusedError");
      expect(body.message).toContain(`${join(root, "models.json")} is not valid JSON`);
    } finally {
      server.stop();
    }
  });

  it("stays loopback-only", async () => {
    const root = rootWith();
    const server = await serverFor(root);
    try {
      expect(new URL(server.base).hostname).toBe("127.0.0.1");
    } finally {
      server.stop();
    }
  });
});

describe("the static front-end", () => {
  it("serves the page and its helper module with no build step", async () => {
    const server = await serverFor(rootWith());
    try {
      const shell = await fetch(`${server.base}/`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-type")).toContain("text/html");
      expect(await shell.text()).toContain('from "./lineup-view.js"');

      const helpers = await fetch(`${server.base}/lineup-view.js`);
      expect(helpers.status).toBe(200);
      expect(helpers.headers.get("content-type")).toContain("text/javascript");
      expect(await helpers.text()).toContain("export function createLineupClient");

      expect((await fetch(`${server.base}/`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${server.base}/lineup-view.d.ts`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

describe("the page's client against the real server", () => {
  const stageOf = (candidate: JsonObject, loop: string, stage: string): JsonObject => {
    let node: unknown = candidate[loop];
    for (const part of stage.split(".")) node = (node as JsonObject)[part];
    return node as JsonObject;
  };

  it("loads every loop and every stage from the current file", async () => {
    const root = rootWith(JSON.stringify(config({ ralph: block(), rafa: block(), remo: block() }), null, 2) + "\n");
    const server = await serverFor(root);
    try {
      const client = createLineupClient(fetch, server.base);
      const read = await client.read({ loop: "rafa" });
      expect(loopNames(read.config)).toEqual(["default", "ralph", "rafa", "remo"]);
      expect(previewRows(read.schema, read.resolved, read.shadows).map((row) => row.stage)).toEqual(read.schema.stages);
    } finally {
      server.stop();
    }
  });

  it("switches runner and model in one edit and re-resolves the preview", async () => {
    const server = await serverFor(rootWith());
    try {
      const client = createLineupClient(fetch, server.base);
      const read = await client.read({ loop: "remo" });
      const draft = { ...draftFor(read.config, "remo", "mapper"), runner: "codex", model: "gpt-5.6-terra" };
      expect(draftProblems(read.schema, "mapper", draft)).toEqual([]);

      const edited = await client.edit({
        loop: "remo",
        config: read.config,
        edit: { kind: "stage", stage: "mapper", change: buildChange(read.schema, "mapper", draft) },
      });
      expect(edited.valid).toBe(true);
      // A complete block, built from default for the rest. `review.correctness`
      // is the exception: this default does not name it, so the block leaves it
      // out too and it resolves to its built-in default.
      for (const stage of read.schema.stages.filter((stage) => stage !== "review.correctness")) {
        expect(stageOf(edited.config, "remo", stage).runner).toBeTypeOf("string");
      }
      expect(edited.resolved?.stages["review.correctness"]).toMatchObject({ runner: "claude", source: "default" });
      expect(edited.resolved?.stages.mapper).toMatchObject({ runner: "codex", model: "gpt-5.6-terra", source: "loop" });
    } finally {
      server.stop();
    }
  });

  it("removes a loop block so the preview falls back to default", async () => {
    const root = rootWith(JSON.stringify(config({ rafa: block() }), null, 2) + "\n");
    const server = await serverFor(root);
    try {
      const client = createLineupClient(fetch, server.base);
      const read = await client.read({ loop: "rafa" });
      expect(read.resolved.stages.mapper!.source).toBe("loop");
      const removed = await client.edit({ loop: "rafa", config: read.config, edit: { kind: "remove" } });
      expect(removed.config).not.toHaveProperty("rafa");
      expect(removed.resolved?.stages.mapper!.source).toBe("default");
    } finally {
      server.stop();
    }
  });

  it("shows every problem and refuses to save an invalid candidate", async () => {
    const root = rootWith();
    const before = readFileSync(join(root, "models.json"), "utf8");
    const server = await serverFor(root);
    try {
      const client = createLineupClient(fetch, server.base);
      const read = await client.read();
      const first = await client.edit({
        loop: "default",
        config: read.config,
        edit: { kind: "stage", stage: "executor", change: { runner: "opencode", model: "opus" } },
      });
      const second = await client.edit({
        loop: "default",
        config: first.config,
        edit: { kind: "stage", stage: "review.spec", change: { runner: "codex", model: "openai/x" } },
      });
      expect(second.valid).toBe(false);
      expect(second.problems).toHaveLength(2);
      const saved = await client.save({ config: second.config });
      expect(saved).toMatchObject({ valid: false, problems: second.problems });
      expect(readFileSync(join(root, "models.json"), "utf8")).toBe(before);
    } finally {
      server.stop();
    }
  });

  it("names the overriding variable in the preview of an env-sourced stage", async () => {
    const server = await serverFor(rootWith(), { RALPH_RUNNER_REVIEW_SPEC: "opencode", RALPH_MODEL_REVIEW_SPEC: "a/b" });
    try {
      const client = createLineupClient(fetch, server.base);
      const read = await client.read();
      const row = previewRows(read.schema, read.resolved, read.shadows).find((entry) => entry.stage === "review.spec");
      expect(row?.source).toBe("env");
      expect(row?.overrides.map((shadow) => shadow.variable).sort()).toEqual([
        "RALPH_MODEL_REVIEW_SPEC",
        "RALPH_RUNNER_REVIEW_SPEC",
      ]);
    } finally {
      server.stop();
    }
  });

  it("refuses a malformed edit as a client error", async () => {
    const server = await serverFor(rootWith());
    try {
      const client = createLineupClient(fetch, server.base);
      const failure = await client
        .edit({ loop: "default", config: config(), edit: { kind: "remove" } })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 400, kind: "LineupRequestError" });
      expect((await post(server.base, "/api/lineup/edit", { config: config(), edit: { kind: "nope" } })).status).toBe(400);
      expect(
        (await post(server.base, "/api/lineup/edit", {
          loop: "ralph",
          config: config(),
          edit: { kind: "stage", stage: "executer", change: {} },
        })).status,
      ).toBe(400);
    } finally {
      server.stop();
    }
  });
});

describe("the CLI the adapter drives", () => {
  it("is the sibling models.ts, not a copy", () => {
    // A guard against the adapter drifting onto another command: the file the
    // tests drive is the resolver the supervisor runs.
    expect(readFileSync(CLI, "utf8")).toContain("export function schemaJson");
  });
});
