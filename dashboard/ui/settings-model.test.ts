// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ProjectSettingsView, SettingsWorktreeView } from "../contracts";
import { settingsModel } from "./settings-model";

const WORKTREES: SettingsWorktreeView[] = [
  { path: "/home/op/loggd", branch: "main", main: true, loop: null, use: "unowned", reconciliation: null },
  { path: "/home/op/wt/rafa", branch: "ralph/12-fix", main: false, loop: "rafa", use: "in-use", reconciliation: null },
  { path: "/home/op/wt/rulo", branch: null, main: false, loop: "rulo", use: "idle", reconciliation: null },
  { path: "/home/op/wt/gone", branch: "old", main: false, loop: null, use: "unowned", reconciliation: "prunable" },
];

function view(overrides: Partial<ProjectSettingsView> = {}): ProjectSettingsView {
  return {
    project: "loggd",
    checkout: { path: "/home/op/loggd", addedAt: "2026-10-22T19:04:00.000Z" },
    worktreesDir: "/home/op/wt",
    worktreesDefault: true,
    defaultWorktreesDir: "/home/op/wt",
    config: { repo: "felipearos/loggd", owner: "felipearos", baseBranch: "main", displayName: "Loggd", gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] },
    problems: [],
    worktrees: WORKTREES,
    worktreesProblem: null,
    ...overrides,
  };
}

describe("settingsModel", () => {
  it("shows every field of a valid config and a row per worktree", () => {
    const model = settingsModel(view());
    expect(model.fields).toEqual([
      { label: "Display name", value: "Loggd", mono: false },
      { label: "Repository", value: "felipearos/loggd", mono: true },
      { label: "Owner", value: "felipearos", mono: false },
      { label: "Base branch", value: "main", mono: true },
    ]);
    expect(model.problems).toEqual([]);
    // 19:04 UTC is 16:04 in Santiago (UTC-3 in October).
    expect(model.location).toEqual([
      { label: "Main checkout", value: "/home/op/loggd", mono: true },
      { label: "Added", value: "22-10-2026 16:04", mono: false },
      { label: "Agent worktrees folder", value: "/home/op/wt (default)", mono: true },
    ]);
    expect(model.rows).toEqual([
      { path: "/home/op/loggd", branch: "main", loop: null, use: "unowned", tone: "neutral", detail: "main checkout" },
      { path: "/home/op/wt/rafa", branch: "ralph/12-fix", loop: "rafa", use: "in-use", tone: "good", detail: null },
      { path: "/home/op/wt/rulo", branch: "detached", loop: "rulo", use: "idle", tone: "neutral", detail: null },
      { path: "/home/op/wt/gone", branch: "old", loop: null, use: "unowned", tone: "warn", detail: "prunable" },
    ]);
    expect(model.worktreesProblem).toBeNull();
  });

  it("shows a project's own worktrees folder without the default mark", () => {
    const model = settingsModel(view({ worktreesDir: "/srv/wt", worktreesDefault: false }));
    expect(model.location.find((field) => field.label === "Agent worktrees folder")).toEqual({
      label: "Agent worktrees folder",
      value: "/srv/wt",
      mono: true,
    });
  });

  it("falls back to the project id and says unknown for a missing owner or added date", () => {
    const model = settingsModel(
      view({
        checkout: { path: "/home/op/loggd", addedAt: null },
        config: { repo: "felipearos/loggd", owner: null, baseBranch: "dev", displayName: null, gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] },
      }),
    );
    expect(model.fields?.find((field) => field.label === "Display name")?.value).toBe("loggd");
    expect(model.fields?.find((field) => field.label === "Owner")?.value).toBe("unknown");
    expect(model.location.find((field) => field.label === "Added")?.value).toBe("unknown");
  });

  it("lists every problem of an invalid config and still draws the worktrees", () => {
    const problems = ["repo: must be owner/name", "baseBranch: missing"];
    const model = settingsModel(view({ config: null, problems }));
    expect(model.fields).toBeNull();
    expect(model.problems).toEqual(problems);
    expect(model.location.map((field) => field.label)).toEqual(["Main checkout", "Added", "Agent worktrees folder"]);
    expect(model.rows).toHaveLength(4);
  });

  it("shows why the worktrees of an unreadable checkout could not be listed", () => {
    const model = settingsModel(view({ worktrees: null, worktreesProblem: "git worktree list failed: not a git repository" }));
    expect(model.rows).toBeNull();
    expect(model.worktreesProblem).toBe("git worktree list failed: not a git repository");
    expect(model.fields).not.toBeNull();
  });

  it("lists the config's gates and required checks in order", () => {
    const config = {
      repo: "felipearos/loggd",
      owner: "felipearos",
      baseBranch: "main",
      displayName: "Loggd",
      gates: [
        { name: "typecheck", command: "bun run typecheck" },
        { name: "test", command: "bun run test" },
      ],
      requiredChecks: ["ci/build", "ci/test"],
      refuseFiles: [".env", "migrations/"],
      worktreeSetup: [],
    };
    const model = settingsModel(view({ config }));
    expect(model.gates).toEqual(config.gates);
    expect(model.requiredChecks).toEqual(["ci/build", "ci/test"]);
    expect(model.refuseFiles).toEqual([".env", "migrations/"]);
  });

  it("reads a config from an older bridge that lacks gates and required checks as empty", () => {
    // The shape an older snapshot carries: no gates, no requiredChecks.
    const config = { repo: "felipearos/loggd", owner: null, baseBranch: "main", displayName: null } as unknown as ProjectSettingsView["config"];
    const model = settingsModel(view({ config }));
    expect(model.gates).toEqual([]);
    expect(model.requiredChecks).toEqual([]);
    expect(model.refuseFiles).toEqual([]);
  });

  it("drops malformed gate and check entries rather than drawing them", () => {
    const config = {
      repo: "felipearos/loggd",
      owner: null,
      baseBranch: "main",
      displayName: null,
      gates: [{ name: "lint", command: "bun run lint" }, { name: 3 }, null],
      requiredChecks: ["ci/test", 7],
      refuseFiles: [".env", false],
    } as unknown as ProjectSettingsView["config"];
    const model = settingsModel(view({ config }));
    expect(model.gates).toEqual([{ name: "lint", command: "bun run lint" }]);
    expect(model.requiredChecks).toEqual(["ci/test"]);
    expect(model.refuseFiles).toEqual([".env"]);
  });

  it("has no gates or required checks to show for an invalid config", () => {
    const model = settingsModel(view({ config: null, problems: ["repo: missing"] }));
    expect(model.gates).toBeNull();
    expect(model.requiredChecks).toBeNull();
    expect(model.refuseFiles).toBeNull();
    expect(model.worktreeSetup).toBeNull();
  });

  it("lists the worktree setup steps in order", () => {
    const steps = [
      { name: "env", command: "cp \"$RALPH_MAIN_CHECKOUT/.env\" .", timeoutSeconds: 5, installsDependencies: false },
      { name: "install", command: "bun install", timeoutSeconds: 120, installsDependencies: true },
    ];
    const base = view().config!;
    expect(settingsModel(view({ config: { ...base, worktreeSetup: steps } })).worktreeSetup).toEqual(steps);
  });

  it("reads an older snapshot without worktree setup as no steps, and drops malformed ones", () => {
    const older = { repo: "felipearos/loggd", owner: null, baseBranch: "main", displayName: null } as unknown as ProjectSettingsView["config"];
    expect(settingsModel(view({ config: older })).worktreeSetup).toEqual([]);
    const malformed = {
      repo: "felipearos/loggd",
      owner: null,
      baseBranch: "main",
      displayName: null,
      worktreeSetup: [{ name: "ok", command: "x", timeoutSeconds: 3, installsDependencies: true }, { name: "half", command: "y" }, null, 4],
    } as unknown as ProjectSettingsView["config"];
    expect(settingsModel(view({ config: malformed })).worktreeSetup).toEqual([{ name: "ok", command: "x", timeoutSeconds: 3, installsDependencies: true }]);
    const notList = { repo: "a/b", owner: null, baseBranch: "main", displayName: null, worktreeSetup: "nope" } as unknown as ProjectSettingsView["config"];
    expect(settingsModel(view({ config: notList })).worktreeSetup).toEqual([]);
  });
});
