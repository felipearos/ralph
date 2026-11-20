// @vitest-environment node
/**
 * The page's pure view helpers and its HTTP client, with no DOM and no server.
 *
 * Every constraint is asserted against a schema *value* the test hands in —
 * including a schema that differs from the real one — so a helper that quietly
 * consulted a hardcoded runner list or alias set would fail here. The client is
 * driven with a fake `fetch`, pinning the method, path and body of each request
 * and how each response becomes a view model or an error.
 */
import { describe, expect, it } from "vitest";

import type { JsonObject, RuntimeSchema } from "./contracts";
import { block, config } from "./fixtures";
import {
  APPLY_TIMING,
  LineupHttpError,
  buildChange,
  createLineupClient,
  draftFor,
  draftProblems,
  hasBlock,
  loopNames,
  modelProblem,
  previewRows,
  shadowWarning,
  stageControls,
  stageValues,
} from "./static/lineup-view.js";

/** The runtime's schema as `models.ts --schema` prints it today. */
const schema = (): RuntimeSchema => ({
  stages: ["orchestrator", "executor", "mapper", "review.standards", "review.spec"],
  runners: ["claude", "opencode", "codex"],
  runnersFor: {
    orchestrator: ["claude"],
    executor: ["opencode", "claude"],
    mapper: ["claude", "opencode", "codex"],
    "review.standards": ["claude", "opencode", "codex"],
    "review.spec": ["claude", "opencode", "codex"],
  },
  effortRunnersFor: {
    orchestrator: ["claude", "codex"],
    executor: ["codex"], mapper: ["codex"],
    "review.standards": ["codex"], "review.spec": ["codex"],
  },
  agentToolStages: ["mapper", "review.standards", "review.spec"],
  aliases: ["opus", "sonnet", "haiku", "fable"],
  aliasTargets: {},
  defaultFallback: "opus",
  defaultFallbacks: ["opus"],
  modelId: {
    pattern: "^[A-Za-z0-9._:/@[\\]-]+$",
    providerPrefix: { claude: "optional", opencode: "required", codex: "forbidden" },
  },
});

describe("loops", () => {

  it('offers effort for every Codex stage and includes it in edits', () => {
    for (const stage of ['orchestrator', 'executor', 'mapper', 'review.standards', 'review.spec']) {
      expect(stageControls(schema(), stage, 'codex').effort).toBe(true);
      expect(buildChange(schema(), stage, { runner: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', fallback: [] }))
        .toMatchObject({ effort: 'xhigh' });
    }
  });
  it("lists default first, then every named block in file order, skipping commentary", () => {
    const file = config({ ralph: block(), rafa: block() });
    expect(loopNames(file)).toEqual(["default", "ralph", "rafa"]);
  });

  it("does not list a project's @role default as a loop", () => {
    // `@triager` is the project's default lineup for every triager it runs
    // (`ralph/models.ts`), complete over THAT role's stages — so offering it as
    // a loop would edit it against the wrong set under a name no loop has.
    const file = config({ ralph: block(), "@triager": block() });
    expect(loopNames(file)).toEqual(["default", "ralph"]);
  });

  it("keeps loops the page already knows even when their block is gone", () => {
    expect(loopNames(config({ rafa: block() }), ["ralph", "rafa", "remo", "rulo"])).toEqual([
      "default",
      "rafa",
      "ralph",
      "remo",
      "rulo",
    ]);
  });

  it("reads a stage as the file has it, and nothing for a loop without a block", () => {
    const file = config({ rafa: block() });
    expect(hasBlock(file, "rafa")).toBe(true);
    expect(hasBlock(file, "remo")).toBe(false);
    expect(stageValues(file, "rafa", "review.spec")).toEqual({ runner: "claude", model: "opus" });
    expect(stageValues(file, "remo", "mapper")).toBeNull();
  });

  it("drafts a loop without a block from default, since that is what it runs", () => {
    const file = config();
    expect(draftFor(file, "remo", "orchestrator")).toEqual({
      runner: "claude",
      model: "claude-opus-5",
      effort: "medium",
      fallback: [],
    });
  });
});

describe("stage controls come from the schema", () => {
  it("offers exactly the runners the schema allows for the stage", () => {
    expect(stageControls(schema(), "orchestrator", "claude").runners).toEqual(["claude"]);
    expect(stageControls(schema(), "executor", "claude").runners).toEqual(["opencode", "claude"]);
    const narrowed = { ...schema(), runnersFor: { ...schema().runnersFor, mapper: ["codex"] } };
    expect(stageControls(narrowed, "mapper", "codex").runners).toEqual(["codex"]);
  });

  it("offers effort on the orchestrator only", () => {
    for (const stage of schema().stages) {
      const runner = schema().runnersFor[stage]![0]!;
      expect(stageControls(schema(), stage, runner).effort).toBe(stage === "orchestrator");
    }
  });

  it("offers fallback only on a read-only stage whose runner is not claude", () => {
    expect(stageControls(schema(), "mapper", "opencode").fallback).toBe(true);
    expect(stageControls(schema(), "review.spec", "codex").fallback).toBe(true);
    expect(stageControls(schema(), "mapper", "claude").fallback).toBe(false);
    expect(stageControls(schema(), "executor", "opencode").fallback).toBe(false);
    expect(stageControls(schema(), "orchestrator", "claude").fallback).toBe(false);
  });

  it("constrains an Agent-tool stage on claude to the schema's alias set", () => {
    const other = { ...schema(), aliases: ["alpha", "beta"], defaultFallback: "beta", defaultFallbacks: ["beta"] };
    expect(stageControls(other, "mapper", "claude").modelChoices).toEqual(["alpha", "beta"]);
    expect(stageControls(other, "mapper", "opencode")).toMatchObject({
      modelChoices: null,
      fallbackChoices: ["alpha", "beta"],
      defaultFallback: "beta",
      defaultFallbacks: ["beta"],
    });
    expect(stageControls(other, "executor", "claude").modelChoices).toBeNull();
  });
});

/** The schema of a resolver whose Claude read-only stages are named agents. */
const namedSchema = (): RuntimeSchema => ({
  ...schema(),
  effortRunnersFor: {
    orchestrator: ["claude", "codex"],
    executor: ["codex"], mapper: ["claude", "codex"],
    "review.standards": ["claude", "codex"], "review.spec": ["claude", "codex"],
  },
  agentNames: { mapper: "ralph-mapper", "review.standards": "ralph-review-standards", "review.spec": "ralph-review-spec" },
  claudeIdPrefix: "claude-",
});

describe("named Claude agents", () => {
  it("offer effort and a free model id on the claude runner", () => {
    expect(stageControls(namedSchema(), "review.spec", "claude")).toMatchObject({ effort: true, modelChoices: null, fallback: false });
    expect(stageControls(namedSchema(), "review.spec", "opencode").effort).toBe(false);
  });

  it("take a full Claude id or an alias, and nothing else", () => {
    expect(modelProblem(namedSchema(), "review.standards", "claude", "claude-opus-5-5")).toBeNull();
    expect(modelProblem(namedSchema(), "review.standards", "claude", "opus")).toBeNull();
    expect(modelProblem(namedSchema(), "review.standards", "claude", "gpt-5.6-terra")).toMatch(
      /named Claude agent, whose model is one of: opus, sonnet, haiku, fable, or a full 'claude-…' id/,
    );
  });

  it("carry the effort into the edit", () => {
    expect(buildChange(namedSchema(), "review.spec", { runner: "claude", model: "claude-opus-5-5", effort: "medium", fallback: [] }))
      .toMatchObject({ runner: "claude", model: "claude-opus-5-5", effort: "medium" });
  });

  it("still keep a Claude fallback to the alias set", () => {
    const problems = draftProblems(namedSchema(), "mapper", {
      runner: "opencode", model: "opencode-go/x", effort: "", fallback: ["claude-opus-5-5"],
    });
    expect(problems.join("\n")).toMatch(/fallback/);
  });
});

describe("model validation for the chosen runner", () => {
  it("accepts what the resolver accepts", () => {
    expect(modelProblem(schema(), "executor", "opencode", "opencode-go/deepseek-v4-flash")).toBeNull();
    expect(modelProblem(schema(), "mapper", "codex", "gpt-5.6-terra")).toBeNull();
    expect(modelProblem(schema(), "mapper", "claude", "sonnet")).toBeNull();
    expect(modelProblem(schema(), "orchestrator", "claude", "claude-opus-5[1m]")).toBeNull();
  });

  it("refuses an empty model and illegal characters", () => {
    expect(modelProblem(schema(), "executor", "opencode", " ")).toMatch(/must be a non-empty string/);
    expect(modelProblem(schema(), "executor", "claude", "claude opus")).toMatch(/characters a model id cannot/);
  });

  it("refuses a full id on an Agent-tool stage on claude", () => {
    expect(modelProblem(schema(), "review.standards", "claude", "claude-opus-5")).toMatch(
      /Agent call, whose model is one of: opus, sonnet, haiku, fable/,
    );
  });

  it("applies the runner's provider-prefix rule from the schema", () => {
    expect(modelProblem(schema(), "executor", "opencode", "deepseek")).toMatch(/provider\/model/);
    expect(modelProblem(schema(), "mapper", "codex", "openai/gpt-5.6")).toMatch(/without a provider prefix/);
    const flipped = {
      ...schema(),
      modelId: { ...schema().modelId, providerPrefix: { claude: "optional", opencode: "forbidden", codex: "required" } },
    } as RuntimeSchema;
    expect(modelProblem(flipped, "executor", "opencode", "deepseek")).toBeNull();
  });

  it("refuses an alias on a runner that is not the Agent tool's", () => {
    expect(modelProblem(schema(), "mapper", "opencode", "opus")).toMatch(/Agent tool's aliases/);
  });

  it("collects every problem in a draft, not the first", () => {
    const problems = draftProblems(schema(), "mapper", {
      runner: "opencode",
      model: "deepseek",
      effort: "",
      fallback: ["claude-opus-5"],
    });
    expect(problems).toHaveLength(2);
  });
});

describe("one change per edit", () => {
  it("sends runner and model together", () => {
    expect(
      buildChange(schema(), "executor", { runner: "opencode", model: "opencode-go/kimi", effort: "", fallback: [] }),
    ).toEqual({ runner: "opencode", model: "opencode-go/kimi", effort: null, fallback: null });
  });

  it("keeps effort on the orchestrator and clears it when emptied", () => {
    expect(buildChange(schema(), "orchestrator", { runner: "claude", model: "claude-opus-5", effort: " high ", fallback: [] }))
      .toMatchObject({ effort: "high" });
    expect(buildChange(schema(), "orchestrator", { runner: "claude", model: "claude-opus-5", effort: "", fallback: [] }))
      .toMatchObject({ effort: null });
  });

  it("clears a fallback the new runner cannot carry", () => {
    expect(buildChange(schema(), "mapper", { runner: "opencode", model: "opencode-go/x", effort: "", fallback: ["haiku"] }))
      .toMatchObject({ fallback: ["haiku"] });
    expect(buildChange(schema(), "mapper", { runner: "claude", model: "sonnet", effort: "", fallback: ["haiku"] }))
      .toMatchObject({ fallback: null });
  });
});

describe("the preview", () => {
  it("lists every stage in schema order with its source and the overriding variable", () => {
    const rows = previewRows(
      schema(),
      {
        loop: "rafa",
        stages: {
          "review.spec": { runner: "claude", model: "opus", source: "loop" },
          mapper: { runner: "claude", model: "haiku", source: "env" },
          orchestrator: { runner: "claude", model: "claude-opus-5", effort: "high", source: "loop" },
          executor: { runner: "claude", model: "claude-sonnet-5", source: "loop" },
          "review.standards": { runner: "opencode", model: "a/b", fallback: ["opus"], source: "default" },
        },
      },
      [
        { stage: "mapper", field: "model", variable: "RALPH_MODEL_MAPPER" },
        { stage: "orchestrator", field: "effort", variable: "RALPH_MODEL_ORCHESTRATOR_EFFORT" },
      ],
    );
    expect(rows.map((row) => row.stage)).toEqual(schema().stages);
    expect(rows[2]).toMatchObject({ stage: "mapper", source: "env", overrides: [{ variable: "RALPH_MODEL_MAPPER" }] });
    expect(rows[0]!.overrides.map((shadow) => shadow.variable)).toEqual(["RALPH_MODEL_ORCHESTRATOR_EFFORT"]);
    expect(rows[3]).toMatchObject({ fallback: ["opus"], source: "default", overrides: [] });
  });

  it("names the exact variable in the shadow warning", () => {
    const warning = shadowWarning({ stage: "executor", field: "model", variable: "RALPH_CODER_MODEL" });
    expect(warning).toContain("RALPH_CODER_MODEL");
    expect(warning).toContain("executor");
  });

  it("says a save applies at the next start.sh, not to a running supervisor", () => {
    expect(APPLY_TIMING).toMatch(/next `?start\.sh`?/);
    expect(APPLY_TIMING).toMatch(/running supervisor/);
  });
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const fakeFetch = (respond: (call: Call) => { status: number; body: unknown }) => {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
};

describe("the client", () => {
  it("reads with the root and loop as query parameters", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { loop: "rafa" } }));
    const read = await createLineupClient(impl, "http://127.0.0.1:1").read({ root: "/srv/r", loop: "rafa" });
    expect(read).toEqual({ loop: "rafa" });
    expect(calls).toEqual([{ url: "http://127.0.0.1:1/api/lineup?root=%2Fsrv%2Fr&loop=rafa", method: "GET", body: undefined }]);
  });

  it("posts one edit with the candidate it applies to", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { valid: true } }));
    const candidate: JsonObject = config();
    await createLineupClient(impl).edit({
      loop: "remo",
      config: candidate,
      edit: { kind: "stage", stage: "executor", change: { runner: "opencode", model: "a/b" } },
    });
    expect(calls[0]).toEqual({
      url: "/api/lineup/edit",
      method: "POST",
      body: {
        loop: "remo",
        config: candidate,
        edit: { kind: "stage", stage: "executor", change: { runner: "opencode", model: "a/b" } },
      },
    });
  });

  it("returns a refused save as a verdict carrying every problem", async () => {
    const { impl } = fakeFetch(() => ({ status: 400, body: { valid: false, problems: ["one", "two"] } }));
    const saved = await createLineupClient(impl).save({ config: config() });
    expect(saved).toEqual({ valid: false, problems: ["one", "two"] });
  });

  it("raises the server's error kind and message for anything else", async () => {
    const { impl } = fakeFetch(() => ({
      status: 400,
      body: { error: "LineupRefusedError", message: "Restore it from git" },
    }));
    const failure = await createLineupClient(impl).read().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LineupHttpError);
    expect(failure).toMatchObject({ status: 400, kind: "LineupRefusedError", message: "Restore it from git" });
  });

  it("lists the configured roots", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200, body: { roots: ["/a", "/b"] } }));
    expect(await createLineupClient(impl).roots()).toEqual(["/a", "/b"]);
    expect(calls[0]!.url).toBe("/api/roots");
  });
});
