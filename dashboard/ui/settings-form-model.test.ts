// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ProjectSettingsView, RosterPrView } from "../contracts";
import {
  gatesEditFromForm,
  gatesEditProblems,
  gatesFormFromView,
  gatesFormList,
  gatesFormProblems,
  projectEditFromForm,
  projectEditProblems,
  projectFormFromView,
  projectFormProblems,
  projectSaveNotice,
  setupEditFromForm,
  setupEditProblems,
  setupFormFromView,
  setupFormProblems,
  setupTotalSeconds,
  worktreesEditFromForm,
  worktreesFolderProblems,
  worktreesFormFromView,
  worktreesSaveNotice,
} from "./settings-form-model";

function view(config: ProjectSettingsView["config"] = { repo: "felipearos/loggd", owner: null, baseBranch: "main", displayName: "Loggd", gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] }): ProjectSettingsView {
  return {
    project: "loggd",
    checkout: { path: "/home/op/loggd", addedAt: null },
    worktreesDir: "/home/op/wt",
    worktreesDefault: true,
    defaultWorktreesDir: "/home/op/wt",
    config,
    problems: [],
    worktrees: [],
    worktreesProblem: null,
  };
}

const PR: RosterPrView = { url: "https://github.com/felipearos/loggd/pull/9", branch: "ralph/settings", state: "open" };

describe("projectFormFromView", () => {
  it("seeds both inputs from the config", () => {
    expect(projectFormFromView(view())).toEqual({ displayName: "Loggd", baseBranch: "main" });
  });

  it("seeds an empty display name when the config has none", () => {
    expect(projectFormFromView(view({ repo: "a/b", owner: null, baseBranch: "dev", displayName: null, gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] }))).toEqual({
      displayName: "",
      baseBranch: "dev",
    });
  });
});

describe("projectFormProblems", () => {
  it("accepts a valid draft", () => {
    expect(projectFormProblems({ displayName: "Loggd", baseBranch: "release/2" })).toEqual([]);
  });

  it("refuses a blank or multi-line name and a bad branch, in the harness's words and order", () => {
    expect(projectFormProblems({ displayName: "  ", baseBranch: "-x" })).toEqual([
      "'baseBranch' must be a branch name",
      "'displayName' must be a non-empty single-line string",
    ]);
    expect(projectFormProblems({ displayName: "a\nb", baseBranch: "main" })).toEqual(["'displayName' must be a non-empty single-line string"]);
    expect(projectFormProblems({ displayName: "x", baseBranch: "a b" })).toEqual(["'baseBranch' must be a branch name"]);
  });
});

describe("projectEditFromForm", () => {
  it("is null when nothing changed", () => {
    expect(projectEditFromForm({ displayName: "Loggd", baseBranch: "main" }, view())).toBeNull();
  });

  it("carries only the changed keys", () => {
    expect(projectEditFromForm({ displayName: "Loggd", baseBranch: "dev" }, view())).toEqual({ baseBranch: "dev" });
    expect(projectEditFromForm({ displayName: "Log", baseBranch: "main" }, view())).toEqual({ displayName: "Log" });
    expect(projectEditFromForm({ displayName: "Log", baseBranch: "dev" }, view())).toEqual({ displayName: "Log", baseBranch: "dev" });
  });
});

describe("projectEditProblems", () => {
  it("does not hold an untouched empty name against a branch edit", () => {
    const noName = view({ repo: "a/b", owner: null, baseBranch: "main", displayName: null, gates: [], requiredChecks: [], refuseFiles: [], worktreeSetup: [] });
    expect(projectEditProblems({ displayName: "", baseBranch: "dev" }, noName)).toEqual([]);
  });

  it("checks the keys it would send", () => {
    expect(projectEditProblems({ displayName: " ", baseBranch: "main" }, view())).toEqual(["'displayName' must be a non-empty single-line string"]);
    expect(projectEditProblems({ displayName: "Loggd", baseBranch: "-x" }, view())).toEqual(["'baseBranch' must be a branch name"]);
  });
});

describe("projectSaveNotice", () => {
  it("links the PR a proposal opened or reused", () => {
    expect(projectSaveNotice({ outcome: "proposed", pr: PR, warnings: [] })).toEqual({
      tone: "good",
      text: "Proposed. The change applies once the PR is merged and the loops are restarted.",
      url: PR.url,
    });
    expect(projectSaveNotice({ outcome: "reused", pr: PR, warnings: [] })).toEqual({
      tone: "good",
      text: "A PR for this change is already open. It applies once that PR is merged and the loops are restarted.",
      url: PR.url,
    });
  });

  it("warns, and lists the warnings, when the PR opened with some", () => {
    expect(projectSaveNotice({ outcome: "proposed", pr: PR, warnings: ["no run reported 'ci'", "x"] })).toEqual({
      tone: "warn",
      text: "Proposed. The change applies once the PR is merged and the loops are restarted. Warnings: no run reported 'ci'; x",
      url: PR.url,
    });
    expect(projectSaveNotice({ outcome: "reused", pr: PR, warnings: ["w"] })).toEqual({
      tone: "warn",
      text: "A PR for this change is already open. It applies once that PR is merged and the loops are restarted. Warnings: w",
      url: PR.url,
    });
  });

  it("says why a proposal was refused or its PR not opened", () => {
    expect(projectSaveNotice({ outcome: "refused", why: "no change" })).toEqual({ tone: "bad", text: "Not proposed: no change" });
    expect(projectSaveNotice({ outcome: "pr-failed", why: "gh down" })).toEqual({
      tone: "warn",
      text: "The settings branch may be pushed, but the PR was not opened: gh down",
    });
  });
});

const OWN: ProjectSettingsView = { ...view(), worktreesDir: "/srv/wt", worktreesDefault: false };

describe("worktreesFormFromView", () => {
  it("is empty when the project uses the default folder", () => {
    expect(worktreesFormFromView(view())).toBe("");
  });

  it("holds the project's own folder", () => {
    expect(worktreesFormFromView(OWN)).toBe("/srv/wt");
  });
});

describe("worktreesFolderProblems", () => {
  it("accepts an absolute path", () => {
    expect(worktreesFolderProblems("/srv/wt")).toEqual([]);
  });

  it("asks for a folder when the input is blank", () => {
    expect(worktreesFolderProblems("")).toEqual(["enter a folder, or use the default"]);
    expect(worktreesFolderProblems("   ")).toEqual(["enter a folder, or use the default"]);
  });

  it("refuses a relative path in the server's words", () => {
    expect(worktreesFolderProblems("wt")).toEqual(["must be an absolute path; got 'wt'"]);
    expect(worktreesFolderProblems("~/wt")).toEqual(["must be an absolute path; got '~/wt'"]);
  });
});

describe("worktreesEditFromForm", () => {
  it("is null while the input holds the folder in effect", () => {
    expect(worktreesEditFromForm("", view())).toBeNull();
    expect(worktreesEditFromForm("/srv/wt", OWN)).toBeNull();
  });

  it("sends the folder as typed", () => {
    expect(worktreesEditFromForm("/srv/other", OWN)).toEqual({ folder: "/srv/other" });
    expect(worktreesEditFromForm("/srv/wt", view())).toEqual({ folder: "/srv/wt" });
    expect(worktreesEditFromForm("", OWN)).toEqual({ folder: "" });
  });
});

describe("worktreesSaveNotice", () => {
  it("says where new worktrees go, and when that is the default", () => {
    expect(worktreesSaveNotice({ project: "loggd", worktreesDir: "/srv/wt", worktreesDefault: false, defaultWorktreesDir: "/home/op/wt" })).toEqual({
      tone: "good",
      text: "Saved: new worktrees go in /srv/wt",
    });
    expect(
      worktreesSaveNotice({ project: "loggd", worktreesDir: "/home/op/wt", worktreesDefault: true, defaultWorktreesDir: "/home/op/wt" }),
    ).toEqual({ tone: "good", text: "Saved: new worktrees go in /home/op/wt (default)" });
  });
});

const GATED: ProjectSettingsView = view({
  repo: "felipearos/loggd",
  owner: null,
  baseBranch: "main",
  displayName: "Loggd",
  gates: [
    { name: "test", command: "bun run test" },
    { name: "lint", command: "bun run lint" },
  ],
  requiredChecks: ["buildkite/loggd", "vercel"],
  refuseFiles: [".env.local"],
  worktreeSetup: [],
});

describe("gatesFormFromView", () => {
  it("seeds the gates and one list entry per line", () => {
    expect(gatesFormFromView(GATED)).toEqual({
      gates: [
        { name: "test", command: "bun run test" },
        { name: "lint", command: "bun run lint" },
      ],
      requiredChecks: "buildkite/loggd\nvercel",
      refuseFiles: ".env.local",
    });
  });

  it("is empty when the config could not be read", () => {
    expect(gatesFormFromView(view(null))).toEqual({ gates: [], requiredChecks: "", refuseFiles: "" });
  });
});

describe("gatesFormList", () => {
  it("splits on newlines, trims each line and drops blank ones", () => {
    expect(gatesFormList("  a \n\n b\r\nc\r   \n")).toEqual(["a", "b", "c"]);
    expect(gatesFormList("")).toEqual([]);
  });
});

describe("gatesFormProblems", () => {
  it("accepts a valid draft", () => {
    expect(gatesFormProblems(gatesFormFromView(GATED))).toEqual([]);
  });

  it("lists every problem at once, in the server's and the harness's words", () => {
    expect(
      gatesFormProblems({
        gates: [
          { name: "", command: "x" },
          { name: "Test", command: "a\nb" },
          { name: "lint", command: " " },
          { name: "lint", command: "y" },
        ],
        requiredChecks: "ci",
        refuseFiles: "ok\n/abs\n../up\na/../../x",
      }),
    ).toEqual([
      "'refuseFiles[1]' must be relative to the project root",
      "'refuseFiles[2]' must stay inside the project",
      "'refuseFiles[3]' must stay inside the project",
      "gate name 1 must not be empty",
      "gate name 'lint' is listed more than once",
      "gate name 'Test' must be lowercase kebab-case",
      "'gates.Test' must be a one-line command",
      "'gates.lint' must be a one-line command",
    ]);
  });

  it("refuses a path with whitespace inside it but not one that stays in", () => {
    expect(gatesFormProblems({ gates: [], requiredChecks: "", refuseFiles: "a b\nok/../fine\n./ok\na/.." })).toEqual([
      "'refuseFiles[0]' must not contain whitespace",
    ]);
  });
});

describe("gatesEditFromForm", () => {
  it("is null when nothing changed, blank lines and spaces aside", () => {
    expect(gatesEditFromForm(gatesFormFromView(GATED), GATED)).toBeNull();
    expect(gatesEditFromForm({ ...gatesFormFromView(GATED), requiredChecks: " buildkite/loggd\n\nvercel \n" }, GATED)).toBeNull();
  });

  it("carries only the changed key", () => {
    const seed = gatesFormFromView(GATED);
    expect(gatesEditFromForm({ ...seed, refuseFiles: ".env.local\nsecrets/" }, GATED)).toEqual({ refuseFiles: [".env.local", "secrets/"] });
    expect(gatesEditFromForm({ ...seed, requiredChecks: "vercel" }, GATED)).toEqual({ requiredChecks: ["vercel"] });
    expect(gatesEditFromForm({ ...seed, gates: [{ name: "test", command: "bun test" }] }, GATED)).toEqual({
      gates: [{ name: "test", command: "bun test" }],
    });
  });

  it("counts a reorder of the gates as a change", () => {
    const seed = gatesFormFromView(GATED);
    expect(gatesEditFromForm({ ...seed, gates: [...seed.gates].reverse() }, GATED)).toEqual({
      gates: [
        { name: "lint", command: "bun run lint" },
        { name: "test", command: "bun run test" },
      ],
    });
  });
});

describe("gatesEditProblems", () => {
  it("checks only the keys it would send", () => {
    const seed = gatesFormFromView(GATED);
    expect(gatesEditProblems(seed, GATED)).toEqual([]);
    expect(gatesEditProblems({ ...seed, refuseFiles: "/abs" }, GATED)).toEqual(["'refuseFiles[0]' must be relative to the project root"]);
    expect(gatesEditProblems({ ...seed, gates: [{ name: "x y", command: "z" }] }, GATED)).toEqual(["gate name 'x y' must be lowercase kebab-case"]);
  });
});

describe("the worktree setup form", () => {
  const STEPS = [
    { name: "env", command: 'cp "$RALPH_MAIN_CHECKOUT/.env" .', timeoutSeconds: 5, installsDependencies: false },
    { name: "install", command: "bun install", timeoutSeconds: 120, installsDependencies: true },
  ];
  const withSteps = (): ProjectSettingsView => {
    const base = view();
    return { ...base, config: { ...base.config!, worktreeSetup: STEPS } };
  };

  it("seeds one row per step, the limit as text", () => {
    expect(setupFormFromView(withSteps())).toEqual({
      steps: [
        { name: "env", command: 'cp "$RALPH_MAIN_CHECKOUT/.env" .', timeoutSeconds: "5", installsDependencies: false },
        { name: "install", command: "bun install", timeoutSeconds: "120", installsDependencies: true },
      ],
    });
    expect(setupFormFromView(view())).toEqual({ steps: [] });
    expect(setupFormFromView(view(null))).toEqual({ steps: [] });
  });

  it("proposes nothing for the seed, nor for a blank limit where the seed has the default", () => {
    const seeded = withSteps();
    const form = setupFormFromView(seeded);
    expect(setupEditFromForm(form, seeded)).toBeNull();
    expect(setupEditProblems(form, seeded)).toEqual([]);
    const blank = { steps: form.steps.map((step, index) => (index === 1 ? { ...step, timeoutSeconds: " " } : step)) };
    expect(setupEditFromForm(blank, seeded)).toBeNull();
  });

  it("sends every step complete, a blank limit as the default", () => {
    const seeded = withSteps();
    const form = setupFormFromView(seeded);
    const next = { steps: [...form.steps, { name: "seed", command: "bun run seed", timeoutSeconds: "", installsDependencies: false }] };
    expect(setupEditFromForm(next, seeded)).toEqual({
      worktreeSetup: [...STEPS, { name: "seed", command: "bun run seed", timeoutSeconds: 120, installsDependencies: false }],
    });
  });

  it("treats a reorder, a flag flip and an emptied list as changes", () => {
    const seeded = withSteps();
    const form = setupFormFromView(seeded);
    expect(setupEditFromForm({ steps: [...form.steps].reverse() }, seeded)).toEqual({ worktreeSetup: [...STEPS].reverse() });
    const flipped = { steps: form.steps.map((step) => ({ ...step, installsDependencies: !step.installsDependencies })) };
    expect(setupEditFromForm(flipped, seeded)?.worktreeSetup?.map((step) => step.installsDependencies)).toEqual([true, false]);
    expect(setupEditFromForm({ steps: [] }, seeded)).toEqual({ worktreeSetup: [] });
    expect(setupEditProblems({ steps: [] }, seeded)).toEqual([]);
  });

  it("refuses bad steps all at once, in the harness's words and order", () => {
    const form = {
      steps: [
        { name: "Bad", command: "a\nb", timeoutSeconds: "0", installsDependencies: false },
        { name: "ok", command: "x", timeoutSeconds: "1.5", installsDependencies: false },
        { name: "ok", command: " ", timeoutSeconds: "", installsDependencies: false },
        { name: "z", command: "y", timeoutSeconds: "150", installsDependencies: false },
      ],
    };
    expect(setupFormProblems(form)).toEqual([
      "'worktreeSetup[0].name' must be lowercase kebab-case; got \"Bad\"",
      "'worktreeSetup[0].command' must be a one-line command",
      "'worktreeSetup[0].timeoutSeconds' must be a whole number of seconds from 1 to 150; got 0",
      "'worktreeSetup[1].timeoutSeconds' must be a whole number of seconds from 1 to 150; got 1.5",
      "'worktreeSetup[2].name' 'ok' is a duplicate; every step needs its own name",
      "'worktreeSetup[2].command' must be a one-line command",
      "'worktreeSetup' may take at most 150 s in all (every step's 'timeoutSeconds', 120 when unset), because the dashboard runs the steps inside one request and its server times out an idle request at 255 s; these add up to 270 s",
    ]);
    expect(setupTotalSeconds(form)).toBe(270);
    expect(setupEditProblems(form, withSteps())).toEqual(setupFormProblems(form));
  });

  it("names a limit that is not a number as typed", () => {
    expect(setupFormProblems({ steps: [{ name: "a", command: "x", timeoutSeconds: "abc", installsDependencies: false }] })).toEqual([
      "'worktreeSetup[0].timeoutSeconds' must be a whole number of seconds from 1 to 150; got \"abc\"",
    ]);
  });
});
