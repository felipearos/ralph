// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GATE_EDIT_KEYS,
  OPTIONAL_KEYS,
  PROJECT_EDIT_KEYS,
  RESERVED_GATE_NAMES,
  TOP_LEVEL_KEYS,
  WORKTREE_SETUP_DEFAULT_SECONDS,
  WORKTREE_SETUP_EDIT_KEYS,
  WORKTREE_SETUP_MAX_SECONDS,
  parseProjectConfig,
} from "../project-config";
import { gateNameProblems } from "./agents";
import { SETUP_DEFAULT_TIMEOUT_SECONDS } from "./agents-adapter";
import { PROJECT_EDIT_KEYS as ROUTE_EDIT_KEYS } from "./agents-routes";
import { checkWorktreesFolder } from "./projects";
import {
  RESERVED_GATE_NAMES as FORM_RESERVED_GATE_NAMES,
  gateListProblems,
  GATES_FORM_KEYS,
  gatesFormLists,
  gatesFormProblems,
  projectFormProblems,
  SETUP_DEFAULT_SECONDS,
  SETUP_MAX_SECONDS,
  setupFormProblems,
  setupTimeoutValue,
  WORKTREE_SETUP_FORM_KEYS,
  worktreesFolderProblems,
  type GatesForm,
  type ProjectForm,
  type SetupForm,
} from "./ui/settings-form-model";

/**
 * The Settings Edit form copies the harness's `displayName` and `baseBranch`
 * checks because the page may not import the harness. This holds the copy to
 * the original: a whole config carrying the form's values is refused by
 * `parseProjectConfig` exactly when the form refuses them, and in its words.
 */
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "loggd", ".ralph", "config.json"), "utf8")) as Record<
  string,
  unknown
>;

const configText = (form: ProjectForm): string => JSON.stringify({ ...FIXTURE, ...form });

const VALID: ProjectForm = { displayName: "Loggd", baseBranch: "main" };

const NAMES = ["Loggd", "Loggd web", "", "   ", "two\nlines", "carriage\rreturn", "-x", "a b", "release/2", "feat.x"];
const BRANCHES = ["main", "", "   ", "two\nlines", "-x", "a b", "release/2", "feat.x", ".hidden", "dev"];

const CASES: [string, ProjectForm][] = [
  ...NAMES.map((displayName): [string, ProjectForm] => [`displayName ${JSON.stringify(displayName)}`, { ...VALID, displayName }]),
  ...BRANCHES.map((baseBranch): [string, ProjectForm] => [`baseBranch ${JSON.stringify(baseBranch)}`, { ...VALID, baseBranch }]),
  ["both refused", { displayName: " ", baseBranch: "a b" }],
];

describe("the settings form refuses what the config refuses, in its words", () => {
  it.each(CASES)("%s", (_label, form) => {
    const problems = projectFormProblems(form);
    let thrown: string | null = null;
    try {
      parseProjectConfig(configText(form));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown === null, thrown ?? "accepted").toBe(problems.length === 0);
    for (const problem of problems) expect(thrown).toContain(problem);
  });

  it("covers both an accepted and a refused case", () => {
    expect(CASES.some(([, form]) => projectFormProblems(form).length === 0)).toBe(true);
    expect(CASES.some(([, form]) => projectFormProblems(form).length > 0)).toBe(true);
  });
});

/**
 * The Agent worktrees form checks only a folder's shape; writability and
 * "inside another checkout" are the server's alone. A relative path is refused
 * by both in the same words, and an absolute one the form accepts never gets
 * the server's "absolute" refusal.
 */
const RELATIVE = ["wt", "./wt", "../wt", "~/wt", " /wt", "worktrees/loggd"];
const ABSOLUTE = ["/tmp", "/tmp/ralph-parity-wt/nested", "/"];

describe("the worktrees form refuses a relative folder as the server does, in its words", () => {
  it.each(RELATIVE)("%j", (folder) => {
    const problems = worktreesFolderProblems(folder);
    expect(problems).toHaveLength(1);
    expect(checkWorktreesFolder(folder, [])).toBe(problems[0]);
  });

  it.each(ABSOLUTE)("accepts %j without the server's absolute refusal", (folder) => {
    expect(worktreesFolderProblems(folder)).toEqual([]);
    expect(checkWorktreesFolder(folder, []) ?? "").not.toContain("must be an absolute path");
  });
});

/**
 * The Gates form (#692) copies the harness's gate, required-check and
 * refused-file checks. The config's gates are a name → command object, which
 * cannot hold an empty or a repeated name; those are the server's own checks,
 * so they stay out of this table.
 */
const gatesConfigText = (form: GatesForm): string => {
  const lists = gatesFormLists(form);
  return JSON.stringify({
    ...FIXTURE,
    gates: Object.fromEntries(form.gates.map((gate) => [gate.name, gate.command])),
    requiredChecks: lists.requiredChecks,
    refuseFiles: lists.refuseFiles,
  });
};

const GATES_VALID: GatesForm = {
  gates: [
    { name: "test", command: "bun run test" },
    { name: "type-check2", command: "bun run typecheck" },
  ],
  requiredChecks: "buildkite/loggd\nvercel",
  refuseFiles: ".env.local\nsecrets/",
};

const PATHS = ["/abs", "../up", "..", "a b", "a/../../x", "./../x", "./ok", "ok/../fine", "a/..", "dir/"];

const GATE_CASES: [string, GatesForm][] = [
  ["valid", GATES_VALID],
  ["no gates, no lists", { gates: [], requiredChecks: "", refuseFiles: "" }],
  ["reserved name", { ...GATES_VALID, gates: [{ name: "retry-seconds", command: "x" }] }],
  ["reserved name, bad command", { ...GATES_VALID, gates: [{ name: "env", command: "" }] }],
  ["bad kebab name", { ...GATES_VALID, gates: [{ name: "Test", command: "x" }] }],
  ["name with a space", { ...GATES_VALID, gates: [{ name: "a b", command: "x" }] }],
  ["name starting with a digit", { ...GATES_VALID, gates: [{ name: "1x", command: "x" }] }],
  ["multi-line command", { ...GATES_VALID, gates: [{ name: "test", command: "a\nb" }] }],
  ["carriage return in a command", { ...GATES_VALID, gates: [{ name: "test", command: "a\rb" }] }],
  ["blank command", { ...GATES_VALID, gates: [{ name: "test", command: "  " }] }],
  ["required checks with blank lines", { ...GATES_VALID, requiredChecks: "\n ci \n\n" }],
  ...PATHS.map((path): [string, GatesForm] => [`refuseFiles ${JSON.stringify(path)}`, { ...GATES_VALID, refuseFiles: `ok\n${path}` }]),
  [
    "several bad at once",
    { gates: [{ name: "Bad", command: "a\nb" }, { name: "ok", command: "" }], requiredChecks: "ci", refuseFiles: "/abs\n../up\na b" },
  ],
];

describe("the gates form refuses what the config refuses, in its words", () => {
  it.each(GATE_CASES)("%s", (_label, form) => {
    const problems = gatesFormProblems(form);
    let thrown: string | null = null;
    try {
      parseProjectConfig(gatesConfigText(form));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown === null, thrown ?? "accepted").toBe(problems.length === 0);
    for (const problem of problems) expect(thrown).toContain(problem);
  });

  it("covers both an accepted and a refused case", () => {
    expect(GATE_CASES.some(([, form]) => gatesFormProblems(form).length === 0)).toBe(true);
    expect(GATE_CASES.some(([, form]) => gatesFormProblems(form).length > 0)).toBe(true);
  });
});

/**
 * The Worktree setup form (#694) copies the harness's step checks. A blank
 * limit stands for the default, so the config it builds omits the key.
 */
const setupConfigText = (form: SetupForm): string =>
  JSON.stringify({
    ...FIXTURE,
    worktreeSetup: form.steps.map((step) => {
      const limit = setupTimeoutValue(step.timeoutSeconds);
      return {
        name: step.name,
        command: step.command,
        ...(limit === undefined ? {} : { timeoutSeconds: limit }),
        installsDependencies: step.installsDependencies,
      };
    }),
  });

type SetupStep = SetupForm["steps"][number];
const step = (name: string, command = "bun install", timeoutSeconds = "60", installsDependencies = false): SetupStep => ({
  name,
  command,
  timeoutSeconds,
  installsDependencies,
});
const SETUP_VALID: SetupForm = { steps: [step("env", 'cp "$RALPH_MAIN_CHECKOUT/.env" .', "5"), step("install", "bun install", "120", true)] };

const SETUP_CASES: [string, SetupForm][] = [
  ["valid", SETUP_VALID],
  ["empty", { steps: [] }],
  ["bad name", { steps: [step("Install")] }],
  ["name with a space", { steps: [step("a b")] }],
  ["empty name", { steps: [step("")] }],
  ["duplicate names", { steps: [step("install"), step("install", "bun run x")] }],
  ["blank command", { steps: [step("install", "  ")] }],
  ["multi-line command", { steps: [step("install", "a\nb")] }],
  ["carriage return in a command", { steps: [step("install", "a\rb")] }],
  ...["0", "151", "1.5", "abc", "-3", "150", "1", ""].map((limit): [string, SetupForm] => [`timeout ${JSON.stringify(limit)}`, { steps: [step("install", "x", limit)] }]),
  ["blank limits sum over the cap", { steps: [step("a", "x", ""), step("b", "y", "")] }],
  ["sum over 150", { steps: [step("a", "x", "120"), step("b", "y", "31")] }],
  ["sum exactly 150", { steps: [step("a", "x", "120"), step("b", "y", "30")] }],
  ["several bad at once", { steps: [step("Bad", "a\nb", "0"), step("ok", "", "abc"), step("ok", "x", ""), step("z", "y", "200")] }],
];

describe("the worktree setup form refuses what the config refuses, in its words", () => {
  it.each(SETUP_CASES)("%s", (_label, form) => {
    const problems = setupFormProblems(form);
    let thrown: string | null = null;
    try {
      parseProjectConfig(setupConfigText(form));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown === null, thrown ?? "accepted").toBe(problems.length === 0);
    for (const problem of problems) expect(thrown).toContain(problem);
  });

  it("covers both an accepted and a refused case", () => {
    expect(SETUP_CASES.some(([, form]) => setupFormProblems(form).length === 0)).toBe(true);
    expect(SETUP_CASES.some(([, form]) => setupFormProblems(form).length > 0)).toBe(true);
  });
});

/**
 * The AC is that a gate-related key added to the config later cannot
 * silently miss the Settings form: every key the schema knows is classified
 * here, by hand, as edited by a form or not (and why not). A new key fails
 * this until someone decides, and a new key in the harness's `GATE_EDIT_KEYS`
 * fails until the Gates form edits it.
 */
const FORM_EDITED = ["displayName", "baseBranch", ...GATES_FORM_KEYS, ...WORKTREE_SETUP_FORM_KEYS] as const;
const NOT_FORM_EDITED: Record<string, string> = {
  repo: "names the repository the checkout is; changing it is a new project, not an edit",
  owner: "who the loops act as; set at onboarding",
  secrets: "names a secrets manager scope; credentials stay on the host",
  envCheck: "an argv run on the host; edited in the config file",
  promptFragment: "a path to a prompt fragment, edited as a file",
  coderFragment: "a path to a prompt fragment, edited as a file",
  plan: "a path to the plan file, edited as a file",
  journal: "where iterations record; set at onboarding",
  loops: "the roster, edited by the Agents page",
  plugins: "plugin wiring, edited in the config file",
  executorGuard: "permission rails, edited in the config file",
  ciDoctor: "role config, edited in the config file",
  prMedic: "role config, edited in the config file",
  clerk: "role config, edited in the config file",
  verifier: "the verifier rules, proposed by their own rules form (proposeVerifier), not Settings",
  sentinel: "the sentinel rules, proposed by the Sentinel sheet's rules form (--set-sentinel); the reporter is edited in the config file",
  triage: "role config, edited in the config file",
  learnings: "where learnings go, edited in the config file",
  tracker: "which tracker the tickets live in; its credentials stay on the host",
  merge: "merge policy, edited in the config file",
  mergeMethod: "how a PR lands (Mergify, GitHub merge queue, or direct), edited in the config file",
  configChanges: "how a rules save lands (commit or PR), edited in the config file",
  screenshots: "UI screenshot setup, edited in the config file",
  appLabels: "the Slack intake's two app labels, set once beside the clerk in the config file",
  relayEvalPatches: "whether eval patches may leave the host, a privacy choice edited in the config file",
  evalSuggestionWeights: "the eval suggestion ranker's weights, edited in the config file",
  evalsNoiseFloor: "the noise floor's arm count and stale share, edited in the config file",
  evalsSaturation: "how many set runs make a case saturated, edited in the config file",
  evalsGuardrails: "the guardrail verdict's cost and token thresholds, edited in the config file",
  evalsImprover: "the improver's recommended-run size and failures-first rule, edited in the config file",
  usageStop: "the plan usage stop's committed default; the dashboard's edits go to the host-local override (usage-stop.ts)",
};

describe("every config key is classified", () => {
  const schemaKeys = [...TOP_LEVEL_KEYS, ...OPTIONAL_KEYS] as string[];

  it("classifies exactly the schema's keys", () => {
    const classified = [...FORM_EDITED, ...Object.keys(NOT_FORM_EDITED)];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...schemaKeys].sort());
  });

  it("edits every gate-related key the harness lists", () => {
    expect([...GATES_FORM_KEYS]).toEqual([...GATE_EDIT_KEYS]);
  });

  it("edits every worktree-setup key the harness lists", () => {
    expect([...WORKTREE_SETUP_FORM_KEYS]).toEqual([...WORKTREE_SETUP_EDIT_KEYS]);
  });

  it("copies the setup step limits project-config sets", () => {
    // The adapter and the form restate them because neither may import the harness.
    expect(SETUP_DEFAULT_TIMEOUT_SECONDS).toBe(WORKTREE_SETUP_DEFAULT_SECONDS);
    expect(SETUP_DEFAULT_SECONDS).toBe(WORKTREE_SETUP_DEFAULT_SECONDS);
    expect(SETUP_MAX_SECONDS).toBe(WORKTREE_SETUP_MAX_SECONDS);
  });

  it("edits exactly the keys the harness lets a Settings edit set", () => {
    expect([...FORM_EDITED].sort()).toEqual([...PROJECT_EDIT_KEYS].sort());
  });
});

/**
 * The other hand-kept copies the Gates edit rests on: the route's list of
 * keys it accepts (a key the harness and form gain but the route does not
 * would be refused as unknown), the reserved gate names, and the server's
 * empty/repeated name checks, which no config can express and so the
 * table above leaves out.
 */
describe("the Gates edit's other copies match their originals", () => {
  it("the route accepts exactly the keys the harness lets an edit set", () => {
    expect([...ROUTE_EDIT_KEYS].sort()).toEqual([...PROJECT_EDIT_KEYS].sort());
  });

  it("the form reserves exactly the gate names the harness does", () => {
    expect([...FORM_RESERVED_GATE_NAMES]).toEqual([...RESERVED_GATE_NAMES]);
  });

  const LISTS: [string, { name: string; command: string }[]][] = [
    ["distinct", [{ name: "test", command: "x" }, { name: "lint", command: "y" }]],
    ["an empty name", [{ name: "", command: "x" }, { name: "lint", command: "y" }]],
    ["a blank name", [{ name: "test", command: "x" }, { name: "  ", command: "y" }]],
    ["a repeated name", [{ name: "test", command: "x" }, { name: "test", command: "y" }]],
    ["both", [{ name: "", command: "x" }, { name: "a", command: "y" }, { name: "a", command: "z" }]],
  ];
  it.each(LISTS)("the form and the server name %s alike", (_label, gates) => {
    expect(gateListProblems(gates)).toEqual(gateNameProblems(gates));
  });
});
