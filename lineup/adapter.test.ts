// @vitest-environment node
/**
 * The runtime adapter, driven against the real `ralph/models.ts` CLI.
 *
 * Nothing here imports the resolver; every rule is asserted by handing the
 * adapter a temporary checkout root and reading what the CLI actually prints.
 * That pins the JSON contract the editor depends on, so a change to the CLI's
 * output shape fails a test instead of silently drifting into a wrong form.
 *
 * The adapter is also proven to fail loudly: a fake `bun` that prints a renamed
 * or malformed field must raise `LineupContractError`, never a coerced view
 * model, and a resolver that refuses the file must surface its own message.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  COMMAND_SURFACE,
  LOOP_ENV,
  LineupContractError,
  LineupRefusedError,
  LineupRequestError,
  computeShadows,
  createLineupAdapter,
  narrowResolved,
  narrowSchema,
  narrowValidation,
} from "./adapter";
import type { JsonObject, ResolvedLineup } from "./contracts";
import { projectView } from "../lineup-editor";
import { createHandler } from "./server";
import { block, bunPath, cleanupFixtures, config, rootWith } from "./fixtures";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("runs the lineup CLIs under bun");

const RALPH_HOME = join(__dirname, "..");
const CLI = join(RALPH_HOME, "models.ts");
const BUN = bunPath();

const scratchRoots: string[] = [];
afterAll(() => {
  cleanupFixtures();
  scratchRoots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/**
 * The runner's own environment may carry a RALPH_* one-off; these tests pin
 * what the fixture says unless they set one deliberately.
 */
const cleanEnv = (env: Record<string, string> = {}): Record<string, string | undefined> => {
  const clean: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("RALPH_")) delete clean[key];
  return { ...clean, ...env };
};

const adapterFor = (roots: string[], env: Record<string, string> = {}) =>
  createLineupAdapter({ cliDir: RALPH_HOME, roots, bunPath: BUN, env: cleanEnv(env) });

/** What `bun models.ts --json <path>` itself prints on refusal, minus its `models: ` tag. */
const resolverRefusal = (path: string): string => {
  try {
    execFileSync(BUN, [CLI, "--json", path], { encoding: "utf8", env: cleanEnv(), stdio: "pipe" });
  } catch (error) {
    return (error as { stderr: string }).stderr.trim().replace(/^models:\s*/, "");
  }
  throw new Error(`models.ts --json ${path} did not refuse`);
};

describe("the adapter's command surface", () => {
  it("is the models.ts flags, the harness catalogue and the model-updates report and answer", () => {
    expect(Object.values(COMMAND_SURFACE).map((spec) => `${spec.script} ${spec.flag}`).sort()).toEqual([
      "harness-catalog.ts --json",
      "model-updates.ts --answer",
      "model-updates.ts --json",
      "models.ts --json",
      "models.ts --migrate",
      "models.ts --schema",
      "models.ts --validate",
    ]);
  });
});

describe("read", () => {
  it("returns the file, the resolved lineup with sources, and the rules", async () => {
    const adapter = adapterFor([rootWith()]);
    const read = await adapter.read();

    expect(read.loop).toBe("ralph");
    expect(read.project).toBe("loggd");
    // The project's view: the default its loops fall back to, and its own blocks.
    expect(read.config).toEqual({ default: config().default });
    expect(read.resolved.loop).toBe("ralph");
    expect(read.resolved.stages).toMatchObject({
      orchestrator: { model: "claude-opus-5", runner: "claude", effort: "medium", source: "default" },
      "review.spec": { model: "opus", runner: "claude", source: "default" },
    });
    expect(read.schema.stages).toEqual([
      "orchestrator",
      "executor",
      "mapper",
      "review.standards",
      "review.spec",
      "review.correctness",
    ]);
    expect(read.schema.aliases).toContain("opus");
    expect(read.schema.runnersFor.orchestrator).toEqual(["claude", "codex"]);
    expect(read.schema.modelId.pattern).toBeTypeOf("string");
    expect(read.schema.modelId.providerPrefix.opencode).toBe("required");
    expect(read.shadows).toEqual([]);
  });

  it("resolves a named loop and tags the source as loop", async () => {
    const adapter = adapterFor([rootWith(JSON.stringify(config({ rafa: block() }), null, 2) + "\n")], {
      [LOOP_ENV]: "rafa",
    });
    const read = await adapter.read({ loop: "rafa" });

    expect(read.loop).toBe("rafa");
    expect(read.resolved.stages.mapper).toMatchObject({ model: "sonnet", source: "loop" });
  });

  it("works from any cwd and picks the root from the configured list", async () => {
    const first = rootWith();
    const second = rootWith(
      JSON.stringify(config({ default: { ...block(), executor: { runner: "claude", model: "claude-haiku-4-5" } } }), null, 2) + "\n",
    );
    const adapter = adapterFor([first, second]);

    const byPath = await adapter.read({ root: second });
    expect(byPath.root).toBe(second);
    expect(byPath.resolved.stages.executor!.model).toBe("claude-haiku-4-5");

    const byIndex = await adapter.read({ root: "0" });
    expect(byIndex.root).toBe(first);
  });

  it("refuses an unconfigured root", async () => {
    const adapter = adapterFor([rootWith()]);
    await expect(adapter.read({ root: "/definitely/not/configured" })).rejects.toThrow(
      LineupRequestError,
    );
  });

  it("surfaces the resolver's own restore guidance for a missing file", async () => {
    const root = rootWith();
    rmSync(join(root, "models.json"));
    const adapter = adapterFor([root]);

    await expect(adapter.read()).rejects.toThrow(LineupRefusedError);
    await expect(adapter.read()).rejects.toThrow(/Restore it from git/);
  });

  it("names the missing root's own repository in the restore guidance", async () => {
    // With more than one configured checkout, the guidance must send the
    // operator to the root whose file is missing, not the first or the harness.
    const good = rootWith();
    const missing = rootWith();
    rmSync(join(missing, "models.json"));
    const adapter = adapterFor([good, missing]);

    await expect(adapter.read({ root: missing })).rejects.toThrow(
      new RegExp(`git -C ${missing} checkout -- models.json`),
    );
  });

  it.each([
    ["a missing file", null],
    ["malformed JSON", '{"default": {"orchestrator": {"runner": "codex"}}'],
    ["a non-object document", "[1, 2]\n"],
    ["a file with no default block", '{ "$comment": ["only commentary"] }\n'],
  ])("surfaces the resolver's exact message for %s", async (_label, contents) => {
    const root = contents === null ? rootWith() : rootWith(contents);
    const path = join(root, "models.json");
    if (contents === null) rmSync(path);
    const adapter = adapterFor([root]);

    const refused = await adapter.read().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LineupRefusedError);
    // Verbatim, not a paraphrase the adapter keeps in step by hand.
    expect((refused as Error).message).toBe(resolverRefusal(path));
  });

  it("asks the resolver for the refusal rather than composing one", async () => {
    // A fake runtime with its own wording proves the message comes from the CLI.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lineup-fakebin-")));
    scratchRoots.push(dir);
    const bin = join(dir, "bun");
    writeFileSync(bin, "#!/bin/sh\necho 'models: the runtime says: restore it your way' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const root = rootWith("not json");
    const adapter = createLineupAdapter({ cliDir: RALPH_HOME, roots: [root], bunPath: bin });

    await expect(adapter.read()).rejects.toThrow("the runtime says: restore it your way");
  });
});

describe("shadowing", () => {
  /** A resolved lineup builder: every stage named, sources chosen per test. */
  const resolvedWith = (
    sources: Record<string, "env" | "loop" | "default">,
  ): ResolvedLineup => ({
    loop: "ralph",
    stages: Object.fromEntries(
      Object.entries(sources).map(([stage, source]) => [stage, { model: "m", runner: "claude", source }]),
    ),
  });

  it("names the exact variable for a model, a runner and the orchestrator effort", () => {
    const shadows = computeShadows(
      {
        RALPH_MODEL_MAPPER: "sonnet",
        RALPH_RUNNER_EXECUTOR: "opencode",
        RALPH_MODEL_ORCHESTRATOR_EFFORT: "high",
      },
      resolvedWith({
        orchestrator: "loop",
        executor: "env",
        mapper: "env",
        "review.standards": "default",
        "review.spec": "default",
      }),
    );

    expect(shadows).toContainEqual({ stage: "mapper", field: "model", variable: "RALPH_MODEL_MAPPER" });
    expect(shadows).toContainEqual({ stage: "executor", field: "runner", variable: "RALPH_RUNNER_EXECUTOR" });
    expect(shadows).toContainEqual({
      stage: "orchestrator",
      field: "effort",
      variable: "RALPH_MODEL_ORCHESTRATOR_EFFORT",
    });
  });

  it("uses the dotted stage's underscore spelling", () => {
    const shadows = computeShadows(
      { RALPH_MODEL_REVIEW_STANDARDS: "opus" },
      resolvedWith({ "review.standards": "env" }),
    );
    expect(shadows).toContainEqual({
      stage: "review.standards",
      field: "model",
      variable: "RALPH_MODEL_REVIEW_STANDARDS",
    });
  });

  it("reports the legacy RALPH_CODER_MODEL only when it is what takes effect", () => {
    const executorEnv = resolvedWith({ executor: "env" });
    expect(computeShadows({ RALPH_CODER_MODEL: "claude-haiku-4-5" }, executorEnv)).toContainEqual({
      stage: "executor",
      field: "model",
      variable: "RALPH_CODER_MODEL",
    });
    // The current name wins; the legacy one is not what shadowed the stage and
    // naming it would send the operator to unset the wrong variable.
    expect(
      computeShadows({ RALPH_MODEL_EXECUTOR: "claude-opus-5", RALPH_CODER_MODEL: "claude-haiku-4-5" }, executorEnv),
    ).toContainEqual({ stage: "executor", field: "model", variable: "RALPH_MODEL_EXECUTOR" });
  });

  it("does not report a model/runner override on a stage the resolver did not tag env", () => {
    // An env var that names the same value the file already has does not move
    // the stage off `default`, so it is not what the operator needs to unset.
    expect(
      computeShadows({ RALPH_MODEL_MAPPER: "sonnet" }, resolvedWith({ mapper: "default" })),
    ).toEqual([]);
  });

  it("reports the effort override even though it does not move the source", () => {
    expect(
      computeShadows(
        { RALPH_MODEL_ORCHESTRATOR_EFFORT: "high" },
        resolvedWith({ orchestrator: "loop" }),
      ),
    ).toEqual([
      { stage: "orchestrator", field: "effort", variable: "RALPH_MODEL_ORCHESTRATOR_EFFORT" },
    ]);
  });

  it("reads the shadows a real read reports, agreeing with the source tags", async () => {
    const adapter = adapterFor([rootWith()], { RALPH_MODEL_MAPPER: "haiku" });
    const read = await adapter.read();
    expect(read.resolved.stages.mapper).toMatchObject({ model: "haiku", source: "env" });
    expect(read.shadows).toContainEqual({ stage: "mapper", field: "model", variable: "RALPH_MODEL_MAPPER" });
  });

  it("names RALPH_RUNNER_<STAGE> and the legacy RALPH_CODER_MODEL from a real read", async () => {
    const env = {
      RALPH_RUNNER_MAPPER: "opencode",
      RALPH_MODEL_MAPPER: "openai/gpt-5.6-terra",
      RALPH_CODER_MODEL: "claude-haiku-4-5",
    };
    const adapter = adapterFor([rootWith()], env);
    const read = await adapter.read();

    expect(read.resolved.stages.mapper).toMatchObject({ runner: "opencode", source: "env" });
    expect(read.resolved.stages.executor).toMatchObject({ model: "claude-haiku-4-5", source: "env" });
    expect(read.shadows).toEqual([
      { stage: "executor", field: "model", variable: "RALPH_CODER_MODEL" },
      { stage: "mapper", field: "model", variable: "RALPH_MODEL_MAPPER" },
      { stage: "mapper", field: "runner", variable: "RALPH_RUNNER_MAPPER" },
    ]);
  });

  it("never modifies the environment it reports on", async () => {
    const before = { ...process.env };
    const env = { RALPH_MODEL_MAPPER: "haiku", RALPH_MODEL_ORCHESTRATOR_EFFORT: "high" };
    const adapter = adapterFor([rootWith()], env);

    await adapter.read();
    await adapter.preview({ config: config() });
    await adapter.save({ config: config() });

    expect(process.env).toEqual(before);
    expect(env).toEqual({ RALPH_MODEL_MAPPER: "haiku", RALPH_MODEL_ORCHESTRATOR_EFFORT: "high" });
  });
});

describe("preview", () => {
  it("re-resolves a valid candidate and agrees with --list", async () => {
    const adapter = adapterFor([rootWith()]);
    const candidate = config();
    ((candidate.default as JsonObject).executor as JsonObject).model = "claude-haiku-4-5";

    const preview = await adapter.preview({ config: candidate });
    expect(preview.valid).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(preview.resolved?.stages.executor!.model).toBe("claude-haiku-4-5");
  });

  it.each(["ralph", "rafa", "remo", "rulo"])(
    "agrees with `bun models.ts --list` for the %s loop",
    async (loop) => {
      // `--list` reads only the harness's own file, so that file is the shared
      // subject: the preview resolves it as a candidate, `--list` off disk.
      const live = JSON.parse(readFileSync(join(RALPH_HOME, "models.json"), "utf8")) as JsonObject;
      const adapter = adapterFor([rootWith()]);
      // The candidate is loggd's view of the live file: its loop blocks, merged
      // back under loggd in the fixture root.
      const preview = await adapter.preview({ project: "loggd", loop, config: projectView(live, "loggd") });
      expect(preview.valid).toBe(true);

      const listed = execFileSync(BUN, [CLI, "--list"], {
        encoding: "utf8",
        env: cleanEnv({ [LOOP_ENV]: loop, RALPH_PROJECT_ID: "loggd" }),
      })
        .trim()
        .split("\n");
      const stages = preview.resolved!.stages;
      expect(Object.keys(stages)).toEqual(listed.map((line) => line.split(/\s+/)[0]));
      for (const line of listed) {
        const match =
          /^(\S+)\s+(\S+)\s+(\S+)(?: \(([^)]*)\))?\s+\[(env|loop|project|default)\]$/.exec(line);
        expect(match, line).not.toBeNull();
        const [, stage, runner, model, notes, source] = match!;
        const note = (key: string) =>
          notes?.split("; ").find((part) => part.startsWith(`${key}: `))?.slice(key.length + 2);
        expect(stages[stage!]).toMatchObject({ runner, model, source });
        expect(stages[stage!]!.effort).toBe(note("effort"));
        expect(stages[stage!]!.fallback).toEqual(note("falls back to")?.split(" → "));
      }
    },
  );

  it("returns the complete problem list and no resolved lineup on reject", async () => {
    const adapter = adapterFor([rootWith()]);
    const candidate = config();
    const defaultBlock = candidate.default as JsonObject;
    defaultBlock.orchestrator = { runner: "codex", model: "openai/gpt-5.6-terra" };
    defaultBlock.executor = { runner: "opencode", model: "opus" };
    defaultBlock.mapper = { runner: "claude", model: "gpt-5.6-terra" };

    const preview = await adapter.preview({ config: candidate });
    expect(preview.valid).toBe(false);
    expect(preview.problems).toHaveLength(3);
    expect(preview.resolved).toBeNull();
  });
});

describe("save", () => {
  it("writes a valid candidate atomically and reloads to it", async () => {
    const root = rootWith();
    const adapter = adapterFor([root]);
    const candidate = config();
    ((candidate.default as JsonObject).executor as JsonObject).model = "claude-haiku-4-5";

    const saved = await adapter.save({ config: candidate });
    expect(saved).toEqual({ root, project: "loggd", loop: "ralph", valid: true, problems: [] });
    // A project's form edits that project's keys: its `default` becomes its
    // own, and the file's `default` — every other project's fallback — stays.
    expect(JSON.parse(readFileSync(join(root, "models.json"), "utf8"))).toMatchObject({
      default: { executor: { model: "claude-sonnet-5" } },
      loggd: { default: { executor: { model: "claude-haiku-4-5" } } },
    });
    expect(readFileSync(join(root, "models.json"), "utf8").endsWith("\n")).toBe(true);
  });

  it("refuses an invalid candidate and leaves the file untouched", async () => {
    const root = rootWith();
    const before = readFileSync(join(root, "models.json"), "utf8");
    const adapter = adapterFor([root]);
    const candidate = config();
    (candidate.default as JsonObject).orchestrator = { runner: "opencode", model: "gpt-5.6-terra" };

    const saved = await adapter.save({ config: candidate });
    expect(saved.valid).toBe(false);
    expect(saved.problems.join("\n")).toMatch(/cannot run 'orchestrator'/);
    expect(readFileSync(join(root, "models.json"), "utf8")).toBe(before);
  });
});

describe("one project's keys", () => {
  const keyedRoot = () =>
    rootWith(
      JSON.stringify(
        config({
          loggd: { ralph: { ...block(), mapper: { runner: "claude", model: "haiku" } } },
          other: { ralph: { ...block(), mapper: { runner: "claude", model: "opus" } } },
        }),
        null,
        2,
      ) + "\n",
    );

  it("reads and resolves the named project's blocks, not another's of the same loop name", async () => {
    const adapter = adapterFor([keyedRoot()]);
    const loggd = await adapter.read({ project: "loggd", loop: "ralph" });
    const other = await adapter.read({ project: "other", loop: "ralph" });
    expect(loggd.resolved.stages.mapper).toMatchObject({ model: "haiku", source: "loop" });
    expect(other.resolved.stages.mapper).toMatchObject({ model: "opus", source: "loop" });
    expect(Object.keys(other.config)).toEqual(["default", "ralph"]);
  });

  it("saves only the project's keys, whatever else the candidate carries", async () => {
    const root = keyedRoot();
    const before = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as JsonObject;
    const adapter = adapterFor([root]);
    const view = (await adapter.read({ project: "other", loop: "rafa" })).config;
    const edited = await adapter.edit({ project: "other", loop: "rafa", config: view, edit: { kind: "create" } });
    // A page cannot smuggle a write to another project through its candidate.
    const saved = await adapter.save({ project: "other", loop: "rafa", config: { ...edited.config, loggd: block() } });
    expect(saved.valid).toBe(true);
    const after = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as JsonObject;
    expect(after.loggd).toEqual(before.loggd);
    expect(after.default).toEqual(before.default);
    expect(Object.keys(after.other as JsonObject)).toEqual(["ralph", "rafa", "loggd"]);
  });

  it("is pinned per handler: a request cannot name another project", async () => {
    const root = keyedRoot();
    const handler = createHandler({ adapter: adapterFor([root]), project: "other" });
    const response = await handler(new Request("http://127.0.0.1/api/lineup?project=loggd&loop=ralph"));
    const body = (await response.json()) as { project: string; resolved: ResolvedLineup };
    expect(body.project).toBe("other");
    expect(body.resolved.stages.mapper).toMatchObject({ model: "opus" });
  });
});

describe("edit", () => {
  it("saves and reloads per-fallback Codex effort, then clears it when the route is removed", async () => {
    const adapter = adapterFor([rootWith()]);
    const edited = await adapter.edit({
      loop: "rafa", config: config(),
      edit: { kind: "stage", stage: "mapper", change: {
        runner: "opencode", model: "opencode-go/test",
        fallback: ["gpt-5.6-luna", "opus"],
        fallbackEfforts: { "gpt-5.6-luna": "xhigh" },
      } },
    });
    expect(edited.valid).toBe(true);
    const saved = await adapter.save({ loop: "rafa", config: edited.config });
    expect(saved.valid).toBe(true);
    const read = await adapter.read({ loop: "rafa" });
    expect(read.resolved.stages.mapper).toMatchObject({
      fallback: ["gpt-5.6-luna", "opus"], fallbackEfforts: { "gpt-5.6-luna": "xhigh" },
    });
    const removed = await adapter.edit({
      loop: "rafa", config: read.config,
      edit: { kind: "stage", stage: "mapper", change: { fallback: ["opus"] } },
    });
    expect(removed.valid).toBe(true);
    expect(removed.resolved?.stages.mapper).not.toHaveProperty("fallbackEfforts");
  });

  it("builds a complete block for a named loop and re-resolves it without writing", async () => {
    const root = rootWith();
    const before = readFileSync(join(root, "models.json"), "utf8");
    const adapter = adapterFor([root]);
    const candidate = config();

    const edited = await adapter.edit({
      loop: "rafa",
      config: candidate,
      edit: { kind: "stage", stage: "executor", change: { runner: "opencode", model: "opencode-go/kimi-k3" } },
    });
    expect(edited.valid).toBe(true);
    expect(Object.keys(edited.config)).toEqual(["$comment", "default", "$comment_loops", "rafa"]);
    expect(edited.config.rafa).toMatchObject({
      ...block(),
      executor: { runner: "opencode", model: "opencode-go/kimi-k3" },
    });
    expect(edited.resolved?.stages.executor).toMatchObject({ model: "opencode-go/kimi-k3", source: "loop" });
    // The caller's candidate and the file are both untouched.
    expect(candidate).not.toHaveProperty("rafa");
    expect(readFileSync(join(root, "models.json"), "utf8")).toBe(before);
  });

  it("creates a block from default, and removes one back to default", async () => {
    const adapter = adapterFor([rootWith()]);
    const created = await adapter.edit({ loop: "remo", config: config(), edit: { kind: "create" } });
    expect(created.config.remo).toEqual(block());
    expect(created.resolved?.stages.mapper!.source).toBe("loop");

    const removed = await adapter.edit({ loop: "remo", config: created.config, edit: { kind: "remove" } });
    expect(removed.config).not.toHaveProperty("remo");
    expect(removed.resolved?.stages.mapper!.source).toBe("default");
  });

  it("returns the candidate with the complete problem list when the edit is invalid", async () => {
    const adapter = adapterFor([rootWith()]);
    const edited = await adapter.edit({
      loop: "default",
      config: config(),
      edit: { kind: "stage", stage: "mapper", change: { runner: "claude", model: "gpt-5.6-terra", effort: "high" } },
    });
    expect(edited.valid).toBe(false);
    expect(edited.problems).toHaveLength(1);
    expect(edited.resolved).toBeNull();
    expect(edited.config.default).toMatchObject({ mapper: { model: "gpt-5.6-terra", effort: "high" } });
  });

  it("keeps the edit and reports the resolver's refusal when the environment strands it", async () => {
    // Removing rafa's block puts it on default's opencode mapper, where the
    // live RALPH_MODEL_MAPPER alias cannot run: the file is valid, but the
    // resolver refuses the lineup under this environment.
    const file = config({ rafa: block() });
    (file.default as JsonObject).mapper = { runner: "opencode", model: "opencode-go/kimi-k3" };
    const adapter = adapterFor([rootWith()], { RALPH_MODEL_MAPPER: "haiku" });

    const edited = await adapter.edit({ loop: "rafa", config: file, edit: { kind: "remove" } });
    expect(edited.config).not.toHaveProperty("rafa");
    expect(edited.valid).toBe(false);
    expect(edited.resolved).toBeNull();
    expect(edited.problems).toHaveLength(1);
    expect(edited.problems[0]).toContain("RALPH_MODEL_MAPPER");
  });

  it("refuses an edit the pure layer cannot apply as a request error", async () => {
    const adapter = adapterFor([rootWith()]);
    await expect(adapter.edit({ loop: "default", config: config(), edit: { kind: "remove" } })).rejects.toThrow(
      LineupRequestError,
    );
    await expect(
      adapter.edit({ loop: "ralph", config: config(), edit: { kind: "stage", stage: "executer", change: {} } }),
    ).rejects.toThrow(/unknown stage 'executer'/);
  });
});

describe("contract drift", () => {
  /** A fake `bun` that answers the lineup commands with a fixed stdout. */
  const fakeBun = (body: string): { bin: string; dir: string } => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lineup-fakebin-")));
    scratchRoots.push(dir);
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "bun");
    writeFileSync(bin, body);
    chmodSync(bin, 0o755);
    return { bin, dir };
  };

  it("fails loudly on a renamed field rather than coercing it", async () => {
    const { bin } = fakeBun('#!/bin/sh\nprintf \'%s\\n\' \'{"loop":"ralph","stages":{}}\'\n');
    const adapter = createLineupAdapter({
      cliDir: RALPH_HOME,
      roots: [rootWith()],
      bunPath: bin,
    });
    // The resolved lineup is read FIRST, because the role it reports is what
    // picks the schema's stage set; the fake answers the same drifted JSON for
    // every command, so the first contract failure is the resolver's.
    await expect(adapter.read()).rejects.toThrow(LineupContractError);
    await expect(adapter.read()).rejects.toThrow(/models --json/);
  });

  it("fails loudly on a renamed stage field in the resolved lineup", () => {
    expect(() =>
      narrowResolved({ loop: "ralph", stages: { mapper: { model: "x", runner: "claude", source: "guessed" } } }),
    ).toThrow(/models --json/);
  });

  it("names the command when the CLI does not print JSON", async () => {
    const { bin } = fakeBun(
      [
        "#!/bin/sh",
        `case "$2" in`,
        `  *--schema) printf '%s\\n' '{"stages":["mapper"],"runners":["claude"],"runnersFor":{"mapper":["claude"]},"agentToolStages":["mapper"],"aliases":["sonnet"],"defaultFallback":"opus","modelId":{"pattern":"^x$","providerPrefix":{"claude":"optional"}}}'; exit 0;;`,
        `  *--validate) printf '%s\\n' 'not json'; exit 0;;`,
        `  *) printf '%s\\n' '{"loop":"ralph","stages":{"mapper":{"model":"sonnet","runner":"claude","source":"default"}}}'; exit 0;;`,
        "esac",
        "",
      ].join("\n"),
    );
    const adapter = createLineupAdapter({
      cliDir: RALPH_HOME,
      roots: [rootWith()],
      bunPath: bin,
    });
    await expect(adapter.preview({ config: config() })).rejects.toThrow(/models --validate/);
    await expect(adapter.preview({ config: config() })).rejects.toThrow(/did not print JSON/);
  });
});

describe("the narrowers", () => {
  it("rejects a source the resolver could not have produced", () => {
    expect(() =>
      narrowResolved({
        loop: "ralph",
        stages: { mapper: { model: "sonnet", runner: "claude", source: "guessed" } },
      }),
    ).toThrow(/expected one of env, loop, role, project, default/);
  });

  it("rejects a missing provider rule", () => {
    expect(() =>
      narrowSchema({
        stages: ["mapper"],
        runners: ["claude"],
        runnersFor: { mapper: ["claude"] },
        agentToolStages: ["mapper"],
        aliases: ["sonnet"],
        defaultFallback: "opus",
        modelId: { pattern: "^x$", providerPrefix: { claude: "sometimes" } },
      }),
    ).toThrow(/expected one of required, forbidden, optional/);
  });

  it("rejects a verdict whose problems are not strings", () => {
    expect(() => narrowValidation({ valid: true, problems: [1] })).toThrow(/expected a string/);
  });
});

/**
 * A role the caller knows and the resolver does not (#147 AC 4).
 *
 * The adapter edits HARNESS checkouts, and a loop's role is declared in the
 * PROJECT's `.ralph/config.json`, so `models.ts` resolving from here cannot
 * name it and falls back to the coder's five stages. The dashboard HAS read
 * that roster, so it passes the role in — and that is the whole of the fix.
 */
describe("a caller-supplied role", () => {
  const roots = () => [rootWith()];

  it("gives a triager exactly its three stages", async () => {
    const adapter = adapterFor(roots());
    const read = await adapter.read({ loop: "tria", role: "triager" });
    // `schema.role` is not asserted: `narrowSchema` does not carry it today,
    // which is a pre-existing gap in the narrower rather than this fix's.
    expect(read.schema.stages).toEqual(["orchestrator", "mapper", "review.spec"]);
    expect(read.resolved.role).toBe("triager");
    // And the resolved lineup is the triager's too, not a coder's five.
    expect(Object.keys(read.resolved.stages).sort()).toEqual(["mapper", "orchestrator", "review.spec"]);
  });

  it("falls back to the coder's stages when no role is supplied", async () => {
    // The pre-#147 behaviour, kept: a loop whose role nothing can name is
    // edited as a coder, which is how every loop was edited before roles.
    // `sift`, not `tria`: this checkout's own roster names a `tria` triager.
    const read = await adapterFor(roots()).read({ loop: "sift" });
    expect(read.schema.stages).toEqual(["orchestrator", "executor", "mapper", "review.standards", "review.spec", "review.correctness"]);
  });

  it("judges a preview by the role as well", async () => {
    // Otherwise the form would offer three stages and the preview behind it
    // would report on five, and the operator would see two different loops.
    const preview = await adapterFor(roots()).preview({
      loop: "tria",
      role: "triager",
      config: projectView(config({ tria: block() }) as JsonObject, "loggd"),
    });
    expect(preview.schema.stages).toEqual(["orchestrator", "mapper", "review.spec"]);
  });

  it("accepts the three-stage block the form writes, on preview and on save", async () => {
    // The whole point of AC 4. `--validate` judges a block against the stage
    // set of whatever role it thinks the loop holds, so without the role AND
    // the loop identity reaching it, the form writes three stages and is then
    // told it is "missing 'executor'" — by the preview and again by the save.
    const root = rootWith();
    const adapter = adapterFor([root]);
    const created = await adapter.edit({
      loop: "tria",
      role: "triager",
      config: projectView(config() as JsonObject, "loggd"),
      edit: { kind: "create" },
    });
    expect(created.problems).toEqual([]);
    expect(created.valid).toBe(true);

    const preview = await adapter.preview({ loop: "tria", role: "triager", config: created.config });
    expect(preview.problems).toEqual([]);
    expect(preview.valid).toBe(true);

    const saved = await adapter.save({ loop: "tria", role: "triager", config: created.config });
    expect(saved.problems).toEqual([]);
    expect(saved.valid).toBe(true);
    // And it really landed, as the triager's three stages.
    const reread = await adapter.read({ loop: "tria", role: "triager" });
    expect(Object.keys(reread.resolved.stages).sort()).toEqual(["mapper", "orchestrator", "review.spec"]);
  });

  it("still opens the form for a triager configured before roles existed", async () => {
    // A loop given a complete five-stage block as a coder: the resolver is
    // RIGHT to refuse it for a triager, but refusing on READ leaves no draft,
    // no stages and nothing to edit — so the one page that could fix the block
    // could never open. The refusal reaches the operator on preview instead.
    const legacy = rootWith(JSON.stringify({ default: block(), loggd: { sift: block() } }, null, 2) + "\n");
    const adapter = adapterFor([legacy]);

    const read = await adapter.read({ loop: "sift", role: "triager" });
    // The block as it IS, not as the role says it should be: `executor` and
    // `review.standards` are precisely what the operator has to see in order to
    // delete them, and a three-stage form would hide them. This is also the
    // pre-roles behaviour, so nothing regressed for this loop.
    expect(read.schema.stages).toEqual(["orchestrator", "executor", "mapper", "review.standards", "review.spec", "review.correctness"]);
    expect(Object.keys(read.config.sift as JsonObject)).toContain("executor");

    // …and previewing it says exactly which stage has to go.
    const preview = await adapter.preview({ loop: "sift", role: "triager", config: read.config });
    expect(preview.valid).toBe(false);
    expect(preview.problems.join(" ")).toMatch(/'executor', which a triager loop does not run/);
  });

  it("reports the ROLE's refusal for a block neither role accepts", async () => {
    // The fallback must not report the CODER's refusal here: it names the
    // five-stage rule, so it would tell the operator to add `executor` — the
    // very stage a triager may not have, which is the defect the fallback
    // exists to avoid, arriving by the other door.
    const partial = { orchestrator: block().orchestrator, mapper: block().mapper };
    const root = rootWith(JSON.stringify({ default: block(), loggd: { tria: partial } }, null, 2) + "\n");
    await expect(adapterFor([root]).read({ loop: "tria", role: "triager" })).rejects.toThrow(
      /missing 'review\.spec'/,
    );
    await expect(adapterFor([root]).read({ loop: "tria", role: "triager" })).rejects.not.toThrow(/'executor'/);
  });

  it("reports an unknown role as a bad request on preview and save too, not contract drift", async () => {
    // `--validate` prints usage and no JSON for a role it does not know, which
    // would read as a drifted contract — a 500 for the caller's own selector.
    const adapter = adapterFor(roots());
    const candidate = projectView(config() as JsonObject, "loggd");
    await expect(adapter.preview({ loop: "tria", role: "sleuth", config: candidate })).rejects.toThrow(
      LineupRequestError,
    );
    await expect(adapter.save({ loop: "tria", role: "sleuth", config: candidate })).rejects.toThrow(
      LineupRequestError,
    );
  });

  it("reports an unknown role as a bad request, not an unreachable CLI", async () => {
    // The caller chose the value; telling the operator the lineup CLI is
    // unavailable would send them looking for the wrong fault.
    await expect(adapterFor(roots()).read({ loop: "tria", role: "sleuth" })).rejects.toThrow(LineupRequestError);
    // And the rejection is not memoised: the next good read still works.
    expect((await adapterFor(roots()).read({ loop: "tria", role: "triager" })).schema.stages).toHaveLength(3);
  });

  it("creates a new block over the role's stages, not every stage", async () => {
    // A block carrying an `executor` a triager never runs is one the resolver
    // refuses — so the edit layer must not write one in the first place.
    const edited = await adapterFor(roots()).edit({
      loop: "tria",
      role: "triager",
      config: projectView(config() as JsonObject, "loggd"),
      edit: { kind: "create" },
    });
    expect(Object.keys((edited.config as JsonObject).tria as JsonObject).sort()).toEqual([
      "mapper",
      "orchestrator",
      "review",
    ]);
  });
});

describe("model updates (#851)", () => {
  /**
   * An environment whose installed Claude Code bakes `opus → claude-opus-5-5`,
   * so the answer does not depend on which Claude Code this host runs.
   */
  const latestHome = (): Record<string, string> => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ralph-lineup-home-")));
    scratchRoots.push(home);
    const versions = join(home, ".local", "share", "claude", "versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "9.0.0"), 'x latest_per_family:{opus:"claude-opus-5-5",sonnet:"claude-sonnet-5-5"},y');
    return { HOME: home, PATH: "/usr/bin:/bin" };
  };
  const withTesto = () =>
    rootWith(JSON.stringify(config({ loggd: { testo: block(), ralph: { ...block(), updates: { policy: "pinned" } } } }), null, 2) + "\n");

  it("reports the project's blocks with their outdated stages and policy", async () => {
    const root = withTesto();
    const report = await adapterFor([root], latestHome()).updates({ project: "loggd" });
    expect(report.root).toBe(root);
    expect(report.project).toBe("loggd");
    expect(report.latest).toMatchObject({ opus: "claude-opus-5-5" });
    expect(report.latestSource).toMatch(/versions\/9\.0\.0$/);
    expect(report.agents.map((agent) => [agent.project, agent.block, agent.policy, agent.ask])).toEqual([
      [null, "default", "ask", true],
      ["loggd", "testo", "ask", true],
      ["loggd", "ralph", "pinned", false],
    ]);
    expect(report.agents[1]!.outdated).toEqual([
      { stage: "orchestrator", model: "claude-opus-5", latest: "claude-opus-5-5" },
      { stage: "executor", model: "claude-sonnet-5", latest: "claude-sonnet-5-5" },
    ]);
  });

  it("records an answer through the CLI, which writes the block and only that block", async () => {
    const root = withTesto();
    const adapter = adapterFor([root], latestHome());
    const result = await adapter.answerUpdate({ project: "loggd", block: "testo", answer: "update" });
    expect(result).toMatchObject({ root, project: "loggd", block: "testo", answer: "update", agent: { ask: false } });
    expect(result.changes.map((change) => `${change.stage}:${change.to}`)).toEqual([
      "orchestrator:claude-opus-5-5",
      "executor:claude-sonnet-5-5",
    ]);
    const file = JSON.parse(readFileSync(join(root, "models.json"), "utf8")) as {
      default: { orchestrator: { model: string } };
      loggd: Record<string, { orchestrator: { model: string } }>;
    };
    expect(file.loggd.testo!.orchestrator.model).toBe("claude-opus-5-5");
    expect(file.loggd.ralph!.orchestrator.model).toBe("claude-opus-5");
    expect(file.default.orchestrator.model).toBe("claude-opus-5");

    const pinned = await adapter.answerUpdate({ fileDefault: true, answer: "pin" });
    expect(pinned).toMatchObject({ project: null, block: "default", changes: [], agent: { policy: "pinned" } });
  });

  it("passes the CLI's refusal through, and refuses a request without a block itself", async () => {
    const adapter = adapterFor([withTesto()], latestHome());
    await expect(adapter.answerUpdate({ project: "loggd", block: "nobody", answer: "update" })).rejects.toThrow(
      new LineupRefusedError("models.json has no block 'loggd.nobody'."),
    );
    await expect(adapter.answerUpdate({ project: "loggd", answer: "update" })).rejects.toBeInstanceOf(LineupRequestError);
  });

  it("serves both routes, judging the request's shape before the CLI sees it", async () => {
    const root = withTesto();
    const handler = createHandler({ adapter: adapterFor([root], latestHome()), project: "loggd" });
    const read = await handler(new Request("http://x/api/lineup/updates"));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { agents: unknown[] }).agents).toHaveLength(3);

    const post = (body: unknown) =>
      handler(new Request("http://x/api/lineup/updates/answer", { method: "POST", body: JSON.stringify(body) }));
    const bad = await post({ block: "testo", answer: "forever" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/'answer' must be one of/);
    expect((await post({ block: "testo", answer: "update", fileDefault: "yes" })).status).toBe(400);

    const snoozed = await post({ block: "testo", answer: "snooze" });
    expect(snoozed.status).toBe(200);
    expect(((await snoozed.json()) as { agent: { ask: boolean; snoozedUntil: string } }).agent).toMatchObject({ ask: false });
    expect((await handler(new Request("http://x/api/lineup/updates/answer"))).status).toBe(405);
  });
});
