// @vitest-environment node
import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { STOP_SIGILS } from "./phase";
import { ROLES, SIGILS, roleDescriptor } from "./roles";
import { shellQuote } from "./project-config";
import { secretValuesFrom } from "./runner-failure";
import { exportLines, roleBehaviour, secretsFor } from "./role-behaviour";

const HARNESS = __dirname;

/** The module's own CLI, as `ralph.sh` runs it. */
const run = (...argv: string[]): string =>
  execFileSync("bun", [join(HARNESS, "role-behaviour.ts"), ...argv], { encoding: "utf8" }).trimEnd();

/** `eval`'s the export lines in a shell and reads one variable back, as the supervisor does. */
const evalled = (role: string, variable: string): string =>
  execFileSync(
    "bash",
    ["-c", `eval "$(bun ${JSON.stringify(join(HARNESS, "role-behaviour.ts"))} --export ${role})"; printf '%s' "\${${variable}}"`],
    { encoding: "utf8" },
  );

describe("the behaviour a role hands the supervisor", () => {
  it("answers for every role", () => {
    for (const role of ROLES) expect(roleBehaviour(role).role).toBe(role);
  });

  it("keeps the stop sigils in the phase roster's order, filtered and never re-ordered", () => {
    // The order mirrors `phase.ts` so the two read the same way. It is not what
    // decides the supervisor's precedence — `ralph.sh` turns this list into one
    // `grep -E` alternation — which is why re-ordering is safe and drifting
    // from the roster is not.
    expect(roleBehaviour("coder").stopSigils).toEqual(["NEEDS_TRIAGE", "RETRY_LATER", "COMPLETE", "ALL_BLOCKED", "DONE"]);
    expect(roleBehaviour("ci-doctor").stopSigils).toEqual(["NEEDS_TRIAGE", "RETRY_LATER", "ALL_BLOCKED", "DONE"]);
    expect(roleBehaviour("triager").stopSigils).toEqual(["NEEDS_TRIAGE", "RETRY_LATER", "ALL_BLOCKED", "DONE"]);
    // Filtered from `phase.ts`'s roster, so a sigil added there flows through
    // rather than being dropped by a copy of the list kept here.
    expect(roleBehaviour("coder").stopSigils).toEqual([...STOP_SIGILS]);
    for (const role of ROLES) {
      // Stop sigils are exactly the role's sigils that are terminal: a
      // hand-back must never be settled as an ending.
      expect(roleBehaviour(role).stopSigils.every((sigil) => roleDescriptor(role).sigils.includes(sigil))).toBe(true);
      for (const sigil of ["AWAIT_PR", "AWAIT_HOST", "PHASE"]) {
        expect(roleBehaviour(role).stopSigils).not.toContain(sigil);
      }
    }
  });

  it("splits the secrets by target, and lists one wanted by both in both", () => {
    expect(roleBehaviour("coder")).toMatchObject({
      iterationSecrets: ["RALPH_BUILDKITE_READ_TOKEN"],
      gateSecrets: [],
      allSecrets: ["RALPH_BUILDKITE_READ_TOKEN"],
    });
    // The triager's Jira token moves a to-person report from its gate (#397).
    expect(roleBehaviour("triager")).toMatchObject({
      iterationSecrets: [],
      gateSecrets: ["RALPH_CLERK_JIRA_TOKEN"],
      allSecrets: ["RALPH_CLERK_JIRA_TOKEN"],
    });
    expect(roleBehaviour("ci-doctor")).toMatchObject({
      iterationSecrets: ["RALPH_BUILDKITE_READ_TOKEN"],
      gateSecrets: ["RALPH_BUILDKITE_READ_TOKEN", "RALPH_BUILDKITE_RETRY_TOKEN"],
    });
    expect(secretsFor("ci-doctor", "gate").map((secret) => secret.name)).toEqual([
      "RALPH_BUILDKITE_READ_TOKEN",
      "RALPH_BUILDKITE_RETRY_TOKEN",
    ]);
  });

  it("lists every other role's secrets as foreign, and never its own", () => {
    // This is the list `ralph.sh` strips by name, and the manager injects the
    // whole scope into every child: a name missing from it is a credential
    // another role acts with, handed to a loop that declared nothing.
    // Sorted: the list follows the roles' declaration order, which says nothing.
    expect([...roleBehaviour("coder").foreignSecrets].sort()).toEqual([
      "RALPH_BUILDKITE_RETRY_TOKEN",
      "RALPH_CLERK_JIRA_TOKEN",
      "RALPH_CLERK_SLACK_TOKEN",
      "RALPH_SENTINEL_SENTRY_TOKEN",
      "RALPH_VERIFIER_SENTRY_TOKEN",
      "RALPH_VERIFIER_VERCEL_TOKEN",
    ]);
    // The triager declares only the Jira token (#397), so every other name is
    // foreign to it, the clerk's Slack token included.
    expect([...roleBehaviour("triager").foreignSecrets].sort()).toEqual([
      "RALPH_BUILDKITE_READ_TOKEN",
      "RALPH_BUILDKITE_RETRY_TOKEN",
      "RALPH_CLERK_SLACK_TOKEN",
      "RALPH_SENTINEL_SENTRY_TOKEN",
      "RALPH_VERIFIER_SENTRY_TOKEN",
      "RALPH_VERIFIER_VERCEL_TOKEN",
    ]);
    // The doctor declares both Buildkite tokens, so only the clerk's, the verifier's and the sentinel's are.
    expect([...roleBehaviour("ci-doctor").foreignSecrets].sort()).toEqual([
      "RALPH_CLERK_JIRA_TOKEN",
      "RALPH_CLERK_SLACK_TOKEN",
      "RALPH_SENTINEL_SENTRY_TOKEN",
      "RALPH_VERIFIER_SENTRY_TOKEN",
      "RALPH_VERIFIER_VERCEL_TOKEN",
    ]);
    // The clerk's Slack token reaches no other role (felipearos/ralph#317):
    // every one of them strips it by name, whatever the manager injects.
    for (const role of ROLES.filter((other) => other !== "clerk")) {
      // The triager holds the Jira token at its gate (#397); it is checked below.
      const tokens = role === "triager" ? ["RALPH_CLERK_SLACK_TOKEN"] : ["RALPH_CLERK_SLACK_TOKEN", "RALPH_CLERK_JIRA_TOKEN"];
      for (const token of tokens) {
        expect(roleBehaviour(role).foreignSecrets, role).toContain(token);
        expect(roleBehaviour(role).gateSecrets, role).not.toContain(token);
        expect(roleBehaviour(role).iterationSecrets, role).not.toContain(token);
      }
    }
    // And within the clerk both go to the gate alone: no model session holds
    // a Slack or Jira credential (felipearos/ralph#318 AC 5).
    expect(roleBehaviour("clerk").gateSecrets).toEqual(["RALPH_CLERK_SLACK_TOKEN", "RALPH_CLERK_JIRA_TOKEN"]);
    expect(roleBehaviour("clerk").iterationSecrets).toEqual([]);
    // The verifier's read tokens go to its gate alone too (felipearos/ralph#561):
    // the session that reads production pages never holds one, and no other
    // role is handed either.
    expect(roleBehaviour("verifier").gateSecrets).toEqual(["RALPH_VERIFIER_SENTRY_TOKEN", "RALPH_VERIFIER_VERCEL_TOKEN"]);
    expect(roleBehaviour("verifier").iterationSecrets).toEqual([]);
    for (const role of ROLES.filter((other) => other !== "verifier")) {
      expect(roleBehaviour(role).foreignSecrets, role).toEqual(expect.arrayContaining(["RALPH_VERIFIER_SENTRY_TOKEN", "RALPH_VERIFIER_VERCEL_TOKEN"]));
    }
    // The sentinel's reporter token goes to its gate alone (felipearos/ralph#681):
    // the session that reads production stack frames never holds it, and no
    // other role is handed it.
    expect(roleBehaviour("sentinel").gateSecrets).toEqual(["RALPH_SENTINEL_SENTRY_TOKEN"]);
    expect(roleBehaviour("sentinel").iterationSecrets).toEqual([]);
    for (const role of ROLES.filter((other) => other !== "sentinel")) {
      expect(roleBehaviour(role).foreignSecrets, role).toContain("RALPH_SENTINEL_SENTRY_TOKEN");
    }
    expect(roleBehaviour("triager").iterationSecrets).not.toContain("RALPH_CLERK_JIRA_TOKEN");
    for (const role of ROLES) {
      const behaviour = roleBehaviour(role);
      for (const own of behaviour.allSecrets) {
        expect(behaviour.foreignSecrets, `${role} would strip its own ${own}`).not.toContain(own);
      }
      // Together they are every declared secret in the system: the strip list
      // and the read list must cover the scope between them.
      const every = new Set(ROLES.flatMap((other) => roleDescriptor(other).secrets.named.map((secret) => secret.name)));
      expect(new Set([...behaviour.allSecrets, ...behaviour.foreignSecrets])).toEqual(every);
    }
  });

  it("maps every declared secret to a check, naming the command or the empty string", () => {
    expect(roleBehaviour("ci-doctor").checks).toEqual({
      RALPH_BUILDKITE_READ_TOKEN: "bk-log.ts --check-token",
      RALPH_BUILDKITE_RETRY_TOKEN: "bk-log.ts --check-retry-token",
    });
    // A `check: null` must map to the empty string and NOT be dropped: dropped,
    // the supervisor would export an unproved credential as though it had
    // nothing to check. No role declares one today — #161 gave the retry token
    // the last outstanding checker — so the property is asserted over every
    // declaration there is, which is what keeps it true for the next secret
    // declared ahead of its check.
    for (const role of ROLES) {
      const behaviour = roleBehaviour(role);
      for (const secret of roleDescriptor(role).secrets.named) {
        expect(behaviour.checks).toHaveProperty(secret.name);
        expect(behaviour.checks[secret.name]).toBe(secret.check ?? "");
      }
      expect(Object.keys(behaviour.checks).sort()).toEqual(
        roleDescriptor(role).secrets.named.map((secret) => secret.name).sort(),
      );
    }
  });

  it("exports the orchestrator's rails for the pr-medic, and an empty value for every other role", () => {
    // Empty rather than absent, so an operator's environment cannot supply one.
    expect(evalled("pr-medic", "RALPH_ROLE_ORCHESTRATOR_SETTINGS")).toBe("pr-medic/orchestrator-settings.json");
    for (const role of ["coder", "triager", "ci-doctor"] as const) {
      expect(exportLines(role)).toContain("export RALPH_ROLE_ORCHESTRATOR_SETTINGS=''");
      expect(roleBehaviour(role).orchestratorSettings).toBe("");
    }
  });

  it("renders every value as a shell export, quoting everything that is not a flag", () => {
    for (const role of ROLES) {
      for (const line of exportLines(role)) {
        // A flag is a bare 0 or 1 and needs no quoting; everything else is
        // free text and gets it, prose and secret names alike.
        expect(line).toMatch(/^export RALPH_ROLE_[A-Z0-9_]+=(?:[01]|'.*')$/s);
      }
    }
  });

  it("survives eval: the recovery prompt carries angle brackets, sigils and an apostrophe", () => {
    // It is model-facing prose full of `<ralph>…</ralph>`. Unquoted it would be
    // a shell injection in the supervisor's own startup — so this round-trips
    // each descriptor's real text through `bash`, and one synthetic value
    // carrying the character `shellQuote` exists for, which no descriptor
    // happens to contain today.
    expect(
      execFileSync("bash", ["-c", `eval ${shellQuote(`X=${shellQuote("it's <ralph>DONE</ralph> 'quoted'")}`)}; printf '%s' "$X"`], {
        encoding: "utf8",
      }),
    ).toBe("it's <ralph>DONE</ralph> 'quoted'");
    for (const role of ROLES) {
      expect(evalled(role, "RALPH_ROLE_RECOVERY_PROMPT")).toBe(roleDescriptor(role).recoveryPrompt);
    }
    expect(evalled("coder", "RALPH_ROLE_SIGILS").split(" ").sort()).toEqual([...SIGILS].sort());
    expect(evalled("triager", "RALPH_ROLE_INVARIANT")).toBe("clean-detached");
    expect(evalled("triager", "RALPH_ROLE_SECRETS_MANAGER")).toBe("0");
    expect(evalled("coder", "RALPH_ROLE_SECRETS_MANAGER")).toBe("1");
    expect(evalled("triager", "RALPH_ROLE_PHASES")).toBe("0");
    expect(evalled("triager", "RALPH_ROLE_HOST_LEASE")).toBe("0");
    // The closed-ticket probe (#809): a tracker ticket for the coder alone: the
    // pr-medic's is a pull request's, the doctor's a case with its own store.
    expect(evalled("coder", "RALPH_ROLE_PHASE_TICKET_PROBE")).toBe("1");
    expect(evalled("ci-doctor", "RALPH_ROLE_PHASE_TICKET_PROBE")).toBe("0");
    expect(evalled("pr-medic", "RALPH_ROLE_PHASE_TICKET_PROBE")).toBe("0");
    expect(evalled("triager", "RALPH_ROLE_PHASE_TICKET_PROBE")).toBe("0");
    expect(evalled("coder", "RALPH_ROLE_GATE_HOLDS")).toBe("1");
    expect(evalled("triager", "RALPH_ROLE_GATE_HOLDS")).toBe("1");
    expect(evalled("ci-doctor", "RALPH_ROLE_GATE_HOLDS")).toBe("0");
    expect(evalled("ci-doctor", "RALPH_ROLE_SECRET_CHECK_RALPH_BUILDKITE_RETRY_TOKEN")).toBe(
      "bk-log.ts --check-retry-token",
    );
  });

  it("declares no secret the redactor does not know by name", () => {
    // The redactor strikes by NAME and by shape (`runner-signals.json`). A
    // credential it knows neither way reaches the transcript in cleartext, and
    // `never.match` excludes every `RALPH_` name by default — so each declared
    // secret has to be named in `never.except` or it is silently unprotected.
    const declared = [...new Set(ROLES.flatMap((role) => roleBehaviour(role).allSecrets))];
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      const seen = secretValuesFrom({ [name]: "a-value-long-enough-to-register" });
      expect(seen.map((entry) => entry.label), `${name} is not redacted by name`).toEqual([`env:${name}`]);
    }
  });

  it("redacts a Sentry or Vercel token under any RALPH_ name, not only a declared one (#679)", () => {
    // A token an operator stored under a role's former name is no longer a
    // declared secret after a rename, so the name rule above stops covering it.
    // The suffix rule keeps its value out of the transcript all the same.
    for (const name of ["RALPH_OLDROLE_SENTRY_TOKEN", "RALPH_OLDROLE_VERCEL_TOKEN"]) {
      const seen = secretValuesFrom({ [name]: "a-value-long-enough-to-register" });
      expect(seen.map((entry) => entry.label), `${name} is not redacted by name`).toEqual([`env:${name}`]);
    }
  });

  it("prints the same values as JSON, and refuses anything that is not a role", () => {
    expect(JSON.parse(run("--json", "triager"))).toEqual(JSON.parse(JSON.stringify(roleBehaviour("triager"))));
    expect(run("--export", "coder")).toBe(exportLines("coder").join("\n"));
    for (const argv of [["--export", "reviewer"], ["--export"], ["--what", "coder"]]) {
      expect(() => run(...argv)).toThrow();
    }
  });
});
