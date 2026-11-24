// @vitest-environment node
import { describe, expect, it } from "vitest";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STOP_SIGILS } from "./phase";
import { STAGES as RESOLVER_STAGES } from "./models";
import { APPLIED_LABEL } from "./migration-applied";
import {
  CREATED_LABELS,
  DEFAULT_ROLE,
  MANDATORY_CHECKS,
  PREFLIGHT_CHECKS,
  ROLES,
  ROLE_DESCRIPTORS,
  SIGILS,
  CODER_STAGES,
  STAGES,
  TRIAGE_LABELS,
  isRole,
  readOnlyCheckout,
  roleDescriptor,
  sectionRole,
  shepherds,
  stagesFor,
  without,
} from "./roles";

describe("the role descriptors", () => {
  it("names the seven roles, with coder the default", () => {
    expect(ROLES).toEqual(["coder", "triager", "ci-doctor", "pr-medic", "clerk", "verifier", "sentinel"]);
    expect(DEFAULT_ROLE).toBe("coder");
  });

  it("keys each descriptor by the role it describes, and describes every role", () => {
    expect(Object.keys(ROLE_DESCRIPTORS).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      expect(roleDescriptor(role).role).toBe(role);
      expect(roleDescriptor(role).summary).not.toBe("");
    }
  });

  it("gives every role an intake: a gate command, a frontier bucket or none, and a routing answer", () => {
    for (const role of ROLES) {
      const descriptor = roleDescriptor(role);
      expect(descriptor.intakeGate).toMatch(/\.ts$/);
      expect(typeof descriptor.javRouted).toBe("boolean");
    }
    // The coder's intake is the one that must not have moved.
    expect(roleDescriptor("coder")).toMatchObject({
      intakeGate: "frontier-gate.ts",
      frontierBucket: "ready",
      javRouted: true,
    });
    // A triager reads exactly what no coder's route matches, so a route would
    // filter its whole intake away.
    expect(roleDescriptor("triager")).toMatchObject({ frontierBucket: "triage", javRouted: false });
    // The doctor's case is a red build, which the backlog cannot see: it claims
    // by number instead, so it declares no bucket and its own gate.
    expect(roleDescriptor("ci-doctor")).toMatchObject({ frontierBucket: null, javRouted: false });
    expect(roleDescriptor("ci-doctor").intakeGate).not.toBe(roleDescriptor("coder").intakeGate);
  });

  it("gives every role a prompt template that exists in the harness", () => {
    for (const role of ROLES) {
      const template = roleDescriptor(role).prompt;
      expect(template).toMatch(/\.md$/);
      expect(existsSync(join(__dirname, template)), `${role}'s template ${template} is missing`).toBe(true);
    }
    // The coder's is the one that must not have moved: the supervisor rendered
    // it by name for every run before roles existed.
    expect(roleDescriptor("coder").prompt).toBe("prompt.md");
    expect(new Set(ROLES.map((role) => roleDescriptor(role).prompt)).size).toBe(ROLES.length);
  });

  it("states the secrets-manager rule in EVERY role's prompt, not just the coder's", () => {
    // A codex orchestrator can carry no settings file, so its role prompt is
    // the only fence it has (`ralph.sh` says exactly that on stderr, and the
    // README's "Environment" section says it too). The rule lived only in the
    // coder's `prompt.md` until felipearos/ralph#300, which left a codex
    // triager or ci-doctor unfenced while both sentences claimed otherwise.
    for (const role of ROLES) {
      const prompt = readFileSync(join(__dirname, roleDescriptor(role).prompt), "utf8");
      expect(prompt, `${role}'s prompt does not forbid running the secrets manager`).toContain(
        "Never run the project's secrets manager yourself",
      );
      expect(prompt).toContain("secrets.withhold");
    }
  });

  it("prefixes every non-coder role's fragment sections, and only theirs", () => {
    expect(roleDescriptor("coder").fragmentSection).toBe("");
    for (const role of ROLES.filter((other) => other !== "coder")) {
      expect(roleDescriptor(role).fragmentSection).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(new Set(ROLES.map((role) => roleDescriptor(role).fragmentSection)).size).toBe(ROLES.length);
  });

  it("gives no role a prefix that is a prefix of another role's", () => {
    // `sectionRole` answers with the first prefix that matches, so a role
    // declaring `CI` would take `CI_DOCTOR_RETRY` off the doctor — and the
    // doctor would stop refusing its own unplaced sections without a word.
    // Distinctness alone does not rule that out, which is why this is its own
    // assertion.
    const prefixes = ROLES.map((role) => roleDescriptor(role).fragmentSection).filter((prefix) => prefix !== "");
    for (const prefix of prefixes) {
      for (const other of prefixes.filter((candidate) => candidate !== prefix)) {
        expect(other.startsWith(`${prefix}_`), `${other} lives under ${prefix}`).toBe(false);
        expect(other, `${other} and ${prefix} collide`).not.toBe(prefix);
      }
    }
  });

  it("reads a section name as the role whose prefix it carries", () => {
    expect(sectionRole("TRIAGER")).toBe("triager");
    expect(sectionRole("TRIAGER_INTAKE")).toBe("triager");
    expect(sectionRole("CI_DOCTOR")).toBe("ci-doctor");
    expect(sectionRole("CI_DOCTOR_RETRY")).toBe("ci-doctor");
    expect(sectionRole("CLERK")).toBe("clerk");
    expect(sectionRole("CLERK_APPS")).toBe("clerk");
    expect(sectionRole("VERIFIER")).toBe("verifier");
    expect(sectionRole("VERIFIER_X")).toBe("verifier");
    expect(sectionRole("SENTINEL")).toBe("sentinel");
    expect(sectionRole("SENTINEL_X")).toBe("sentinel");
    // A prefix is a whole word: no underscore, no claim. And the default
    // section is the coder's, which is what keeps a pre-roles fragment meaning
    // what it meant.
    for (const name of ["", "VERIFY", "TRIAGERS", "CI_DOCTORS", "PRE_TRIAGER", "triager", "CLERKS", "VERIFIERS", "SENTINELS"]) {
      expect(sectionRole(name), `${name} is the coder's`).toBe("coder");
    }
  });


  it("knows every terminal sigil the phase roster does", () => {
    // `phase.ts` owns the terminal sigils and `ralph.sh` carries the same list
    // (`phase.test.ts` pins that). A sigil added there and missing here would be
    // absent from every role's set, and therefore silently unmatched at
    // runtime — the supervisor would take it for no sigil at all.
    for (const sigil of STOP_SIGILS) expect(SIGILS, `${sigil} is not a known sigil`).toContain(sigil);
    // And the coder's stop set is exactly that roster: the role the vocabulary
    // was written for must not have lost an ending.
    expect([...roleDescriptor("coder").sigils].filter((sigil) => (STOP_SIGILS as readonly string[]).includes(sigil)).sort())
      .toEqual([...STOP_SIGILS].sort());
  });

  it("declares a non-empty sigil set per role, all of them known, with the coder's the whole vocabulary", () => {
    for (const role of ROLES) {
      const sigils = roleDescriptor(role).sigils;
      expect(sigils.length, `${role} may end with nothing`).toBeGreaterThan(0);
      for (const sigil of sigils) expect(SIGILS).toContain(sigil);
      expect(new Set(sigils).size, `${role} repeats a sigil`).toBe(sigils.length);
      // Whatever else a role may not say, it must be able to report a fault
      // and to finish: a role with neither ending can only die as no-sigil.
      expect(sigils, `${role} cannot report a fault`).toContain("NEEDS_TRIAGE");
      expect(sigils, `${role} cannot finish`).toContain("DONE");
    }
    expect([...roleDescriptor("coder").sigils].sort()).toEqual([...SIGILS].sort());
    // The triager opens no PR, runs no gate and has no phases, so the three
    // hand-backs are endings it cannot honestly reach; the doctor watches a
    // branch that is never drained, so COMPLETE is not its ending.
    expect([...roleDescriptor("triager").sigils].sort()).toEqual(["ALL_BLOCKED", "DONE", "NEEDS_TRIAGE", "RETRY_LATER"]);
    expect(roleDescriptor("ci-doctor").sigils).not.toContain("COMPLETE");
    expect([...roleDescriptor("ci-doctor").sigils].sort()).toEqual(
      [...SIGILS].filter((sigil) => sigil !== "COMPLETE").sort(),
    );
  });

  it("offers each role a recovery prompt that names only endings that role may use", () => {
    for (const role of ROLES) {
      const descriptor = roleDescriptor(role);
      expect(descriptor.recoveryPrompt).toContain("This is the only recovery turn.");
      for (const sigil of SIGILS) {
        if (descriptor.sigils.includes(sigil)) continue;
        // The menu is the whole point of the text: offering an ending the
        // supervisor will refuse invites the ending that got the session here.
        expect(descriptor.recoveryPrompt, `${role}'s recovery offers ${sigil}`).not.toContain(`<ralph>${sigil}`);
      }
    }
  });

  it("turns the phase machinery off only for a role with no boundaries, and the host lease with it", () => {
    expect(roleDescriptor("coder")).toMatchObject({ phases: true, hostLease: true, invariant: null });
    expect(roleDescriptor("ci-doctor")).toMatchObject({ phases: true, hostLease: true });
    // Only a role whose phase number is a tracker ticket is probed for a close (#809).
    expect(ROLES.filter((role) => roleDescriptor(role).phaseTicketProbe)).toEqual(["coder"]);
    for (const role of ROLES) {
      if (roleDescriptor(role).phaseTicketProbe) expect(roleDescriptor(role).phases).toBe(true);
    }
    expect(roleDescriptor("triager")).toMatchObject({ phases: false, hostLease: false, invariant: "clean-detached" });
    // A role that may not ask for the host must not be able to: the sigil and
    // the lease flag are one decision, not two that could drift.
    for (const role of ROLES) {
      expect(roleDescriptor(role).sigils.includes("AWAIT_HOST"), `${role} disagrees with itself about the host`)
        .toBe(roleDescriptor(role).hostLease);
      // Likewise phases: a role without them has no boundary to yield at.
      expect(roleDescriptor(role).sigils.includes("PHASE"), `${role} disagrees with itself about phases`)
        .toBe(roleDescriptor(role).phases);
    }
  });

  it("lets only the frontier gates hold on an unchanged verdict", () => {
    // The coder's gate and the triager's (which wraps the same
    // `runFrontierGate`) read the verdict store; every other gate keeps the
    // supervisor's disagreement halt (#771).
    for (const role of ROLES) {
      expect(roleDescriptor(role).gateHolds, `${role} gateHolds`).toBe(role === "coder" || role === "triager");
    }
  });

  it("asks about a pull request only for a role that opens one, and says how long its gate waits", () => {
    expect(shepherds("coder")).toBe(true);
    expect(shepherds("ci-doctor")).toBe(true);
    // A triager writes labels and comments through the apply tool and opens
    // nothing, so its gate must not spend a `gh pr list` on every poll.
    expect(shepherds("triager")).toBe(false);
    // Not asserted against `sigils.includes("AWAIT_PR")` for every role: that
    // is `shepherds`' own expression, so it could not fail. The three named
    // answers above are what pins the derivation to the right one.
    expect(readOnlyCheckout("triager")).toBe(true);
    expect(readOnlyCheckout("coder")).toBe(false);
    for (const role of ROLES) {
      expect(readOnlyCheckout(role), `${role} disagrees with itself about its checkout`)
        .toBe(roleDescriptor(role).invariant !== null);
      // A zero or a fraction here reaches `start.sh` as its wait, and a wait
      // of none is a hot spin against the GitHub API.
      const seconds = roleDescriptor(role).pollSeconds;
      expect(Number.isSafeInteger(seconds), `${role} polls at ${seconds}`).toBe(true);
      expect(seconds, `${role} polls at ${seconds}`).toBeGreaterThan(0);
    }
    // The coder keeps `start.sh`'s long-standing default; the triager reads a
    // backlog shape that cannot change that fast.
    expect(roleDescriptor("coder").pollSeconds).toBe(300);
    expect(roleDescriptor("triager").pollSeconds).toBe(600);
  });

  it("declares each role's secrets with a target, and gives a coder no gate secret", () => {
    for (const role of ROLES) {
      const { manager, named } = roleDescriptor(role).secrets;
      expect(typeof manager).toBe("boolean");
      for (const secret of named) {
        expect(secret.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(secret.targets.length, `${secret.name} goes nowhere`).toBeGreaterThan(0);
        for (const target of secret.targets) expect(["iteration", "gate"]).toContain(target);
      }
    }
    // A coder's gate is the frontier, which asks GitHub: it acts with nothing,
    // so no credential of another role's may reach it.
    expect(roleDescriptor("coder").secrets.named.some((secret) => secret.targets.includes("gate"))).toBe(false);
    // The read token is the coder's one named secret, and it must not have
    // moved: an iteration without it explains a red check worse.
    expect(roleDescriptor("coder").secrets).toEqual({
      manager: true,
      named: [{ name: "RALPH_BUILDKITE_READ_TOKEN", check: "bk-log.ts --check-token", targets: ["iteration"] }],
    });
    // A triager touches no application code, so it is given no environment at
    // all. Its one named credential is the Jira token, and only its gate holds
    // it: the gate moves a to-person report to Jira (#397).
    expect(roleDescriptor("triager").secrets).toEqual({
      manager: false,
      named: [{ name: "RALPH_CLERK_JIRA_TOKEN", check: "clerk/jira.ts --check-token", targets: ["gate"] }],
    });
    const retry = roleDescriptor("ci-doctor").secrets.named.find((secret) => secret.name === "RALPH_BUILDKITE_RETRY_TOKEN");
    expect(retry?.targets).toEqual(["gate"]);
    // A write-capable credential the gate acts with unattended: its check is
    // the narrow one (#161), and a null here would silently make the
    // supervisor withhold the token on every start.
    expect(retry?.check).toBe("bk-log.ts --check-retry-token");
  });

  it("recognises a role only as its exact spelling", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const value of ["Coder", "ci_doctor", "cidoctor", "", "reviewer", null, undefined, 1, {}]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe("the preflight each role is held to", () => {
  const checksOf = (role: Parameters<typeof roleDescriptor>[0]): readonly string[] => roleDescriptor(role).preflight.checks;

  it("holds a coder to every check and overrides none of them", () => {
    // AC 1: a coder's preflight is exactly today's. Spelled as the whole list
    // rather than a copy of it, so a check added to PREFLIGHT_CHECKS applies to
    // the coder without an edit — and this assertion still holds.
    expect(checksOf("coder")).toEqual([...PREFLIGHT_CHECKS]);
    expect(roleDescriptor("coder").preflight.verdicts).toEqual({});
    expect(roleDescriptor("coder").preflight.labels).toEqual(["migration-applied"]);
    // The label the operator's command writes is the one preflight creates.
    expect(roleDescriptor("coder").preflight.labels).toEqual([APPLIED_LABEL]);
    expect(roleDescriptor("coder").preflight.requiresDifficultyLabels).toBe(false);
  });

  it("holds every role to the three checks no list may drop", () => {
    // `preflight.ts` asks these whatever the descriptor says, so a role that
    // dropped one would carry a declaration that lies — and the reader would
    // believe a probe was skipped that still runs and still denies the start.
    // Membership and uniqueness need no test: every list is `PREFLIGHT_CHECKS`
    // filtered, and `without` takes `PreflightCheck`, so both are structural.
    expect(MANDATORY_CHECKS).toEqual(["project-config", "tools", "loop-identity"]);
    for (const role of ROLES) {
      for (const check of MANDATORY_CHECKS) expect(checksOf(role)).toContain(check);
    }
  });

  it("refuses an override on a check the role does not run", () => {
    // Dead configuration that reads as a decision: `{ "doppler-scope": "denied" }`
    // on a role that dropped it looks like a strictness it does not have.
    for (const role of ROLES) {
      for (const check of Object.keys(roleDescriptor(role).preflight.verdicts)) {
        expect(checksOf(role)).toContain(check);
      }
    }
  });

  it("drops from a triager exactly what a triager cannot reach, and nothing else", () => {
    // Exactly: a fifth drop would be a probe silently skipped. `logs-writable`
    // is the one that makes an iteration's own output recoverable, and a
    // `not.toContain` trio would not have noticed it going.
    expect(checksOf("triager")).toEqual(without("executor-tools", "buildkite-logs", "actions-logs", "doppler-scope"));
    // Which is to say: it still claims with labels, reads GitHub, and takes its
    // work off the frontier's triage bucket.
    for (const check of ["loop-labels", "github-credentials", "frontier-prerequisites", "logs-writable"] as const) {
      expect(checksOf("triager")).toContain(check);
    }
  });

  it("requires the whole triage vocabulary, and the project's difficulty labels", () => {
    expect(TRIAGE_LABELS).toEqual([
      "needs-triage",
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
      "spec",
      "duplicate",
    ]);
    expect(roleDescriptor("triager").preflight.labels).toEqual([...TRIAGE_LABELS]);
    // Configured per project, so they cannot be listed in the descriptor.
    expect(roleDescriptor("triager").preflight.requiresDifficultyLabels).toBe(true);
  });

  it("makes the ci-doctor's set expressible: no frontier, a denial on its logs, its own labels", () => {
    const { checks, verdicts, labels } = roleDescriptor("ci-doctor").preflight;
    // It takes no work off the frontier at all, so the frontier's own
    // prerequisites are nothing to it.
    expect(roleDescriptor("ci-doctor").frontierBucket).toBeNull();
    expect(checks).toEqual(without("frontier-prerequisites"));
    // AC 3: the override a coder would report as a warning.
    expect(checks).toContain("buildkite-logs");
    expect(verdicts["buildkite-logs"]).toBe("denied");
    expect(labels).toEqual(["ci-health", "priority:urgent"]);
    // AC 2: the retry token is a warning, so it carries no verdict override at
    // all. A denial here would refuse the one doctor an operator can run before
    // minting a second, write-capable token — and the doctor works without it.
    expect(checks).toContain("buildkite-retry");
    expect(verdicts["buildkite-retry"]).toBeUndefined();
  });

  it("makes the pr-medic's set expressible: the coder's work on somebody else's branch", () => {
    const medic = roleDescriptor("pr-medic");
    // The coder's five, because it fixes code the way a coder does.
    expect(medic.stages).toEqual([...CODER_STAGES]);
    // The doctor's sigils exactly: no COMPLETE, because the operator's open
    // pull requests are never "drained". Asserted as a set rather than as
    // "contains DONE", so adding COMPLETE here is a failure.
    expect(medic.sigils).toEqual(roleDescriptor("ci-doctor").sigils);
    expect(medic.sigils).not.toContain("COMPLETE");
    // Its case is a pull request, so it asks the frontier nothing — and reads
    // the failed build to tell this branch's own failure from a flake, which
    // is why that read is a denial rather than a coder's warning.
    expect(medic.frontierBucket).toBeNull();
    expect(medic.javRouted).toBe(false);
    expect(medic.preflight.checks).toEqual(without("frontier-prerequisites"));
    expect(medic.preflight.verdicts["buildkite-logs"]).toBe("denied");
    // No label vocabulary of its own: the three the ticket names are the
    // per-loop triple `preflight.ts` already derives from the loop's name, and
    // what differs — they go on a pull request — no descriptor can say.
    expect(medic.preflight.labels).toEqual([]);
    expect(medic.preflight.requiresDifficultyLabels).toBe(false);
    // It works INSIDE the operator's branch, so a dirty worktree between its
    // phases is its working state rather than a violation.
    expect(medic.invariant).toBeNull();
  });

  it("makes the clerk's set expressible: a classify-and-apply pass over a Slack channel", () => {
    const clerk = roleDescriptor("clerk");
    // The session only classifies, so it is the one coder stage: no executor
    // to delegate code to, no mapper, no diff for either review axis. Its
    // second session kind, the code-context read (felipearos/ralph#499), is a
    // stage of its own that no other role has.
    expect(clerk.stages).toEqual(["orchestrator", "code-context"]);
    // Its own gate, which reads Slack; the backlog cannot see a channel, and
    // no difficulty route can narrow it.
    expect(clerk.intakeGate).toBe("clerk/gate.ts");
    expect(clerk.frontierBucket).toBeNull();
    expect(clerk.javRouted).toBe(false);
    expect(clerk.prompt).toBe("prompts/clerk.md");
    expect(clerk.fragmentSection).toBe("CLERK");
    // Only the endings a classify-and-apply iteration reaches: no pull request
    // to wait on, no host to ask for, no phase to yield at, and no COMPLETE —
    // a channel is never drained. Asserted as a set, so adding one fails.
    expect([...clerk.sigils].sort()).toEqual(["ALL_BLOCKED", "DONE", "NEEDS_TRIAGE", "RETRY_LATER"]);
    for (const sigil of ["AWAIT_PR", "AWAIT_HOST", "PHASE", "COMPLETE"] as const) expect(clerk.sigils).not.toContain(sigil);
    expect(shepherds("clerk")).toBe(false);
    expect(clerk).toMatchObject({ phases: false, hostLease: false, invariant: "clean-detached", orchestratorSettings: "clerk/orchestrator-settings.json" });
    expect(readOnlyCheckout("clerk")).toBe(true);
    // The spec's one drop, and nothing it would have to justify: the rest of
    // the list applies to a clerk as written.
    expect(clerk.preflight.checks).toEqual(without("frontier-prerequisites"));
    expect(clerk.preflight.verdicts).toEqual({});
    expect(clerk.preflight.labels).toEqual([]);
    expect(clerk.preflight.requiresDifficultyLabels).toBe(false);
    // No application environment: it touches no application code. Its two
    // credentials go to the GATE alone: the session classifies what the gate
    // stored and holds nothing that could write to Slack or Jira.
    expect(clerk.secrets).toEqual({
      manager: false,
      named: [
        { name: "RALPH_CLERK_SLACK_TOKEN", check: "clerk/slack.ts --check-token", targets: ["gate"] },
        { name: "RALPH_CLERK_JIRA_TOKEN", check: "clerk/jira.ts --check-token", targets: ["gate"] },
      ],
    });
    expect(clerk.pollSeconds).toBe(300);
  });

  it("makes the verifier's set expressible: one post-merge check-in per iteration", () => {
    const verifier = roleDescriptor("verifier");
    // The session only verifies: no executor to delegate code to, no mapper,
    // no diff for either review axis.
    expect(verifier.stages).toEqual(["orchestrator"]);
    // Its own gate, which follows merged pull requests; the backlog's ready
    // bucket cannot see one, and no difficulty route can narrow it.
    expect(verifier.intakeGate).toBe("verifier/gate.ts");
    expect(verifier.frontierBucket).toBeNull();
    expect(verifier.javRouted).toBe(false);
    expect(verifier.prompt).toBe("prompts/verifier.md");
    expect(verifier.fragmentSection).toBe("VERIFIER");
    // One check-in per iteration: no pull request to wait on until act mode
    // (felipearos/ralph#568), no host, no phase, and no COMPLETE — merges never
    // stop arriving. Asserted as a set, so adding one fails.
    expect([...verifier.sigils].sort()).toEqual(["ALL_BLOCKED", "DONE", "NEEDS_TRIAGE", "RETRY_LATER"]);
    for (const sigil of ["AWAIT_PR", "AWAIT_HOST", "PHASE", "COMPLETE"] as const) expect(verifier.sigils).not.toContain(sigil);
    expect(verifier.recoveryPrompt).toContain("This is the only recovery turn.");
    expect(shepherds("verifier")).toBe(false);
    expect(verifier).toMatchObject({ phases: false, hostLease: false, invariant: "clean-detached", orchestratorSettings: "verifier/orchestrator-settings.json" });
    expect(readOnlyCheckout("verifier")).toBe(true);
    // The frontier and Buildkite-log checks drop; its verdict labels are the spec's
    // loop-labels requirement (felipearos/ralph#560).
    expect(verifier.preflight.checks).toEqual(without("frontier-prerequisites", "buildkite-logs", "actions-logs"));
    expect(verifier.preflight.verdicts).toEqual({});
    expect(verifier.preflight.labels).toEqual(["following", "verified", "unexercised", "inconclusive", "needs-human"]);
    expect(verifier.preflight.requiresDifficultyLabels).toBe(false);
    // No application environment; its read tokens go to the gate alone, each
    // proved by `verifier/credentials.ts` before it is handed over.
    expect(verifier.secrets).toEqual({
      manager: false,
      named: [
        { name: "RALPH_VERIFIER_SENTRY_TOKEN", check: "verifier/credentials.ts --check-token sentry", targets: ["gate"] },
        { name: "RALPH_VERIFIER_VERCEL_TOKEN", check: "verifier/credentials.ts --check-token vercel", targets: ["gate"] },
      ],
    });
    expect(verifier.pollSeconds).toBe(300);
  });

  it("makes the sentinel's set expressible: one reporter issue's ticket draft per iteration", () => {
    const sentinel = roleDescriptor("sentinel");
    // The session only diagnoses: no executor to delegate code to, no mapper,
    // no diff for either review axis.
    expect(sentinel.stages).toEqual(["orchestrator"]);
    // Its own gate, which polls the error reporter; the backlog's ready
    // bucket cannot see a reporter issue, and no difficulty route can narrow it.
    expect(sentinel.intakeGate).toBe("sentinel/gate.ts");
    expect(sentinel.frontierBucket).toBeNull();
    expect(sentinel.javRouted).toBe(false);
    expect(sentinel.prompt).toBe("prompts/sentinel.md");
    expect(sentinel.fragmentSection).toBe("SENTINEL");
    // One draft per iteration: no pull request to wait on, no host, no phase,
    // and no COMPLETE — production errors never stop arriving. Asserted as a
    // set, so adding one fails.
    expect([...sentinel.sigils].sort()).toEqual(["ALL_BLOCKED", "DONE", "NEEDS_TRIAGE", "RETRY_LATER"]);
    for (const sigil of ["AWAIT_PR", "AWAIT_HOST", "PHASE", "COMPLETE"] as const) expect(sentinel.sigils).not.toContain(sigil);
    expect(sentinel.recoveryPrompt).toContain("This is the only recovery turn.");
    expect(sentinel.recoveryPrompt).toContain("sentinel/issue.ts draft");
    expect(shepherds("sentinel")).toBe(false);
    expect(sentinel).toMatchObject({ phases: false, hostLease: false, invariant: "clean-detached", orchestratorSettings: "sentinel/orchestrator-settings.json" });
    expect(readOnlyCheckout("sentinel")).toBe(true);
    // The verifier's checks drop; its tickets carry `ready-for-human`
    // (spec felipearos/ralph#678), which preflight creates.
    expect(sentinel.preflight.checks).toEqual(without("frontier-prerequisites", "buildkite-logs", "actions-logs"));
    expect(sentinel.preflight.verdicts).toEqual({});
    expect(sentinel.preflight.labels).toEqual(["ready-for-human"]);
    expect(CREATED_LABELS["ready-for-human"]).toEqual({ color: "d4c5f9", description: "A person decides whether a loop should take this ticket" });
    expect(sentinel.preflight.requiresDifficultyLabels).toBe(false);
    // No application environment; its reporter token goes to the gate alone,
    // proved by `sentinel/credentials.ts` before it is handed over.
    expect(sentinel.secrets).toEqual({
      manager: false,
      named: [{ name: "RALPH_SENTINEL_SENTRY_TOKEN", check: "sentinel/credentials.ts --check-token sentry", targets: ["gate"] }],
    });
    expect(sentinel.pollSeconds).toBe(300);
  });

  it("asks `buildkite-retry` only of a role that declares the token", () => {
    // What keeps AC 3 true without the coder's list refusing the check:
    // `preflight.ts` resolves the check against `secrets.named`, so the
    // vocabulary may grow a question only one role can answer while every
    // role's list stays the whole vocabulary filtered. If a second role is ever
    // given the retry token, this is the assertion that says its preflight
    // starts asking about it.
    const declares = (role: Parameters<typeof roleDescriptor>[0]): boolean =>
      roleDescriptor(role).secrets.named.some((secret) => secret.name === "RALPH_BUILDKITE_RETRY_TOKEN");

    // Two roles now: the medic re-runs a known flake on the operator's pull
    // request through its gate, under the same daily cap as the doctor.
    expect(ROLES.filter(declares)).toEqual(["ci-doctor", "pr-medic"]);
  });

  it("declares no extra label shaped like a claim label", () => {
    // `<name>-wip`, `-blocked` and `-done` are the claim fence's vocabulary,
    // and every fence reads any `*-wip` as somebody holding the ticket. A role
    // label in that shape would be read as a claim by a loop that never made one.
    for (const role of ROLES) {
      for (const label of roleDescriptor(role).preflight.labels) {
        expect(label).not.toMatch(/-(?:wip|blocked|done)$/);
      }
    }
  });
});

describe("a role's stage set", () => {
  it("is a non-empty subset of STAGES, in STAGES order, with no repeats", () => {
    for (const role of ROLES) {
      const stages = stagesFor(role);
      expect(stages.length).toBeGreaterThan(0);
      expect(new Set(stages).size).toBe(stages.length);
      for (const stage of stages) expect(STAGES).toContain(stage);
      // Order matters because every report iterates STAGES and prints what the
      // lineup holds: a set written out of order would read out of order.
      expect(stages).toEqual(STAGES.filter((stage) => stages.includes(stage)));
    }
  });

  it("always names the orchestrator, because every role runs a session", () => {
    for (const role of ROLES) expect(stagesFor(role)).toContain("orchestrator");
  });

  it("gives the coder and the ci-doctor the coder's five, and the triager three", () => {
    expect(stagesFor("coder")).toEqual([...CODER_STAGES]);
    expect(stagesFor("ci-doctor")).toEqual([...CODER_STAGES]);
    expect(STAGES).toEqual([...CODER_STAGES, "code-context"]);
    expect(stagesFor("triager")).toEqual(["orchestrator", "mapper", "review.spec"]);
    // The two a triager cannot honestly run: it delegates no code and reviews
    // no diff against the repo's standards.
    expect(stagesFor("triager")).not.toContain("executor");
    expect(stagesFor("triager")).not.toContain("review.standards");
  });

  it("gives code-context to the clerk alone", () => {
    for (const role of ROLES) {
      expect(stagesFor(role).includes("code-context"), role).toBe(role === "clerk");
    }
  });

  it("answers from the descriptor, for every role", () => {
    for (const role of ROLES) expect(stagesFor(role)).toEqual(roleDescriptor(role).stages);
  });

  it("is the same vocabulary the resolver re-exports, not a copy", () => {
    // `models.ts` re-exports these names; a second array there would drift from
    // the sets above the moment a stage is added.
    expect(RESOLVER_STAGES).toBe(STAGES);
  });
});

describe("a role's orchestrator rails", () => {
  const HOME = __dirname;

  it("are declared by the pr-medic, the clerk, the verifier and the sentinel alone, so every other role's session is unchanged", () => {
    expect(ROLES.filter((role) => roleDescriptor(role).orchestratorSettings !== null)).toEqual(["pr-medic", "clerk", "verifier", "sentinel"]);
  });

  it("deny the sentinel's session edits, the network, tracker writes, edits to its store and any code write, on top of the harness rails", () => {
    // It drafts one ticket from evidence the gate stored (felipearos/ralph#681):
    // it writes no code, files nothing itself (the gate does, in file mode)
    // and reaches no reporter or web. A role file REPLACES the harness one.
    const path = roleDescriptor("sentinel").orchestratorSettings as string;
    const settings = JSON.parse(readFileSync(join(HOME, path), "utf8")) as Record<string, unknown> & { permissions: Record<string, unknown> & { deny: string[] } };
    expect(Object.keys(settings).filter((key) => key !== "$comment")).toEqual(["permissions"]);
    expect(Object.keys(settings.permissions)).toEqual(["deny"]);
    const harness = JSON.parse(readFileSync(join(HOME, "claude-orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } };
    const sorted = (rules: string[]): string[] => [...rules].sort();
    const spellings = (commands: string[]): string[] => commands.flatMap((command) => [`Bash(${command} *)`, `Bash(${command}:*)`]);
    // Every database client too, as the verifier's: the session reads code, never data.
    const network = spellings(["psql", "pgcli", "supabase", "mysql", "mongosh", "redis-cli", "curl", "wget"]);
    const codeWrites = spellings(["git commit", "git revert", "git cherry-pick", "git merge", "git rebase", "git reset", "git push", "gh pr create", "gh pr merge"]);
    const trackerWrites = spellings([
      "gh issue",
      "gh label",
      "gh api",
      ...["comment", "label", "done", "handoff", "blocked", "connect-test", "connect-save"].map((verb) => `bun *tracker.ts* ${verb}`),
    ]);
    expect(sorted(settings.permissions.deny)).toEqual(
      sorted([
        "Edit",
        "NotebookEdit",
        "Edit(**/ralph/sentinel-issues.json)",
        "Write(**/ralph/sentinel-issues.json)",
        "WebFetch",
        "WebSearch",
        ...network,
        ...codeWrites,
        ...trackerWrites,
        ...harness.permissions.deny,
      ]),
    );
  });

  it("deny the verifier's session every database client, hand-made requests, edits to its store and any code write, on top of the harness rails", () => {
    // It checks production as the test account and may never write to a
    // database (felipearos/ralph#566): read-only SQL goes through
    // `verifier/acceptance.ts sql`. It writes no code either: act mode's
    // revert is the gate's (#568). A role file REPLACES the harness one.
    const path = roleDescriptor("verifier").orchestratorSettings as string;
    const settings = JSON.parse(readFileSync(join(HOME, path), "utf8")) as Record<string, unknown> & { permissions: Record<string, unknown> & { deny: string[] } };
    expect(Object.keys(settings).filter((key) => key !== "$comment")).toEqual(["permissions"]);
    expect(Object.keys(settings.permissions)).toEqual(["deny"]);
    const harness = JSON.parse(readFileSync(join(HOME, "claude-orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } };
    const sorted = (rules: string[]): string[] => [...rules].sort();
    const clients = ["psql", "pgcli", "supabase", "mysql", "mongosh", "redis-cli", "curl", "wget"].flatMap((tool) => [`Bash(${tool} *)`, `Bash(${tool}:*)`]);
    const codeWrites = [
      "git commit",
      "git revert",
      "git cherry-pick",
      "git merge",
      "git rebase",
      "git push",
      "gh pr create",
      "gh pr merge",
      "gh api",
    ].flatMap((command) => [`Bash(${command} *)`, `Bash(${command}:*)`]);
    expect(sorted(settings.permissions.deny)).toEqual(
      sorted([
        ...clients,
        ...codeWrites,
        "Edit",
        "NotebookEdit",
        "Edit(**/ralph/verifier-watches.json)",
        "Write(**/ralph/verifier-watches.json)",
        ...harness.permissions.deny,
      ]),
    );
  });

  it("deny the clerk's session the network — web tools, curl and wget — and edits to its store, on top of the harness rails", () => {
    // The clerk reads untrusted Slack text and needs nothing beyond the batch
    // tool (felipearos/ralph#318); a message asking it to fetch or post has
    // nothing to ride on. The harness file's rules are repeated because a role
    // file REPLACES it.
    const path = roleDescriptor("clerk").orchestratorSettings as string;
    const settings = JSON.parse(readFileSync(join(HOME, path), "utf8")) as Record<string, unknown> & { permissions: { deny: string[] } };
    expect(Object.keys(settings).filter((key) => key !== "$comment")).toEqual(["permissions"]);
    const harness = JSON.parse(readFileSync(join(HOME, "claude-orchestrator-settings.json"), "utf8")) as { permissions: { deny: string[] } };
    const sorted = (rules: string[]): string[] => [...rules].sort();
    expect(sorted(settings.permissions.deny)).toEqual(
      sorted([
        "WebFetch",
        "WebSearch",
        "Bash(curl *)",
        "Bash(curl:*)",
        "Bash(wget *)",
        "Bash(wget:*)",
        "Edit(**/ralph/clerk/**)",
        "Write(**/ralph/clerk/**)",
        ...harness.permissions.deny,
      ]),
    );
  });

  it("deny the pr-medic's session a raw `git push`, in both spellings, and nothing beyond the harness rails", () => {
    const path = roleDescriptor("pr-medic").orchestratorSettings as string;
    expect(existsSync(join(HOME, path))).toBe(true);
    const settings = JSON.parse(readFileSync(join(HOME, path), "utf8")) as Record<string, unknown> & {
      permissions: Record<string, unknown> & { deny: string[] };
    };
    // Only `permissions.deny`: a settings file passed with `--settings` can
    // also carry hooks, env and a model, and none of those is this field's.
    expect(Object.keys(settings).filter((key) => key !== "$comment")).toEqual(["permissions"]);
    expect(Object.keys(settings.permissions)).toEqual(["deny"]);
    // A role file REPLACES the harness-wide `claude-orchestrator-settings.json`
    // rather than adding to it (felipearos/ralph#300), so the medic's is that
    // file's rules plus its own push denies — and nothing else. Read from the
    // harness file so a rule added there cannot silently stop applying here;
    // `claude-executor-rails.test.ts` makes the same check from the other end.
    const harness = JSON.parse(readFileSync(join(HOME, "claude-orchestrator-settings.json"), "utf8")) as {
      permissions: { deny: string[] };
    };
    // Order-insensitive: Claude Code's matcher does not care, and pinning the
    // medic's order to the harness file's would red this test on a reorder of
    // either one. The sort keeps it exact — same multiset, nothing extra.
    const sorted = (rules: string[]): string[] => [...rules].sort();
    expect(sorted(settings.permissions.deny)).toEqual(
      sorted(["Bash(git push *)", "Bash(git push:*)", ...harness.permissions.deny]),
    );
  });

  it("leave the executor's rails as they were: one set for every role, which already denies the push", () => {
    // The pr-medic's executor is every role's executor. These are the lines
    // that keep a raw push from it, under each runner.
    const claude = JSON.parse(readFileSync(join(HOME, "claude-executor-settings.json"), "utf8")) as { permissions: { deny: string[] } };
    expect(claude.permissions.deny).toEqual(expect.arrayContaining(["Bash(git push *)", "Bash(git push:*)"]));
    expect(readFileSync(join(HOME, "codex-executor.sh"), "utf8")).toMatch(
      /prefix_rule\(pattern = \["git", \[[^\]]*"push"[^\]]*\]\], decision = "forbidden"\)/,
    );
  });
});
