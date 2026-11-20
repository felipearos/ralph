// @vitest-environment node
/**
 * Where Add agent puts a new agent's worktree when nothing overrides it.
 *
 * It used to be `~/orca/workspaces/<project>/`, the workspace manager's own
 * folder: the manager listed every agent as a task of its own and offered to
 * clean up checkouts a live supervisor was running in. The default is now
 * Ralph's directory under the XDG data home.
 */
import { describe, expect, it } from "vitest";

import { createAgentsAdapter } from "./agents-adapter";
import { createProcessExecutor } from "./executor";

// Resolving a path runs nothing; the adapter only needs an executor to be built.
const exec = createProcessExecutor({ timeoutMs: 1_000 });

describe("an agent's worktree path", () => {
  it("defaults to Ralph's data directory under HOME, outside any workspace manager's folder", () => {
    const agents = createAgentsAdapter({ cliDir: "/cli", root: "/repo", project: "proj", exec, env: { HOME: "/home/op", XDG_DATA_HOME: "" } });
    expect(agents.worktreeFor("nova")).toBe("/home/op/.local/share/ralph/workspaces/proj/nova-loop");
  });

  it("honours XDG_DATA_HOME, as the project registry honours XDG_CONFIG_HOME", () => {
    const agents = createAgentsAdapter({ cliDir: "/cli", root: "/repo", project: "proj", exec, env: { HOME: "/home/op", XDG_DATA_HOME: "/data" } });
    expect(agents.worktreeFor("nova")).toBe("/data/ralph/workspaces/proj/nova-loop");
  });

  it("follows an explicit workspaces directory over the default", () => {
    const agents = createAgentsAdapter({ cliDir: "/cli", root: "/repo", project: "proj", workspaces: "/ws", exec, env: { HOME: "/home/op" } });
    expect(agents.worktreeFor("nova")).toBe("/ws/proj/nova-loop");
  });
});
