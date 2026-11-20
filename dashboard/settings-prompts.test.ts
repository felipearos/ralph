// @vitest-environment node
/**
 * The Settings page's Prompts section (#695), over a fake agents adapter
 * whose config read goes through the adapter's own parser, so a test says
 * what `project-config` printed and not how the adapter spelled it.
 */
import { describe, expect, it } from "vitest";

import type { AgentsDeps } from "./agents";
import { parseAgentConfig, type FileRead, type Read } from "./agents-adapter";
import type { LoopRole } from "./contracts";
import type { ExecResult } from "./control-adapter";
import { projectPrompts } from "./settings-prompts";

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
const bad = (stderr: string): ExecResult => ({ status: 1, stdout: "", stderr });

const ROSTER = [
  { name: "nova", role: "coder" },
  { name: "tria", role: "triager" },
  { name: "mira", role: "coder" },
  { name: "medi", role: "pr-medic" },
];

const config = (extra: Record<string, unknown> = {}, roster: unknown = ROSTER): ExecResult =>
  ok(JSON.stringify({ repo: "o/r", baseBranch: "main", loops: ["nova", "tria", "mira", "medi"], roster, ...extra }));

interface Answers {
  config: ExecResult;
  /** Each project file the fake can read, by path; absent means missing. */
  files?: Record<string, FileRead>;
  /** Each role whose render fails, with why. */
  failing?: Partial<Record<LoopRole, string>>;
}

function deps(answers: Answers): { deps: AgentsDeps; renders: [LoopRole, string][] } {
  const renders: [LoopRole, string][] = [];
  const agents = {
    readConfig: async () => parseAgentConfig(answers.config),
    readProjectFile: (path: string): FileRead => answers.files?.[path] ?? { ok: false, missing: true, why: `${path} does not exist` },
    renderPrompt: async (role: LoopRole, loop: string): Promise<Read<string>> => {
      renders.push([role, loop]);
      const why = answers.failing?.[role];
      return why === undefined ? { ok: true, value: `prompt for ${role} as ${loop}` } : { ok: false, why };
    },
  } as unknown as AgentsDeps["agents"];
  return { deps: { agents }, renders };
}

const FRAGMENTS = { promptFragment: ".ralph/prompt.md", coderFragment: ".ralph/coder.md", plan: ".ralph/plan.md" };

describe("projectPrompts", () => {
  it("lists named fragments in order, telling present, missing and unreadable apart", async () => {
    const { deps: d } = deps({
      config: config(FRAGMENTS),
      files: {
        ".ralph/prompt.md": { ok: true, value: "# prompt" },
        ".ralph/plan.md": { ok: false, missing: false, why: "/root/.ralph/plan.md could not be read: EACCES" },
      },
    });
    const view = await projectPrompts(d);
    expect(view.fragments).toEqual([
      { kind: "prompt", path: ".ralph/prompt.md", text: "# prompt", missing: false, problem: null },
      { kind: "coder", path: ".ralph/coder.md", text: null, missing: true, problem: null },
      { kind: "plan", path: ".ralph/plan.md", text: null, missing: false, problem: "/root/.ralph/plan.md could not be read: EACCES" },
    ]);
    expect(view.problems).toEqual([]);
  });

  it("leaves a fragment the config does not name out of the list", async () => {
    const { deps: d } = deps({ config: config({ coderFragment: ".ralph/coder.md" }), files: { ".ralph/coder.md": { ok: true, value: "c" } } });
    const view = await projectPrompts(d);
    expect(view.fragments.map((fragment) => fragment.kind)).toEqual(["coder"]);
  });

  it("renders each distinct role once, in roster order, as its first loop", async () => {
    const { deps: d, renders } = deps({ config: config() });
    const view = await projectPrompts(d);
    expect(view.renders).toEqual([
      { role: "coder", loop: "nova", prompt: "prompt for coder as nova", error: null },
      { role: "triager", loop: "tria", prompt: "prompt for triager as tria", error: null },
      { role: "pr-medic", loop: "medi", prompt: "prompt for pr-medic as medi", error: null },
    ]);
    expect(renders).toHaveLength(3);
  });

  it("shows a failing render's error beside the fragments", async () => {
    const { deps: d } = deps({
      config: config(FRAGMENTS),
      files: { ".ralph/prompt.md": { ok: true, value: "p" }, ".ralph/coder.md": { ok: true, value: "c" }, ".ralph/plan.md": { ok: true, value: "l" } },
      failing: { triager: "unknown placeholder {{PROJECT_X}}" },
    });
    const view = await projectPrompts(d);
    expect(view.fragments.map((fragment) => fragment.text)).toEqual(["p", "c", "l"]);
    expect(view.renders.find((render) => render.role === "triager")).toEqual({
      role: "triager",
      loop: "tria",
      prompt: null,
      error: "unknown placeholder {{PROJECT_X}}",
    });
    expect(view.renders.find((render) => render.role === "coder")?.prompt).toBe("prompt for coder as nova");
  });

  it("answers a config that cannot be read with its problem and nothing else", async () => {
    const { deps: d, renders } = deps({ config: bad("config.json: unexpected token") });
    const view = await projectPrompts(d);
    expect(view.fragments).toEqual([]);
    expect(view.renders).toEqual([]);
    expect(view.problems).toHaveLength(1);
    expect(view.problems[0]).toContain("unexpected token");
    expect(renders).toEqual([]);
  });

  it("still shows the fragments when the roster cannot be narrowed, and renders nothing", async () => {
    const { deps: d, renders } = deps({
      config: config(FRAGMENTS, [{ name: "nova", role: "astronaut" }]),
      files: { ".ralph/prompt.md": { ok: true, value: "p" } },
    });
    const view = await projectPrompts(d);
    expect(view.fragments).toHaveLength(3);
    expect(view.renders).toEqual([]);
    expect(renders).toEqual([]);
    expect(view.problems).toHaveLength(1);
    expect(view.problems[0]).toMatch(/^cannot read the project's roster: .*astronaut/);
  });
});
