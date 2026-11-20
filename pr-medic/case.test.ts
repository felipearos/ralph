// @vitest-environment node
/**
 * The claim's release, against a fake `gh`: what the medic iteration may say
 * and label on the operator's pull request, and what it is refused.
 *
 * GitHub is the whole of this tool's outside world, so the fake records every
 * call and answers `pr view` from a pull request the test shapes. The writes
 * are asserted as the exact `gh` calls, in order — the comment before the
 * label, because a run that stops between them must leave the claim held.
 *
 * felipearos/ralph#248
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RATE_LIMITED_EXIT } from "../frontier/github-rate-limit";
import { adoptionMarker } from "./adoption";
import {
  main,
  marker,
  parseArgs,
  reading,
  REFUSED_EXIT,
  run,
  statusLines,
  USAGE_EXIT,
  type CaseDeps,
  type CaseProject,
  type CaseView,
  type Ran,
} from "./case";

const LOOP = "medi";
const HEAD = "a".repeat(40);
const PROJECT: CaseProject = { repo: "felipearos/loggd", requiredChecks: ["buildkite/loggd"], maxPushes: 3, medics: [LOOP], loops: ["rafa", LOOP] };

const RED = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "FAILURE", targetUrl: null }];
const GREEN = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "SUCCESS", targetUrl: null }];
const PENDING = [{ __typename: "StatusContext", context: "buildkite/loggd", state: "PENDING", targetUrl: null }];

const view = (over: Partial<CaseView> = {}): CaseView => ({
  number: 2197,
  state: "OPEN",
  isDraft: false,
  headRefName: "felipearosr/thing",
  headRefOid: HEAD,
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  labels: [{ name: `${LOOP}-wip` }],
  statusCheckRollup: GREEN,
  commits: [{ oid: HEAD, messageBody: "fix\n\nPr-Medic: medi" }],
  comments: [],
  ...over,
});

const ok = (stdout = ""): Ran => ({ status: 0, stdout, stderr: "" });

/** A fake gh answering `pr view` with `pr`, and recording every other call. */
function fake(pr: CaseView, answers: Partial<Record<"comment" | "edit", Ran>> = {}) {
  const calls: string[][] = [];
  const released: number[] = [];
  const deps: CaseDeps = {
    gh: (args) => {
      calls.push(args);
      if (args[1] === "view") return ok(JSON.stringify(pr));
      if (args[1] === "comment") return answers.comment ?? ok();
      if (args[1] === "edit") return answers.edit ?? ok();
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    },
    read: () => "",
    releaseLease: (issue) => {
      released.push(issue);
      return true;
    },
  };
  const writes = () => calls.filter((call) => call[1] !== "view");
  return { deps, calls, writes, released };
}

describe("the reading", () => {
  it("says where the pull request stands, in the order a write cares about", () => {
    expect(reading(view(), PROJECT, LOOP).standing).toBe("green");
    expect(reading(view({ statusCheckRollup: RED }), PROJECT, LOOP).standing).toBe("red");
    expect(reading(view({ statusCheckRollup: PENDING }), PROJECT, LOOP).standing).toBe("pending");
    // A required check that never reported is pending, as the gate reads it.
    expect(reading(view({ statusCheckRollup: [] }), PROJECT, LOOP).standing).toBe("pending");
    expect(reading(view({ mergeStateStatus: "DIRTY", statusCheckRollup: RED }), PROJECT, LOOP).standing).toBe("conflicting");
    expect(reading(view({ isDraft: true, mergeStateStatus: "DIRTY" }), PROJECT, LOOP).standing).toBe("draft");
    expect(reading(view({ state: "MERGED", isDraft: true }), PROJECT, LOOP).standing).toBe("closed");
  });

  it("counts medic pushes the gate's way, and shows only this loop's labels", () => {
    const r = reading(
      view({
        labels: [{ name: `${LOOP}-wip` }, { name: "mede-blocked" }, { name: "bug" }],
        commits: [
          { oid: "o", messageBody: "operator work" },
          { oid: "m1", messageBody: "x\n\nPr-Medic: medi" },
          { oid: HEAD, messageBody: "y\n\nPr-Medic: medi" },
        ],
      }),
      PROJECT,
      LOOP,
    );
    expect(r.pushes).toBe(2);
    expect(r.claim).toEqual([`${LOOP}-wip`]);
    expect(statusLines(r)).toContain("  pushes:  2 of 3 medic pushes since the operator's last");
  });

  it("knows when this head's red was already handed to the doctor, and only this head's", () => {
    const said = [{ body: `it is the doctor's\n\n${marker("handoff", LOOP, HEAD)}` }];
    expect(reading(view({ comments: said }), PROJECT, LOOP).handed).toBe(true);
    expect(reading(view({ comments: said, headRefOid: "b".repeat(40) }), PROJECT, LOOP).handed).toBe(false);
  });
});

describe("status", () => {
  it("writes nothing", () => {
    const gh = fake(view({ statusCheckRollup: RED }));
    const verdict = run(gh.deps, PROJECT, { verb: "status", pr: 2197, loop: LOOP });
    expect(verdict.exit).toBe(0);
    expect(verdict.lines[0]).toBe("pr-medic/case: #2197 is red — felipearosr/thing onto main");
    expect(gh.writes()).toEqual([]);
    expect(JSON.parse(run(gh.deps, PROJECT, { verb: "status", pr: 2197, loop: LOOP, json: true }).lines[0]!).standing).toBe("red");
  });
});

describe("done — the green handover", () => {
  const comment = "green, ready for you to merge — buildkite/loggd passed.";

  it("comments, then swaps -wip for -done", () => {
    const gh = fake(view());
    const verdict = run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment });
    expect(verdict.exit).toBe(0);
    expect(gh.writes()).toEqual([
      ["pr", "comment", "2197", "--repo", "felipearos/loggd", "--body", `${comment}\n\n${marker("done", LOOP, HEAD)}\n`],
      ["pr", "edit", "2197", "--repo", "felipearos/loggd", "--add-label", `${LOOP}-done`, "--remove-label", `${LOOP}-wip`],
    ]);
  });

  it.each([
    ["a red required check", { statusCheckRollup: RED }, "required checks are red"],
    ["a check still running", { statusCheckRollup: PENDING }, "still running"],
    ["a conflicting branch", { mergeStateStatus: "DIRTY" }, "conflicting"],
    ["a draft", { isDraft: true }, "draft"],
    ["a closed pull request", { state: "CLOSED" }, "closed"],
    ["no claim of this loop's", { labels: [{ name: "mede-wip" }] }, `no ${LOOP}-wip`],
  ] as const)("refuses %s, and writes nothing", (_, over, why) => {
    const gh = fake(view(over as Partial<CaseView>));
    const verdict = run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment });
    expect(verdict.exit).toBe(REFUSED_EXIT);
    expect(verdict.lines.join("\n")).toContain(why);
    expect(gh.writes()).toEqual([]);
  });

  it("is safe to run twice: no second comment, no second label write", () => {
    const after = view({
      labels: [{ name: `${LOOP}-done` }],
      comments: [{ body: `${comment}\n\n${marker("done", LOOP, HEAD)}` }],
    });
    const gh = fake(after);
    expect(run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment }).exit).toBe(0);
    expect(gh.writes()).toEqual([]);
  });

  it("finishes a swap an earlier run left half done, without saying it twice", () => {
    const half = view({ comments: [{ body: `${comment}\n\n${marker("done", LOOP, HEAD)}` }] });
    const gh = fake(half);
    expect(run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment }).exit).toBe(0);
    expect(gh.writes().map((call) => call[1])).toEqual(["edit"]);
  });
});

describe("blocked — the stuck path", () => {
  it("needs a first line the dashboard can read", () => {
    const gh = fake(view({ statusCheckRollup: RED }));
    const refused = run(gh.deps, PROJECT, { verb: "blocked", pr: 2197, loop: LOOP, comment: "stuck on it" });
    expect(refused.exit).toBe(REFUSED_EXIT);
    expect(refused.lines.join("\n")).toContain("`blocked:`");
    expect(gh.writes()).toEqual([]);
  });

  it("comments the diagnosis, then swaps -wip for -blocked", () => {
    const gh = fake(view({ statusCheckRollup: RED }));
    const comment = "blocked: 3 medic pushes and buildkite/loggd still red";
    expect(run(gh.deps, PROJECT, { verb: "blocked", pr: 2197, loop: LOOP, comment }).exit).toBe(0);
    expect(gh.writes()).toEqual([
      ["pr", "comment", "2197", "--repo", "felipearos/loggd", "--body", `${comment}\n\n${marker("blocked", LOOP, HEAD)}\n`],
      ["pr", "edit", "2197", "--repo", "felipearos/loggd", "--add-label", `${LOOP}-blocked`, "--remove-label", `${LOOP}-wip`],
    ]);
  });

  it("says nothing on a draft", () => {
    const gh = fake(view({ isDraft: true, statusCheckRollup: RED }));
    expect(run(gh.deps, PROJECT, { verb: "blocked", pr: 2197, loop: LOOP, comment: "blocked: x" }).exit).toBe(REFUSED_EXIT);
    expect(gh.writes()).toEqual([]);
  });
});

describe("handoff — the doctor's red", () => {
  it("comments which case it is and drops -wip, labelling nothing", () => {
    const gh = fake(view({ statusCheckRollup: RED }));
    const comment = "flake:e2e/onboarding.spec.ts is the ci-doctor's — not this branch's diff";
    expect(run(gh.deps, PROJECT, { verb: "handoff", pr: 2197, loop: LOOP, comment }).exit).toBe(0);
    expect(gh.writes()).toEqual([
      ["pr", "comment", "2197", "--repo", "felipearos/loggd", "--body", `${comment}\n\n${marker("handoff", LOOP, HEAD)}\n`],
      ["pr", "edit", "2197", "--repo", "felipearos/loggd", "--remove-label", `${LOOP}-wip`],
    ]);
  });

  it("does not say it twice for one head, even with the claim already gone", () => {
    const gh = fake(view({ labels: [], statusCheckRollup: RED, comments: [{ body: marker("handoff", LOOP, HEAD) }] }));
    expect(run(gh.deps, PROJECT, { verb: "handoff", pr: 2197, loop: LOOP, comment: "again" }).exit).toBe(0);
    expect(gh.writes()).toEqual([]);
  });
});

describe("drop — the operator has it", () => {
  it("removes this loop's -wip and nothing else, whatever the pull request's state", () => {
    for (const over of [{ state: "MERGED" }, { isDraft: true }, {}]) {
      const gh = fake(view({ ...over, labels: [{ name: `${LOOP}-wip` }, { name: "mede-blocked" }] }));
      expect(run(gh.deps, PROJECT, { verb: "drop", pr: 2197, loop: LOOP }).exit).toBe(0);
      expect(gh.writes()).toEqual([["pr", "edit", "2197", "--repo", "felipearos/loggd", "--remove-label", `${LOOP}-wip`]]);
    }
  });

  it("writes nothing when there is no claim to drop", () => {
    const gh = fake(view({ labels: [] }));
    expect(run(gh.deps, PROJECT, { verb: "drop", pr: 2197, loop: LOOP }).exit).toBe(0);
    expect(gh.writes()).toEqual([]);
  });
});

describe("an adopted pull request — every ending releases the ticket's lease", () => {
  const ADOPTED = "rafa/12-x";

  it.each([
    ["done", view({ headRefName: ADOPTED }), "green, ready for you to merge"],
    ["blocked", view({ headRefName: ADOPTED, statusCheckRollup: RED }), "blocked: still red"],
    ["handoff", view({ headRefName: ADOPTED, statusCheckRollup: RED }), "flake:x is the ci-doctor's"],
    ["drop", view({ headRefName: ADOPTED, state: "CLOSED" }), undefined],
  ] as const)("%s releases #12 after its label write, and an operator's branch releases nothing", (verb, pr, comment) => {
    const adopted = fake(pr);
    const verdict = run(adopted.deps, PROJECT, { verb, pr: 2197, loop: LOOP, comment });
    expect(verdict.exit).toBe(0);
    expect(adopted.released).toEqual([12]);
    expect(verdict.lines.join("\n")).toContain("lease on #12 released");

    const operator = fake({ ...pr, headRefName: "felipearosr/thing" });
    expect(run(operator.deps, PROJECT, { verb, pr: 2197, loop: LOOP, comment }).exit).toBe(0);
    expect(operator.released).toEqual([]);
  });

  it("drop with nothing to drop still releases the lease", () => {
    const gh = fake(view({ headRefName: ADOPTED, labels: [] }));
    expect(run(gh.deps, PROJECT, { verb: "drop", pr: 2197, loop: LOOP }).exit).toBe(0);
    expect(gh.writes()).toEqual([]);
    expect(gh.released).toEqual([12]);
  });

  it("does not release when the label write fails", () => {
    const gh = fake(view({ headRefName: ADOPTED }), { edit: { status: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" } });
    expect(run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment: "green" }).exit).toBe(RATE_LIMITED_EXIT);
    expect(gh.released).toEqual([]);
  });

  it("names the adoption markers the way adoption.ts does", () => {
    expect(marker("adopt", LOOP, HEAD)).toBe(adoptionMarker("adopt", LOOP, HEAD));
    expect(marker("handback", LOOP, HEAD)).toBe(adoptionMarker("handback", LOOP, HEAD));
  });
});

describe("handback — the owner is back", () => {
  it("says so once, drops -wip, labels nothing and releases the ticket", () => {
    const gh = fake(view({ headRefName: "rafa/12-x", statusCheckRollup: RED }));
    const verdict = run(gh.deps, PROJECT, { verb: "handback", pr: 2197, loop: LOOP });
    expect(verdict.exit).toBe(0);
    const writes = gh.writes();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.slice(0, 6)).toEqual(["pr", "comment", "2197", "--repo", "felipearos/loggd", "--body"]);
    expect(writes[0]?.[6]).toContain(marker("handback", LOOP, HEAD));
    expect(writes[1]).toEqual(["pr", "edit", "2197", "--repo", "felipearos/loggd", "--remove-label", `${LOOP}-wip`]);
    expect(writes.flat()).not.toContain("--add-label");
    expect(gh.released).toEqual([12]);
  });

  it("posts no second comment at the same head", () => {
    const gh = fake(view({ headRefName: "rafa/12-x", labels: [], comments: [{ body: marker("handback", LOOP, HEAD) }] }));
    expect(run(gh.deps, PROJECT, { verb: "handback", pr: 2197, loop: LOOP }).exit).toBe(0);
    expect(gh.writes()).toEqual([]);
  });

  it.each([
    ["an operator's branch", { headRefName: "felipearosr/thing" }, "no roster loop's branch"],
    ["a pull request without -wip", { headRefName: "rafa/12-x", labels: [] }, `no ${LOOP}-wip`],
    ["a draft", { headRefName: "rafa/12-x", isDraft: true }, "draft"],
    ["a closed pull request", { headRefName: "rafa/12-x", state: "CLOSED" }, "drop the claim instead"],
  ] as const)("refuses %s, and writes and releases nothing", (_, over, why) => {
    const gh = fake(view(over as Partial<CaseView>));
    const verdict = run(gh.deps, PROJECT, { verb: "handback", pr: 2197, loop: LOOP });
    expect(verdict.exit).toBe(REFUSED_EXIT);
    expect(verdict.lines.join("\n")).toContain(why);
    expect(gh.writes()).toEqual([]);
    expect(gh.released).toEqual([]);
  });
});

describe("the edges", () => {
  it("refuses a loop that is not a medic before asking GitHub anything", () => {
    const gh = fake(view());
    const verdict = run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: "ralph", comment: "x" });
    expect(verdict.exit).toBe(REFUSED_EXIT);
    expect(gh.calls).toEqual([]);
  });

  it("reports a throttled GitHub as 75, and a write it throttled too", () => {
    const throttled: Ran = { status: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded for user" };
    const readOnly: CaseDeps = { gh: () => throttled, read: () => "", releaseLease: () => false };
    expect(run(readOnly, PROJECT, { verb: "status", pr: 2197, loop: LOOP }).exit).toBe(RATE_LIMITED_EXIT);
    const gh = fake(view(), { edit: throttled });
    expect(run(gh.deps, PROJECT, { verb: "done", pr: 2197, loop: LOOP, comment: "green" }).exit).toBe(RATE_LIMITED_EXIT);
  });

  it("throws on a gh it could not ask at all", () => {
    const broken: CaseDeps = {
      gh: () => ({ status: 1, stdout: "", stderr: "no such pull request" }),
      read: () => "",
      releaseLease: () => false,
    };
    expect(() => run(broken, PROJECT, { verb: "status", pr: 2197, loop: LOOP })).toThrow(/no such pull request/);
  });

  it("parses only the four shapes it documents", () => {
    expect(parseArgs(["status", "7"])).toEqual({ verb: "status", pr: 7, commentFile: null, json: false });
    expect(parseArgs(["status", "7", "--json"])?.json).toBe(true);
    expect(parseArgs(["done", "7", "--comment-file", "c.md"])?.commentFile).toBe("c.md");
    expect(parseArgs(["done", "7"])).toBeNull();
    expect(parseArgs(["drop", "7", "--comment-file", "c.md"])).toBeNull();
    expect(parseArgs(["merge", "7"])).toBeNull();
    expect(parseArgs(["status"])).toBeNull();
    expect(parseArgs(["done", "--json", "7", "--comment-file", "c"])).toBeNull();
    expect(parseArgs(["handback", "12"])).toEqual({ verb: "handback", pr: 12, commentFile: null, json: false });
    expect(parseArgs(["handback", "12", "--comment-file", "f"])).toBeNull();
  });
});

describe("the command", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "pr-medic-case-"));
    roots.push(root);
    mkdirSync(join(root, ".ralph"));
    writeFileSync(
      join(root, ".ralph", "config.json"),
      JSON.stringify({
        repo: "felipearos/loggd",
        owner: "felipearosr",
        baseBranch: "main",
        displayName: "Loggd",
        secrets: { runner: "none", withhold: [] },
        refuseFiles: [],
        envCheck: [],
        requiredChecks: ["buildkite/loggd"],
        gates: { test: "bun run test" },
        promptFragment: ".ralph/prompt.md",
        coderFragment: ".ralph/coder.md",
        plan: ".ralph/plan.md",
        journal: { dir: "journal/loggd" },
        loops: ["ralph", { name: LOOP, role: "pr-medic" }],
        prMedic: { branches: ["felipearosr/*"], maxPushes: 2 },
      }),
    );
    return root;
  };

  it("reads the project's config and the loop from the environment", () => {
    const root = project();
    const gh = fake(view());
    const deps: CaseDeps = { ...gh.deps, read: () => "green, ready for you to merge" };
    const env = { RALPH_PROJECT: root, RALPH_LOOP_NAME: LOOP };
    expect(main(["done", "2197", "--comment-file", "c.md"], env, root, deps)).toBe(0);
    expect(gh.calls[0]).toEqual(["pr", "view", "2197", "--repo", "felipearos/loggd", "--json", expect.any(String)]);
    expect(gh.writes()).toHaveLength(2);
  });

  it("refuses an empty comment file and bad usage as 64", () => {
    const root = project();
    const gh = fake(view());
    const env = { RALPH_PROJECT: root, RALPH_LOOP_NAME: LOOP };
    expect(main(["done", "2197", "--comment-file", "c.md"], env, root, gh.deps)).toBe(USAGE_EXIT);
    expect(main(["done", "2197"], env, root, gh.deps)).toBe(USAGE_EXIT);
    expect(gh.writes()).toEqual([]);
  });
});
