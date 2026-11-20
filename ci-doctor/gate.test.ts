// @vitest-environment node
/**
 * What the doctor's gate hands over, and what it refuses to.
 *
 * One fixture per selection priority, because the order is the whole contract:
 * a doctor that worked the cheapest confirmed flake while main was red on a
 * regression would be doing the least valuable thing available, every hour.
 * Then the three refusals that keep a model turn from being spent for nothing
 * — an infra case, a single-occurrence candidate, and a case another doctor
 * already holds.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTROL_PENDING_LINE,
  DEFAULT_POLL_SECONDS,
  actionable,
  checkReadings,
  decide,
  incidents,
  parkedFrom,
  recurred,
  subjectOf,
  jittered,
  pollSeconds,
  testIdOf,
  throttleWaitSeconds,
  verdictLine,
  waitingLine,
  weigh,
  workLine,
  type ParkedTicket,
  type Probes,
  type PullRequestWithChecks,
  type RegistryIssue,
  type Verdict,
} from "./gate";
import { supervisorGone, supervisorPidFrom } from "../frontier-gate";
import { emptyStore, type Case, type CiHealthStore, type Evidence } from "./store";
import { checkIncidents } from "./classify";

// The provenance regex and the `<loop>-wip` labels come from the project's roster.
process.env.RALPH_PROJECT = join(__dirname, "..", "fixtures", "loggd");

const NOW = Date.parse("2026-09-30T10:00:00.000Z");
const FLAKE = "src/a.test.ts > flaps";
const OTHER = "src/b.test.ts > also flaps";

const seen = (build: number, over: Partial<Evidence> = {}): Evidence => ({
  build,
  branch: "main",
  commit: "abc1234",
  kind: "timeout",
  line: "FAIL src/a.test.ts > flaps — Error: Test timed out in 5000ms",
  ...over,
});

const caseOf = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "confirmed",
  evidence: [seen(2600)],
  cost72h: { redBuilds: 1, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

const storeWith = (cases: Record<string, Case>): CiHealthStore => ({ ...emptyStore(), cases });

const probes = (over: Partial<Probes> = {}): Probes => ({
  loop: "ralph",
  store: emptyStore(),
  prs: [],
  registry: [],
  parked: [],
  held: [],
  ...over,
});

const registry = (over: Partial<RegistryIssue> = {}): RegistryIssue => ({
  number: 900,
  state: "OPEN",
  labels: ["ci-health"],
  ...over,
});

const parked = (over: Partial<ParkedTicket> = {}): ParkedTicket => ({
  number: 1557,
  loop: "rafa",
  testId: FLAKE,
  ...over,
});

describe("the six priorities, in order", () => {
  it("1. shepherds this doctor's own non-draft pull request first", () => {
    const verdict = decide(
      probes({
        prs: [{ number: 12, isDraft: false, body: "🤖 Ralph loop — run `r` · iteration session `s`" }],
        // Everything below it is also true, and must not win.
        registry: [registry({ labels: ["ci-health", "ralph-wip"] })],
        store: storeWith({ [`regression:${FLAKE}`]: caseOf({ kind: "regression", state: "candidate" }) }),
      }),
    );
    expect(verdict).toEqual({ work: true, why: "Ralph PR #12 to shepherd", key: null });
  });

  it("leaves the other loop's pull request and a stamped draft alone", () => {
    const prs = [
      { number: 13, isDraft: false, body: "🤖 Rafa loop — run `r`" },
      { number: 14, isDraft: true, body: "🤖 Ralph loop — run `r`" },
      { number: 15, isDraft: false, body: "no provenance line at all" },
    ];
    expect(decide(probes({ prs })).work).toBe(false);
  });

  it("2. resumes its own unfinished claim before any store case", () => {
    const verdict = decide(
      probes({
        registry: [registry({ number: 901, labels: ["ci-health", "ralph-wip"] })],
        store: storeWith({ [`regression:${FLAKE}`]: caseOf({ kind: "regression", state: "candidate" }) }),
      }),
    );
    expect(verdict.work).toBe(true);
    expect(verdict.why).toContain("issue #901 carries this loop's unfinished claim");
    // A claim is held by its label; leasing it too would be a second claim.
    expect(verdict.key).toBeNull();
  });

  it("does not read another loop's claim as its own", () => {
    const verdict = decide(probes({ registry: [registry({ labels: ["ci-health", "rafa-wip"] })] }));
    expect(verdict.work).toBe(false);
  });

  it("3. takes a regression on main with no open ci-health issue", () => {
    const key = `regression:${FLAKE}`;
    const verdict = decide(
      probes({
        store: storeWith({
          [key]: caseOf({ kind: "regression", state: "candidate" }),
          // Outranks the flake below it even though the flake is confirmed.
          [`flake:${OTHER}`]: caseOf({ cost72h: { redBuilds: 9, mainReds: 9, dequeues: 9 } }),
        }),
      }),
    );
    expect(verdict).toEqual({
      work: true,
      why: `regression on main — ${FLAKE} has no open ci-health issue`,
      key,
    });
  });

  it("leaves a regression that already has an open issue", () => {
    const store = storeWith({ [`regression:${FLAKE}`]: caseOf({ kind: "regression", state: "filed", issue: 902 }) });
    expect(decide(probes({ store, registry: [registry({ number: 902 })] })).work).toBe(false);
    // Closed again, and the regression is still there: that is work once more.
    expect(decide(probes({ store, registry: [registry({ number: 902, state: "CLOSED" })] })).work).toBe(true);
  });

  it("4. unparks a coder ticket before working the flake itself", () => {
    const verdict = decide(
      probes({
        parked: [parked()],
        store: storeWith({
          [`flake:${FLAKE}`]: caseOf({ state: "fixed" }),
          [`flake:${OTHER}`]: caseOf({ cost72h: { redBuilds: 9, mainReds: 9, dequeues: 9 } }),
        }),
      }),
    );
    expect(verdict.work).toBe(true);
    expect(verdict.key).toBe("parked:1557");
    expect(verdict.why).toContain("parked ticket #1557");
  });

  it("5. takes the confirmed flake with the highest 72h cost", () => {
    const verdict = decide(
      probes({
        store: storeWith({
          [`flake:${FLAKE}`]: caseOf({ cost72h: { redBuilds: 8, mainReds: 0, dequeues: 0 } }),
          [`flake:${OTHER}`]: caseOf({ cost72h: { redBuilds: 1, mainReds: 2, dequeues: 2 } }),
        }),
      }),
    );
    // 1 + 2×3 + 2×2 = 11 beats 8: a red on main is worth three ordinary reds.
    expect(verdict.key).toBe(`flake:${OTHER}`);
    expect(verdict.why).toBe(`confirmed flake ${OTHER} — 72h cost 11`);
  });

  it("6. reopens a fixed flake that came back after its fix", () => {
    const key = `flake:${FLAKE}`;
    const back = caseOf({ state: "fixed", fixedAt: { build: 2600, at: "2026-09-29T00:00:00Z" }, evidence: [seen(2700)] });
    const verdict = decide(probes({ store: storeWith({ [key]: back }) }));
    expect(verdict).toEqual({ work: true, why: `fixed flake ${FLAKE} recurred after its fix — reopening`, key });
  });
});

describe("what starts no iteration", () => {
  const rejectedAt = { build: 2600, at: "2026-09-30T08:00:00.000Z", reason: "a ratchet, not a flake" };

  it("a case this doctor rejected, however it is costed", () => {
    // Pins EXISTING behaviour rather than new: priority 5 filters on
    // `confirmed` and priority 6 on `fixed`, so a `retired` case was already
    // skipped here before #240. What #240 changed is that `mergeCases` no
    // longer puts the case back to `confirmed` before the gate ever looks —
    // `classify.test.ts` is where that is proved. This test exists so a future
    // widening of priority 5 cannot silently re-offer a rejected case.
    const store = storeWith({
      [`flake:${FLAKE}`]: caseOf({ state: "retired", rejectedAt, cost72h: { redBuilds: 9, mainReds: 4, dequeues: 2 } }),
    });
    const verdict = decide(probes({ store }));
    expect(verdict.work).toBe(false);
    expect(verdict.key).toBeNull();
  });

  it("a rejected infra case is not named as an incident the doctor is sitting out", () => {
    const rejectedInfra = { ...caseOf({ kind: "infra", state: "retired", rejectedAt }) };
    const verdict = decide(probes({ store: storeWith({ "infra:agent-lost": rejectedInfra }) }));
    expect(verdict.work).toBe(false);
    expect(verdict.why).not.toContain("infra:agent-lost");
    expect(verdict.why).toContain("CI is healthy");
  });

  it("but an infra case nobody rejected is still named", () => {
    // The falsifier for the test above: the filter must bite on the rejection,
    // not on the state.
    const verdict = decide(probes({ store: storeWith({ "infra:agent-lost": caseOf({ kind: "infra" }) }) }));
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("infra:agent-lost");
  });

  it("a rejected infra case is named again once a newer build is red", () => {
    // The gate reads the boundary the same way `mergeCases` does (AC 2), and
    // the infra branch is the one place the gate reads it at all — so this is
    // where the comparison is testable. Same case, same rejection, one build
    // past the boundary: it comes back.
    const held = { ...caseOf({ kind: "infra", state: "retired", rejectedAt }) };
    expect(decide(probes({ store: storeWith({ "infra:agent-lost": held }) })).why).not.toContain("infra:agent-lost");
    const overtaken = { ...held, evidence: [seen(2600), seen(2731)] };
    expect(decide(probes({ store: storeWith({ "infra:agent-lost": overtaken }) })).why).toContain("infra:agent-lost");
  });

  it("does not page an operator about an incident its own doctor rejected", () => {
    // The verdict and the notification must not disagree inside one poll.
    const held = caseOf({ kind: "infra", state: "retired", rejectedAt });
    expect(incidents(storeWith({ "infra:agent-lost": held }))).toEqual([]);
    expect(incidents(storeWith({ "infra:agent-lost": caseOf({ kind: "infra" }) })).map((one) => one.key)).toEqual([
      "infra:agent-lost",
    ]);
  });

  it("a single-occurrence candidate", () => {
    const verdict = decide(probes({ store: storeWith({ [`flake:${FLAKE}`]: caseOf({ state: "candidate" }) }) }));
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("1 candidate(s) still short of evidence");
  });

  it("an infrastructure case — named, so an idle log says which", () => {
    const verdict = decide(
      probes({ store: storeWith({ "infra:check:Vercel:Account is blocked.": caseOf({ kind: "infra", state: "candidate" }) }) }),
    );
    expect(verdict.work).toBe(false);
    expect(verdict.why).toContain("infra:check:Vercel:Account is blocked.");
    expect(verdict.why).toContain("cannot fix");
  });

  it("a case another doctor holds — and it says so rather than 'healthy'", () => {
    const key = `flake:${FLAKE}`;
    const store = storeWith({ [key]: caseOf() });
    expect(decide(probes({ store })).work).toBe(true);
    const verdict = decide(probes({ store, held: [key] }));
    expect(verdict.work).toBe(false);
    expect(verdict.why).toBe(`every case is held by another doctor (${key})`);
  });

  it("a fixed flake with no recurrence boundary to judge against", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf({ state: "fixed", evidence: [seen(2700)] }) });
    expect(decide(probes({ store })).work).toBe(false);
  });

  it("an unreadable registry, whatever the store says", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf() });
    const verdict = decide(probes({ registry: null, store }));
    expect(verdict).toEqual({ work: false, why: "the ci-health registry could not be read", key: null });
  });

  it("a throttled read — before any priority, not after them", () => {
    // Unqualified in the spec, and right: the model would be handed a store
    // whose GitHub half this gate could not refresh.
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf() });
    const verdict = decide(probes({ rateLimited: true, retryAfterSeconds: 45, store }));
    expect(verdict.work).toBe(false);
    expect(verdict.rateLimited).toBe(true);
    expect(verdict.retryAfterSeconds).toBe(45);
    expect(verdict.why).toContain("GitHub asked for 45s");
  });

  it("a throttle even when the doctor's own PR was readable", () => {
    const verdict = decide(
      probes({
        rateLimited: true,
        prs: [{ number: 12, isDraft: false, body: "🤖 Ralph loop — run `r`" }],
      }),
    );
    expect(verdict.work).toBe(false);
  });
});

describe("a probe that could not be read but does not veto", () => {
  it("the pull-request list: a lower priority still wins, with the caveat named", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf() });
    expect(decide(probes({ prs: null, store })).work).toBe(true);
    expect(decide(probes({ prs: null })).why).toContain("open PRs unreadable");
  });

  it("the parked search", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf() });
    expect(decide(probes({ parked: null, store })).work).toBe(true);
    expect(decide(probes({ parked: null })).why).toContain("the parked-ticket search was not run");
  });
});

describe("actionable", () => {
  it("is a fixed flake, or a confirmed one this ticket was not unparked for yet", () => {
    const fixed = storeWith({ [`flake:${FLAKE}`]: caseOf({ state: "fixed" }) });
    expect(actionable(parked(), fixed)?.state).toBe("fixed");

    const confirmed = storeWith({ [`flake:${FLAKE}`]: caseOf({ state: "confirmed" }) });
    expect(actionable(parked(), confirmed)?.state).toBe("confirmed");

    const already = storeWith({
      [`flake:${FLAKE}`]: caseOf({ state: "confirmed" }),
      "parked:1557": caseOf({ kind: "parked", state: "handed-off", unparks: { [`flake:${FLAKE}`]: ["already"] } }),
    });
    expect(actionable(parked(), already)).toBeNull();
  });

  it("is nothing when the block record names no test, or no case matches it", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf() });
    expect(actionable(parked({ testId: null }), store)).toBeNull();
    expect(actionable(parked({ testId: "src/never-seen.test.ts" }), store)).toBeNull();
  });

  it("is nothing for a candidate — the diagnosis is not evidence yet", () => {
    const store = storeWith({ [`flake:${FLAKE}`]: caseOf({ state: "candidate" }) });
    expect(actionable(parked(), store)).toBeNull();
  });
});

describe("incidents", () => {
  it("are one push per signature, keyed by the first build, and only once", () => {
    const store = storeWith({
      "infra:agent-lost": caseOf({ kind: "infra", state: "candidate", evidence: [seen(2700), seen(2650)] }),
      "infra:already-paged": caseOf({ kind: "infra", state: "candidate", notified: "ci-incident:already-paged:1" }),
      [`flake:${FLAKE}`]: caseOf(),
    });
    const raised = incidents(store);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.key).toBe("infra:agent-lost");
    expect(raised[0]!.occurrence).toBe("ci-incident:agent-lost:2650");
    expect(raised[0]!.subject).toContain("agent-lost");
  });
});

describe("checkReadings", () => {
  it("reads the non-Buildkite checks off the pull-request list the gate already has", () => {
    const prs: PullRequestWithChecks[] = [
      {
        number: 1,
        isDraft: false,
        body: null,
        statusCheckRollup: [
          { name: "buildkite/loggd", state: "FAILURE" },
          { name: "Vercel", state: "FAILURE", description: "Account is blocked." },
          { context: "netlify", state: "SUCCESS" },
        ],
      },
    ];
    // Every named check, normalised. Dropping Buildkite is `checkIncidents`'s
    // rule (`classify.ts`), and a second copy of it here is how the two would
    // stop agreeing — so this reads, and that one filters.
    expect(checkReadings(prs)).toEqual([
      { pr: 1, name: "buildkite/loggd", state: "failure", description: "" },
      { pr: 1, name: "Vercel", state: "failure", description: "Account is blocked." },
      { pr: 1, name: "netlify", state: "success", description: "" },
    ]);
    expect(Object.keys(checkIncidents(checkReadings(prs), 1))).toEqual(["infra:check:Vercel:Account is blocked."]);
  });
});

describe("testIdOf", () => {
  it("reads the test a coder's block record quotes, from below its first line", () => {
    // §6's shape: the `blocked:` line, then the quoted failure underneath it.
    expect(testIdOf("blocked: PR #1681 red twice in CI\nunit: FAIL src/a.test.ts > flaps — Error: Test timed out")).toBe(
      "src/a.test.ts > flaps",
    );
  });

  it("falls back to the file when no test title is quoted, and gives up otherwise", () => {
    expect(testIdOf("blocked: src/a.test.ts keeps timing out")).toBe("src/a.test.ts");
    expect(testIdOf("blocked: the host was out of disk")).toBeNull();
  });

  it("is what parkedFrom puts on the ticket", () => {
    const read = parkedFrom(1557, "rafa", [
      { body: "ralph loop starting on this." },
      { body: "blocked: PR #1681 red twice in CI\nunit: FAIL src/a.test.ts > flaps — Error: timeout" },
    ]);
    expect(read.block).toEqual(expect.objectContaining({ kind: "other", pr: 1681 }));
    expect(read.ticket).toEqual({ number: 1557, loop: "rafa", testId: "src/a.test.ts > flaps", parkedOn: "flake" });
  });

  it("reads the reason and the test id off ONE record, not off two comments", () => {
    const read = parkedFrom(1557, "rafa", [
      { body: "blocked: an older block\nunit: FAIL src/old.test.ts > gone — Error: timeout" },
      { body: "needs-migration: draft PR #1242 ready; apply migrations/0062.sql" },
    ]);
    expect(read.block.kind).toBe("migration");
    // The newest record names no test, so the older record's must not leak in —
    // and a ticket waiting on a person is not parked on a flake in any case.
    expect(read.ticket.testId).toBeNull();
  });
});

describe("the lines the supervisor reads", () => {
  // `ralph.sh:1808` and `:1844`, verbatim. A prefix outside that character
  // class, or an em dash written as a hyphen, and the supervisor reads a case
  // of "" — which it then treats as an iteration with no work to do.
  const CASE_LINE = /^[A-Za-z0-9_.-]+: work available — (.*)$/;
  const CONTROL_LINE = /^[A-Za-z0-9_.-]+: control command waiting/;

  it("carry a case the supervisor can read off them", () => {
    const verdict: Verdict = { work: true, why: "Ralph PR #12 to shepherd", key: null };
    expect(CASE_LINE.exec(workLine(verdict))?.[1]).toBe("Ralph PR #12 to shepherd");
    expect(CASE_LINE.exec(verdictLine(verdict))?.[1]).toBe("Ralph PR #12 to shepherd");
    // And `SHEPHERD_PR`'s own pattern, off the same line.
    expect(/PR #(\d+) to shepherd/.exec(workLine(verdict))?.[1]).toBe("12");
  });

  it("never read as a case when there is none", () => {
    const line = verdictLine({ work: false, why: "CI is healthy", key: null });
    expect(line).toBe("ci-doctor-gate: nothing to do — CI is healthy");
    expect(CASE_LINE.test(line)).toBe(false);
  });

  it("hand back to the control checkpoint in the shape ralph.sh matches", () => {
    expect(CONTROL_LINE.test(CONTROL_PENDING_LINE)).toBe(true);
    expect(CASE_LINE.test(CONTROL_PENDING_LINE)).toBe(false);
  });

  it("prove an idle doctor is alive rather than dead", () => {
    const line = waitingLine(
      { work: false, why: "CI is healthy", key: null },
      { poll: 7, waitingSince: new Date(NOW - 4500_000), now: new Date(NOW), waitSeconds: 312 },
    );
    expect(line).toBe("ci-doctor-gate: CI is healthy at 2026-09-30T10:00:00Z — waiting 312s (poll 7, idle 1h15m)");
    expect(CASE_LINE.test(line)).toBe(false);
  });
});

describe("the poll interval", () => {
  it("prefers what the project configured, then the supervisor's, then 300s", () => {
    expect(pollSeconds({ ciDoctor: { pollSeconds: 120 } }, "600")).toBe(120);
    expect(pollSeconds({}, "600")).toBe(600);
    expect(pollSeconds(null, undefined)).toBe(DEFAULT_POLL_SECONDS);
    // Nonsense in either place falls through rather than throwing: a gate that
    // threw every cycle would poll GitHub in a tight loop.
    expect(pollSeconds({ ciDoctor: { pollSeconds: "soon" } }, "0")).toBe(DEFAULT_POLL_SECONDS);
  });

  it("jitters ±20% so the doctor drifts off its own coders' beat", () => {
    expect(jittered(300, () => 0)).toBe(240);
    expect(jittered(300, () => 1)).toBe(360);
    expect(jittered(300, () => 0.5)).toBe(300);
    expect(jittered(1, () => 0)).toBe(1);
  });

  it("waits out a throttle by what GitHub asked for, or five minutes", () => {
    expect(throttleWaitSeconds(90)).toBe(90);
    expect(throttleWaitSeconds(null)).toBe(300);
  });
});

describe("small pieces", () => {
  it("weighs a red on main at three ordinary reds and a dequeue at two", () => {
    expect(weigh({ redBuilds: 1, mainReds: 1, dequeues: 1 })).toBe(6);
  });

  it("reads a case key's subject past the first colon only", () => {
    expect(subjectOf("infra:check:Vercel:Account is blocked.")).toBe("check:Vercel:Account is blocked.");
  });

  it("calls nothing but a fixed flake past its boundary a recurrence", () => {
    expect(recurred(caseOf({ state: "fixed", fixedAt: { build: 2600, at: "" }, evidence: [seen(2600)] }))).toBe(false);
    expect(recurred(caseOf({ state: "confirmed", fixedAt: { build: 1, at: "" } }))).toBe(false);
  });

  // The doctor's gate is started by the same `run_intake_gate` pipeline as the
  // coder's, so its parent is an intermediate bash that outlives a killed
  // supervisor. Imported from `../frontier-gate` so a future split of the two
  // gates keeps them on one definition of liveness.
  it("asks the supervisor's pid, not its own parent, whether the supervisor is gone", () => {
    expect(supervisorPidFrom({ RALPH_SUPERVISOR_PID: "4321" }, 99)).toBe(4321);
    expect(supervisorGone(process.pid)).toBe(false);
    // Read from the source, because the helpers alone would stay green with
    // this gate reverted to `process.ppid` — and a reverted doctor's gate is
    // the whole bug back. Spawning the doctor needs a store, a fake `gh` and a
    // clock, so the shape is pinned the way the repo pins its other shapes;
    // `frontier-gate.test.ts` proves the running behaviour once, on the coder.
    const source = readFileSync(join(__dirname, "gate.ts"), "utf8");
    expect(source).toContain("const supervisorPid = supervisorPidFrom(process.env, process.ppid);");
    expect(source).toContain("if (supervisorGone(supervisorPid)) return \"orphaned\" as const;");
    expect(source).not.toContain("const supervisorPid = process.ppid;");
  });

});
