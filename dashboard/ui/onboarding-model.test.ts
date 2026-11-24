import { describe, expect, it } from "vitest";

import {
  addRequest,
  cloneTarget,
  configFromForm,
  filterRepos,
  formFromConfig,
  gateChips,
  listChips,
  setupFiles,
  mergesWithoutCi,
  refusalView,
  inputRefusal,
  connectRequest,
  defaultStates,
  EMPTY_TRACKER,
  TRACKER_KINDS,
  setupPanel,
  setupStamp,
  trackerBlock,
  trackerHold,
  type SetupForm,
  type TrackerDraft,
} from "./onboarding-model";

describe("the add-project request", () => {
  it("sends an absolute local path, and explains a relative or empty one", () => {
    expect(addRequest("local", " /home/me/widget ")).toEqual({ body: { source: "local", path: "/home/me/widget" } });
    expect(addRequest("local", "widget")).toEqual({ error: "The path must be absolute, starting with /." });
    expect(addRequest("local", "")).toMatchObject({ error: expect.any(String) });
  });

  it("sends owner/name for GitHub, and explains anything else", () => {
    expect(addRequest("github", "acme/widget")).toEqual({ body: { source: "github", repo: "acme/widget" } });
    expect(addRequest("github", "widget")).toMatchObject({ error: expect.stringContaining("owner/name") });
  });

  it("filters repos by name or description", () => {
    const repos = [
      { nameWithOwner: "acme/widget", description: "A widget", isPrivate: false },
      { nameWithOwner: "acme/gadget", description: null, isPrivate: true },
    ];
    expect(filterRepos(repos, "GAD").map((repo) => repo.nameWithOwner)).toEqual(["acme/gadget"]);
    expect(filterRepos(repos, "a widget").map((repo) => repo.nameWithOwner)).toEqual(["acme/widget"]);
    expect(filterRepos(repos, " ")).toHaveLength(2);
    expect(filterRepos(repos, "acme/widget")).toHaveLength(2);
  });

  it("offers local registration when the clone target exists", () => {
    const exists = { kind: "CloneTargetExists", message: "exists", status: 409, path: "/home/me/widget" };
    expect(refusalView(exists)).toEqual({ error: exists, registerLocal: "/home/me/widget" });
    expect(refusalView({ kind: "AlreadyRegistered", message: "dup", status: 409 }).registerLocal).toBeNull();
    // The harness is never offered, even if a path came with the refusal.
    expect(refusalView({ kind: "HarnessCheckout", message: "harness", status: 409, path: "/home/me/ralph" }).registerLocal).toBeNull();
    // A refusal without a path offers nothing, whatever its kind.
    expect(refusalView({ kind: "CloneTargetExists", message: "exists", status: 409 }).registerLocal).toBeNull();
  });

  it("shapes an input refused before sending like a server refusal", () => {
    expect(inputRefusal("Enter a path.")).toEqual({
      error: { kind: "Invalid", message: "Enter a path.", status: null },
      registerLocal: null,
    });
  });
});

describe("the setup panel", () => {
  const view = (status: "needs-setup" | "setup-pending" | "ready", pr: { number: number; url: string } | null = null) => ({
    project: "widget",
    status,
    baseBranch: "main",
    pr,
  });

  it("shows the form when setup is needed, the PR while pending, and nothing when ready", () => {
    expect(setupPanel(null)).toEqual({ kind: "none" });
    expect(setupPanel(view("ready"))).toEqual({ kind: "none" });
    expect(setupPanel(view("needs-setup"))).toEqual({ kind: "form", baseBranch: "main" });
    expect(setupPanel(view("setup-pending", { number: 7, url: "https://x/pull/7" }))).toEqual({
      kind: "pending",
      url: "https://x/pull/7",
      number: 7,
      baseBranch: "main",
    });
  });

  it("stamps the header with a setup state while it needs setup or its PR is open, and nothing when ready", () => {
    expect(setupStamp(null)).toBeNull();
    expect(setupStamp(view("ready"))).toBeNull();
    expect(setupStamp(view("needs-setup"))).toEqual({
      label: "Needs setup",
      detail: "Its .ralph/config.json is not on origin/main yet.",
    });
    expect(setupStamp(view("setup-pending", { number: 7, url: "https://x/pull/7" }))).toMatchObject({ label: "Setup PR open" });
  });
});

describe("the setup form", () => {
  const defaults = {
    repo: "acme/widget",
    owner: "octo",
    baseBranch: "main",
    displayName: "widget",
    secrets: { runner: "none", withhold: [] },
    gates: { test: "bun run test", typecheck: "bun run typecheck" },
    loops: ["ralph"],
    requiredChecks: ["test"],
    plan: ".ralph/plan.md",
  };

  it("round-trips the defaults unchanged", () => {
    expect(configFromForm(defaults, formFromConfig(defaults))).toEqual(defaults);
  });

  it("reads gates one per line and loops by comma or space, keeping every other key", () => {
    const form = { ...formFromConfig(defaults), gates: "test: bun test\n\nlint:bun x eslint .\nbroken", loops: "ralph, rafa remo" };
    expect(configFromForm(defaults, form)).toEqual({
      ...defaults,
      gates: { test: "bun test", lint: "bun x eslint .", broken: "" },
      loops: ["ralph", "rafa", "remo"],
    });
  });

  it("round-trips a dotenv secrets block", () => {
    const dotenv = { ...defaults, secrets: { runner: "dotenv", file: ".env.ralph", withhold: ["DB_URL"] } };
    const form = formFromConfig(dotenv);
    expect(form).toMatchObject({ secretsRunner: "dotenv", secretsFile: ".env.ralph" });
    expect(configFromForm(dotenv, form)).toEqual(dotenv);
  });

  it("writes a dotenv block from none defaults, keeping their withhold, and sends a blank path for the server to name", () => {
    const form: SetupForm = { ...formFromConfig(defaults), secretsRunner: "dotenv", secretsFile: "  /srv/acme/.env  " };
    expect(configFromForm(defaults, form)).toEqual({ ...defaults, secrets: { runner: "dotenv", file: "/srv/acme/.env", withhold: [] } });
    expect(configFromForm(defaults, { ...form, secretsFile: " " }).secrets).toEqual({ runner: "dotenv", file: "", withhold: [] });
  });

  it("drops the file when the choice goes back to none", () => {
    const dotenv = { ...defaults, secrets: { runner: "dotenv", file: ".env.ralph", withhold: ["DB_URL"] } };
    const form: SetupForm = { ...formFromConfig(dotenv), secretsRunner: "none" };
    expect(configFromForm(dotenv, form).secrets).toEqual({ runner: "none", withhold: ["DB_URL"] });
  });

  it("passes a doppler block through unchanged when the choice is left alone", () => {
    const doppler = { ...defaults, secrets: { runner: "doppler", project: "acme", config: "dev", withhold: ["X"] } };
    const form = formFromConfig(doppler);
    expect(form.secretsRunner).toBe("doppler");
    expect(configFromForm(doppler, form)).toEqual(doppler);
    expect(configFromForm(doppler, { ...form, secretsRunner: "none" }).secrets).toEqual({ runner: "none", withhold: ["X"] });
  });

  it("lists the files the setup PR writes where they really go, project-relative", () => {
    expect(setupFiles(null)).toEqual([".ralph/config.json", ".ralph/prompt.md", ".ralph/coder.md", ".ralph/plan.md"]);
    expect(setupFiles({ promptFragment: ".ralph/prompt.md", coderFragment: "docs/coder.md", plan: "" })).toEqual([
      ".ralph/config.json",
      ".ralph/prompt.md",
      "docs/coder.md",
      ".ralph/plan.md",
    ]);
  });

  it("chips each gate line with its line number, flagging a line without a colon and a repeat", () => {
    const form = { ...formFromConfig(defaults), gates: "test: pnpm test\n\nlint pnpm lint\ntest: again" };
    expect(gateChips(form)).toEqual([
      { name: "test", line: 1, problem: null },
      { name: "lint pnpm lint", line: 3, problem: "no-colon" },
      { name: "test", line: 4, problem: "repeated" },
    ]);
  });

  it("chips each list as the config will split it, marking a repeat", () => {
    const form = { ...formFromConfig(defaults), loops: "ralph, rafa,", requiredChecks: "test, Vercel – loggd,, test" };
    expect(listChips(form, "loops")).toEqual([
      { name: "ralph", repeated: false },
      { name: "rafa", repeated: false },
    ]);
    expect(listChips(form, "requiredChecks")).toEqual([
      { name: "test", repeated: false },
      { name: "Vercel – loggd", repeated: false },
      { name: "test", repeated: true },
    ]);
  });

  it("shows and edits requiredChecks, split on commas only", () => {
    expect(formFromConfig({ ...defaults, requiredChecks: ["test", "buildkite/loggd"] }).requiredChecks).toBe("test, buildkite/loggd");
    const form = { ...formFromConfig(defaults), requiredChecks: "test, Vercel – loggd,, buildkite/loggd " };
    expect(configFromForm(defaults, form).requiredChecks).toEqual(["test", "Vercel – loggd", "buildkite/loggd"]);
  });

  it("asks for an acknowledgement when no required check is named", () => {
    expect(mergesWithoutCi(formFromConfig(defaults))).toBe(false);
    expect(mergesWithoutCi({ ...formFromConfig(defaults), requiredChecks: " , " })).toBe(true);
    expect(mergesWithoutCi(formFromConfig({ ...defaults, requiredChecks: [] }))).toBe(true);
  });
});

describe("the Tracker connector's model", () => {
  const linear: TrackerDraft = { ...EMPTY_TRACKER, kind: "linear", apiKey: " lin_api_x ", key: "AND", workspace: "exampleorg", claimed: "In Progress", done: "Done" };
  const jira: TrackerDraft = {
    ...EMPTY_TRACKER,
    kind: "jira",
    site: "https://example.atlassian.net/jira/your-work",
    email: "operator@example.com",
    apiToken: "t",
    key: "OA",
    claimed: "In Progress",
    done: "Done",
  };

  it("sends nothing until the token is filled in, and nothing for GitHub", () => {
    expect(connectRequest(EMPTY_TRACKER)).toBeNull();
    expect(connectRequest({ ...EMPTY_TRACKER, kind: "linear" })).toBeNull();
    expect(connectRequest({ ...jira, apiToken: "" })).toBeNull();
  });

  it("sends the token, and the team or project once one is picked", () => {
    expect(connectRequest({ ...linear, key: "" })).toEqual({ kind: "linear", apiKey: "lin_api_x" });
    expect(connectRequest(linear)).toEqual({ kind: "linear", apiKey: "lin_api_x", team: "AND" });
    // A pasted URL is reduced to the host the config and the API want.
    expect(connectRequest(jira)).toEqual({ kind: "jira", site: "example.atlassian.net", email: "operator@example.com", apiToken: "t", project: "OA" });
  });

  it("preselects the states Linear and Jira ship with, else the first and last", () => {
    expect(defaultStates(["Backlog", "Todo", "In Progress", "Done", "Canceled"])).toEqual({ claimed: "In Progress", done: "Done" });
    expect(defaultStates(["Abierto", "En curso", "Cerrado"])).toEqual({ claimed: "Abierto", done: "Cerrado" });
    expect(defaultStates([])).toEqual({ claimed: "", done: "" });
  });

  it("writes the tracker block the harness validates, and none for GitHub", () => {
    expect(trackerBlock(EMPTY_TRACKER)).toBeNull();
    expect(trackerBlock({ ...linear, scopeLabel: " acme-backoffice " })).toEqual({
      kind: "linear",
      team: "AND",
      workspace: "exampleorg",
      scopeLabel: "acme-backoffice",
      states: { claimed: "In Progress", done: "Done" },
    });
    expect(trackerBlock(jira)).toEqual({ kind: "jira", site: "example.atlassian.net", project: "OA", states: { claimed: "In Progress", done: "Done" } });
    // The token is never part of the config the setup PR commits.
    expect(JSON.stringify(trackerBlock(linear))).not.toContain("lin_api_x");
    expect(JSON.stringify(trackerBlock(jira))).not.toContain('"t"');
  });

  it("holds the setup PR until the connection is picked and saved", () => {
    expect(trackerHold(EMPTY_TRACKER, false)).toBeNull();
    expect(trackerHold({ ...linear, key: "" }, false)).toBe("pick the Linear team first");
    expect(trackerHold({ ...jira, done: "" }, false)).toBe("pick the claimed and done states first");
    expect(trackerHold(linear, false)).toBe("save the tracker connection first, so the loops can reach it");
    expect(trackerHold(linear, true)).toBeNull();
  });

  it("puts the block on the candidate config", () => {
    const form = formFromConfig({ repo: "a/b", owner: "o", baseBranch: "main", displayName: "B", gates: {}, loops: ["ralph"], requiredChecks: [] });
    expect(configFromForm({}, form, trackerBlock(linear)).tracker).toMatchObject({ kind: "linear", team: "AND" });
    expect("tracker" in configFromForm({}, form)).toBe(false);
  });
});

describe("the trackers the connector offers", () => {
  it("are GitHub, Linear and Jira, never the sandbox's local tracker (#527)", () => {
    expect(TRACKER_KINDS.map(({ kind }) => kind)).toEqual(["github", "linear", "jira"]);
    expect(TRACKER_KINDS.map(({ kind }) => kind as string)).not.toContain("local");
  });
});

describe("cloneTarget", () => {
  it("names the ~/<name> folder the server clones into", () => {
    expect(cloneTarget(" you/widget ")).toEqual({ repo: "you/widget", folder: "~/widget" });
  });

  it("is null until the input is a whole owner/name", () => {
    expect(cloneTarget("")).toBeNull();
    expect(cloneTarget("wid")).toBeNull();
    expect(cloneTarget("you/")).toBeNull();
  });
});
