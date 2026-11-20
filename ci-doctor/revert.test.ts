// @vitest-environment node
/**
 * #162's acceptance criteria:
 *
 * - AC 1 — on an unambiguous culprit with `autoRevert` on, exactly ONE revert
 *   pull request, whose commit is produced by `git revert --no-edit <sha>` and
 *   nothing else. Asserted over the recorded call lists, which is also the only
 *   way to check the negative half: no `gh pr merge`, and no `@mergifyio`
 *   anywhere. The queue is the project's command, issued by the model.
 * - AC 2 — a forward-fix issue that links the revert pull request and is
 *   `## Blocked by` the revert ISSUE, so no coder starts the re-land first.
 * - AC 3 — four refusals, each filing the regression `priority:urgent` and
 *   opening no pull request. The "already reverted" one carries an EMPTY
 *   `store.reverts`, which is the point: the marker has to hold after the
 *   store is lost.
 * - AC 4 — a second red or dequeued round closes the pull request, abandons the
 *   revert and files urgent; there is never a third attempt for that culprit.
 * - AC 5 — `autoRevert: false` files every regression as urgent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAIM_REFUSED_EXIT } from "../claim-lease";
import { DEFAULT_NEVER_TOUCH } from "../executor-guard/diff-guard";
import { URGENT_LABEL } from "../frontier/next-tasks";

import { caseToken, issueBodyWithCaseMarker } from "./case-issue";
import type { Gh, Ran } from "./gate";
import { emptyStore, readStore, withStore, type Case, type CiHealthStore } from "./store";
import {
  autoRevert,
  eligibility,
  evidenceFromStore,
  MAX_REVERT_ROUNDS,
  neverTouchOf,
  probeRevert,
  forwardCaseKey,
  revertCaseKey,
  revertMarker,
  noticeMarker as revertNoticeMarker,
  runDecide,
  runFailed,
  runRetire,
  runRevert,
  scratchBranch,
  type CommandDeps,
  type Git,
  type RevertIo,
  type StoreIo,
} from "./revert";

const KEY = "regression:src/a.test.ts > renders";
const FLAKE_KEY = "flake:src/d.test.ts > flaps";
const SHA = "deadbeefcafe1234567890abcdefabcdefabcdef";
const SHORT = SHA.slice(0, 10);

/* -------------------------------------------------------------------------
 * Fakes. Shaped as `case-issue.test.ts:64-140`'s are, so the two suites
 * cannot drift on what "wrote nothing" means.
 * ---------------------------------------------------------------------- */

const ok = (stdout = ""): Ran => ({ ok: true, stdout, stderr: "" });
const bad = (stderr: string): Ran => ({ ok: false, stdout: "", stderr });
const json = (value: unknown): Ran => ok(JSON.stringify(value));

interface Row {
  number: number;
  state: string;
  body: string;
  labels: { name: string }[];
}

/** An issue the registry search returns, carrying the culprit-scoped revert marker. */
const revertRow = (number: number, sha: string): Row => ({
  number,
  state: "CLOSED",
  body: `${revertMarker(sha)}\n\nan earlier attempt`,
  labels: [{ name: "ci-health" }],
});

interface GhOver {
  /** Rows for `issue list`. */
  rows?: Row[];
  /** `issue view <n>` / `pr view <n>` answers, by number. Anything unlisted views as a bare issue with no comments. */
  views?: Record<number, unknown>;
  /** `pr list --head <branch>` answers. Empty by default: no pull request yet. */
  prs?: { number: number }[];
  issueNumbers?: number[];
  prUrl?: string;
}

function fakeGh(over: GhOver = {}): Gh & { calls: string[] } {
  const issues = [...(over.issueNumbers ?? [501, 502, 503])];
  const calls: string[] = [];
  const gh = (async (args: string[]): Promise<Ran> => {
    calls.push(args.join(" "));
    if (args[0] === "pr" && args[1] === "create") return ok(over.prUrl ?? "https://github.com/o/r/pull/777\n");
    if (args[0] === "pr" && args[1] === "list") return json(over.prs ?? []);
    if (args[1] === "view") {
      const number = Number(args[2]);
      return json(over.views?.[number] ?? { number, state: "OPEN", labels: [], body: "", comments: [] });
    }
    if (args[1] === "list") return json(over.rows ?? []);
    if (args[1] === "create") return ok(`https://github.com/o/r/issues/${issues.shift() ?? 599}\n`);
    return ok();
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}

/** An issue that `lookUp` will match for `key`, so `fileForCoders`/`ensureCaseIssue` find rather than create. */
const marked = (number: number, key: string, labels: string[] = ["ci-health"]): unknown => ({
  number,
  state: "OPEN",
  labels: labels.map((name) => ({ name })),
  body: issueBodyWithCaseMarker("already here", key),
  comments: [],
});

/** A `git` keyed by the whole argv, recording order. Anything unlisted succeeds silently. */
function fakeGit(over: Record<string, Ran> = {}): Git & { calls: string[] } {
  const calls: string[] = [];
  const git = ((args: string[]): Ran => {
    const line = args.join(" ");
    calls.push(line);
    return over[line] ?? ok("");
  }) as Git & { calls: string[] };
  git.calls = calls;
  return git;
}

const io = (over: Partial<RevertIo> = {}): RevertIo & { gh: Gh & { calls: string[] }; git: Git & { calls: string[] } } =>
  ({
    gh: fakeGh(),
    git: fakeGit(),
    claim: async () => ({ claimed: true, refusal: null }),
    lease: async () => ({ taken: true, holder: null }),
    release: async () => ({ released: true }),
    ...over,
  }) as RevertIo & { gh: Gh & { calls: string[] }; git: Git & { calls: string[] } };

/* The store is REAL, as `retry.test.ts:33-43` keeps it: the thing under test is
 * two callers agreeing on one file under a lock. */
const dirs: string[] = [];
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "revert-"));
  dirs.push(dir);
  return join(dir, "ci-health.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A confirmed main regression, as `classify` would have left it.
 *
 * `state: "confirmed"` and not `"open"`: `"open"` is not a member of
 * `CaseState` (`store.ts:99`) and only ever compiled through this fixture's
 * cast — which is exactly the kind of fiction a typed fixture is for.
 */
const regression = (over: Partial<Case["culprit"] & object> = {}): Case =>
  ({
    kind: "regression",
    state: "confirmed",
    evidence: [],
    cost72h: { redBuilds: 2, mainReds: 2, dequeues: 0 },
    issue: null,
    pr: null,
    fixAttempts: 0,
    unparks: {},
    rule: "red on 2 consecutive main builds",
    culprit: { commit: SHA, build: 42, parentBuild: 41, pr: 300, unambiguous: true, why: [], ...over },
  }) as unknown as Case;

async function seeded(path: string, shape: (store: CiHealthStore) => void): Promise<StoreIo> {
  const store = emptyStore();
  shape(store);
  // Awaited: `withStore`'s uncontended path happens to write before its first
  // `await`, but under contention the 50 ms retry would land the fixture AFTER
  // the module under test had read the store. `retry.test.ts` awaits for the
  // same reason.
  await withStore(path, (held) => {
    Object.assign(held, store);
  });
  return { path, with: withStore, read: readStore };
}

function deps(over: Partial<CommandDeps> & { store: StoreIo }): CommandDeps & {
  io: RevertIo & { gh: Gh & { calls: string[] }; git: Git & { calls: string[] } };
  lines: string[];
} {
  const lines: string[] = [];
  return {
    io: io(),
    config: { ciDoctor: { autoRevert: true } },
    loop: "ralph",
    baseBranch: "main",
    run: "run-1",
    session: "session-1",
    now: () => "2026-10-05T00:00:00.000Z",
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    ...over,
    lines,
  } as CommandDeps & { io: RevertIo & { gh: Gh & { calls: string[] }; git: Git & { calls: string[] } }; lines: string[] };
}

const ARGV = [KEY, "--evidence", "build #42 red, #41 green, FAIL renders", "--culprit-pr", "300", "--culprit-issue", "299"];

const created = (gh: Gh & { calls: string[] }, kind: "issue" | "pr"): string[] =>
  gh.calls.filter((call) => call.startsWith(`${kind} create`));

/* ======================================================================== */

describe("AC 1 — one revert pull request, and the queue is not ours to run", () => {
  it("opens exactly one pull request on an unambiguous culprit", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store });
    expect(await runRevert(ARGV, d)).toBe(0);

    expect(created(d.io.gh, "pr")).toHaveLength(1);
    expect(d.lines.join("\n")).toContain("revert: reverted:");
    expect(readStore(store.path).reverts[SHA]).toMatchObject({ case: KEY, pr: 777, state: "open" });
  });

  it("produces the commit with `git revert --no-edit` and nothing else", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store });
    await runRevert(ARGV, d);

    expect(d.io.git.calls).toContain(`revert --no-edit ${SHA}`);
    // Nothing reconstructs the diff by hand, which is what keeps
    // `verify.ts --revert-of` able to accept it through `revertSignature`.
    expect(d.io.git.calls.filter((call) => call.startsWith("apply") || call.startsWith("commit"))).toEqual([]);
  });

  it("never runs `gh pr merge` and never mentions the queue", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store });
    await runRevert(ARGV, d);

    expect(d.io.gh.calls.filter((call) => call.startsWith("pr merge"))).toEqual([]);
    expect(d.io.gh.calls.join("\n")).not.toContain("mergifyio");
    expect(d.io.git.calls.join("\n")).not.toContain(".mergify");
  });

  it("names the branch after the revert issue and pushes that name", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store, io: io({ gh: fakeGh({ issueNumbers: [610, 611] }) }) });
    await runRevert(ARGV, d);

    expect(d.io.git.calls).toContain(`branch -m ${scratchBranch(SHA)} ralph/610-revert-${SHORT}`);
    expect(d.io.git.calls).toContain(`push --set-upstream origin ralph/610-revert-${SHORT}`);
  });
});

describe("AC 2 — the forward fix links the revert and is blocked by its issue", () => {
  it("files it with the revert PR linked and the revert ISSUE as the blocker", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store, io: io({ gh: fakeGh({ issueNumbers: [610, 620] }) }) });
    await runRevert(ARGV, d);

    const filing = created(d.io.gh, "issue").find((call) => call.includes(forwardCaseKey(SHA)));
    expect(filing).toBeDefined();
    expect(filing).toContain("#777");
    // The blocker is the ISSUE, not the pull request: `## Blocked by` is read
    // by the frontier, which resolves issues.
    expect(filing).toContain("## Blocked by");
    expect(filing).toMatch(/## Blocked by[\s\S]*- #610/);
    expect(readStore(store.path).reverts[SHA]?.forwardIssue).toBe(620);
  });

  it("tells the culprit's issue and pull request once each", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store });
    await runRevert(ARGV, d);

    expect(d.io.gh.calls.filter((call) => call.startsWith("issue comment 299"))).toHaveLength(1);
    expect(d.io.gh.calls.filter((call) => call.startsWith("pr comment 300"))).toHaveLength(1);
  });
});

describe("AC 3 — every refusal files urgent and opens nothing", () => {
  const refuses = async (over: { case?: Case; config?: unknown; rows?: Row[]; git?: Record<string, Ran> }) => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = over.case ?? regression();
    });
    const gh = fakeGh({ rows: over.rows });
    const d = deps({
      store,
      config: over.config ?? { ciDoctor: { autoRevert: true } },
      io: io({ gh, git: fakeGit(over.git) }),
    });
    expect(await runRevert(ARGV, d)).toBe(0);
    expect(created(gh, "pr")).toEqual([]);
    expect(gh.calls.some((call) => call.startsWith("issue edit") && call.includes(URGENT_LABEL))).toBe(true);
    expect(d.lines.join("\n")).toContain("revert: filed-urgent:");
    // Recorded on the case, or `ci-doctor/gate.ts:273-275` re-offers this
    // regression on every poll and each poll is a whole doctor iteration.
    const after = readStore(store.path).cases[KEY];
    expect(after?.issue).not.toBeNull();
    expect(after?.state).toBe("handed-off");
    // And the culprit's own ticket is told ONCE, which the spec's urgent-filing
    // paragraph asks for and only `openRevert` used to do. `toHaveLength(1)`
    // rather than `some`: a `some` here is green on a double comment.
    expect(gh.calls.filter((call) => call.startsWith("issue comment 299"))).toHaveLength(1);
    return { gh, lines: d.lines, store };
  };

  it("refuses an ambiguous culprit and says why", async () => {
    const { gh } = await refuses({
      case: regression({ unambiguous: false, why: ["a main commit between them was never built"] }),
    });
    expect(created(gh, "issue").join("\n")).toContain("never built");
  });

  it("refuses when a revert already exists, found by marker with the store empty", async () => {
    const { store, gh } = await refuses({ rows: [revertRow(404, SHA)] });
    // The reason, not merely "something refused": any future condition firing
    // first would otherwise keep this green while the marker went unread. And
    // the filing points at the revert that exists, rather than describing the
    // regression as untouched.
    const filing = created(gh, "issue").join("\n");
    expect(filing).toContain("already exists");
    expect(filing).toContain("#404");
    // The marker decided, and it decided with `reverts` empty before AND
    // after: a refusal records nothing, so nothing here could have come from
    // the store. That is what makes the dedupe survive a lost store.
    expect(readStore(store.path).reverts).toEqual({});
  });

  it("refuses to revert a revert", async () => {
    await refuses({ git: { [`log -1 --format=%s ${SHA}`]: ok('Revert "feat: the thing"\n') } });
  });

  it("refuses to revert a revert found by its body trailer", async () => {
    await refuses({ git: { [`log -1 --format=%b ${SHA}`]: ok("This reverts commit abc1234.\n") } });
  });

  it("refuses a culprit that touches a neverTouch path", async () => {
    await refuses({ git: { [`show --name-only --format= ${SHA}`]: ok(".buildkite/pipeline.yml\nsrc/a.ts\n") } });
  });

  it("refuses when the revert does not apply, and leaves the checkout at the base", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const git = fakeGit({ [`revert --no-edit ${SHA}`]: bad("error: could not apply deadbeef") });
    const d = deps({ store, io: io({ git }) });
    expect(await runRevert(ARGV, d)).toBe(0);

    expect(created(d.io.gh, "pr")).toEqual([]);
    // The LAST occurrence of each, not the first: the probe detaches and
    // clears the scratch branch on the way IN as well, so a `findIndex` here
    // would compare the back-out against the setup and pass for free.
    const at = (needle: string): number => git.calls.lastIndexOf(needle);
    expect(at("revert --abort")).toBeGreaterThan(at(`revert --no-edit ${SHA}`));
    expect(at("switch --detach origin/main")).toBeGreaterThan(at("revert --abort"));
    expect(at(`branch -D ${scratchBranch(SHA)}`)).toBeGreaterThan(at("switch --detach origin/main"));
  });
});

describe("AC 4 — a revert red twice is closed, and never retried", () => {
  const withOpenRevert = async () =>
    seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: 777, forwardIssue: 620, state: "open" };
    });
  const failing = [KEY, "--evidence", "e", "--culprit-pr", "300", "--why", "the queue build failed"];

  it("counts the first round and writes nothing remote", async () => {
    const store = await withOpenRevert();
    const d = deps({ store });
    expect(await runFailed(failing, d)).toBe(0);

    expect(readStore(store.path).reverts[SHA]).toMatchObject({ rounds: 1, state: "open" });
    expect(d.io.gh.calls.filter((call) => call.startsWith("pr close") || call.startsWith("pr comment"))).toEqual([]);
    expect(d.lines.join("\n")).toContain("revert: nothing:");
  });

  it("closes the pull request on the second and files urgent", async () => {
    const store = await withOpenRevert();
    await withStore(store.path, (s) => {
      s.reverts[SHA] = { ...s.reverts[SHA]!, rounds: MAX_REVERT_ROUNDS - 1 };
    });
    const d = deps({ store });
    expect(await runFailed(failing, d)).toBe(0);

    expect(d.io.gh.calls).toContain("pr close 777");
    expect(d.io.gh.calls.some((call) => call.startsWith("pr comment 777"))).toBe(true);
    expect(d.io.gh.calls.some((call) => call.startsWith("issue edit") && call.includes(URGENT_LABEL))).toBe(true);
    expect(readStore(store.path).reverts[SHA]?.state).toBe("abandoned");
    expect(d.lines.join("\n")).toContain("revert: filed-urgent:");
  });

  it("does nothing on a third round and opens no second revert", async () => {
    const store = await withOpenRevert();
    await withStore(store.path, (s) => {
      s.reverts[SHA] = { ...s.reverts[SHA]!, rounds: MAX_REVERT_ROUNDS, state: "abandoned" };
    });
    const d = deps({ store });
    expect(await runFailed(failing, d)).toBe(0);
    expect(d.io.gh.calls).toEqual([]);
    expect(d.lines.join("\n")).toContain("revert: nothing:");

    // And `run` will not start a fresh one either: the store says the attempt
    // is spent, and that is what AC 4's "no second revert attempt" means.
    const again = deps({ store });
    expect(await runRevert(ARGV, again)).toBe(0);
    expect(created(again.io.gh, "pr")).toEqual([]);
  });
});

describe("AC 5 — autoRevert off files every regression", () => {
  it("files urgent with an otherwise perfect culprit", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store, config: { ciDoctor: { autoRevert: false } } });
    expect(await runRevert(ARGV, d)).toBe(0);

    expect(created(d.io.gh, "pr")).toEqual([]);
    expect(d.io.gh.calls.some((call) => call.startsWith("issue edit") && call.includes(URGENT_LABEL))).toBe(true);
    // No branch was cut either: an off switch that still moved the checkout
    // would be an off switch with a side effect.
    expect(d.io.git.calls.filter((call) => call.startsWith("switch") || call.startsWith("revert "))).toEqual([]);
  });
});

describe("what round 1's reviews found missing", () => {
  it("refuses a culprit whose message carries a revert marker", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const gh = fakeGh();
    const d = deps({
      store,
      io: io({ gh, git: fakeGit({ [`log -1 --format=%b ${SHA}`]: ok(`${revertMarker("abc1234")}\n`) }) }),
    });
    expect(await runRevert(ARGV, d)).toBe(0);
    expect(created(gh, "pr")).toEqual([]);
    expect(d.lines.join("\n")).toContain("revert: filed-urgent:");
  });

  it("finds a pull request left by a crash before the store write, instead of wedging", async () => {
    // The crash: the PR exists on the branch, the store never learned it.
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const gh = fakeGh({ issueNumbers: [610, 620], prs: [{ number: 777 }] });
    const d = deps({ store, io: io({ gh }) });
    expect(await runRevert(ARGV, d)).toBe(0);

    // No second `pr create`, and no throw: the head-branch lookup answered.
    expect(created(gh, "pr")).toEqual([]);
    expect(readStore(store.path).reverts[SHA]?.pr).toBe(777);
  });

  it("resumes a crash AFTER the push, where the store has no pull request yet", async () => {
    // The store learns the PR number only after `gh pr create`, so a run that
    // died between the push and that write leaves `{issue, pr: null}`. Keying
    // the no-re-probe shortcut on `held.pr` sent this case back through the
    // probe, where real git fails twice over: `branch -m` onto a name that
    // already exists, and a push of a fresh revert commit that is not an
    // ancestor of the pushed one. Both are faults, on every run, forever.
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: null, forwardIssue: null, state: "open" };
    });
    const branch = `ralph/610-revert-${SHORT}`;
    const git = fakeGit({
      // The remote already has it — this is what the resume must notice.
      [`ls-remote --heads origin ${branch}`]: ok(`abc123\trefs/heads/${branch}\n`),
      // And real git's answers if it went through the probe anyway.
      [`branch -m ${scratchBranch(SHA)} ${branch}`]: bad(`fatal: a branch named '${branch}' already exists`),
      [`push --set-upstream origin ${branch}`]: bad("! [rejected] (non-fast-forward)"),
    });
    const gh = fakeGh({ views: { 610: marked(610, revertCaseKey(SHA), ["ci-health", "ralph-wip"]) }, issueNumbers: [620] });
    const d = deps({ store, io: io({ gh, git }) });

    expect(await runRevert(ARGV, d)).toBe(0);
    // It opened the pull request against the head that was already pushed.
    expect(created(gh, "pr")).toHaveLength(1);
    expect(readStore(store.path).reverts[SHA]).toMatchObject({ pr: 777, forwardIssue: 620 });
    // And never touched the branch.
    for (const verb of ["branch", "push", "switch", "revert "]) {
      expect(d.io.git.calls.filter((call) => call.startsWith(verb))).toEqual([]);
    }
  });

  it("clears a stale local branch when the remote does NOT have it", async () => {
    // Same crash, one step earlier: the branch was renamed but never pushed.
    // Here the probe SHOULD run, and the rename has to survive the local name
    // already being taken.
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: null, forwardIssue: null, state: "open" };
    });
    const branch = `ralph/610-revert-${SHORT}`;
    const git = fakeGit({ [`ls-remote --heads origin ${branch}`]: ok("") });
    const gh = fakeGh({ views: { 610: marked(610, revertCaseKey(SHA), ["ci-health", "ralph-wip"]) }, issueNumbers: [620] });
    const d = deps({ store, io: io({ gh, git }) });

    expect(await runRevert(ARGV, d)).toBe(0);
    expect(git.calls).toContain(`revert --no-edit ${SHA}`);
    // The stale local name is dropped BEFORE the rename, or `branch -m` fails.
    const at = (needle: string): number => git.calls.lastIndexOf(needle);
    expect(at(`branch -D ${branch}`)).toBeLessThan(at(`branch -m ${scratchBranch(SHA)} ${branch}`));
  });

  it("counts a round from the documented command, with no --evidence", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.cases[KEY] = { ...s.cases[KEY]!, evidence: [{ build: 42, branch: "main", commit: SHA, kind: "assertion", line: "FAIL renders" }] };
      s.reverts[SHA] = { case: KEY, issue: 610, pr: 777, forwardIssue: 620, state: "open" };
    });
    const d = deps({ store });
    // Exactly what `prompts/ci-doctor.md` §2.4 prints — no evidence flag.
    expect(await runFailed([KEY, "--why", "the queue build failed"], d)).toBe(0);
    expect(readStore(store.path).reverts[SHA]?.rounds).toBe(1);
  });

  it("keeps the round count when it abandons", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: 777, forwardIssue: 620, state: "open", rounds: MAX_REVERT_ROUNDS - 1 };
    });
    const d = deps({ store });
    expect(await runFailed([KEY, "--why", "red again"], d)).toBe(0);
    const after = readStore(store.path).reverts[SHA];
    expect(after?.state).toBe("abandoned");
    // Not 1: the abandon used to spread a pre-lock read back over the count.
    expect(after?.rounds).toBe(MAX_REVERT_ROUNDS);
  });

  it("reports a lost claim race as a refusal, not a fault", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({
      store,
      io: io({ claim: async () => ({ claimed: false, refusal: "another loop holds #610" }) }),
    });
    // Exit 3, the repo's code for "another doctor has it" — not 1, which sends
    // the doctor down the fault path for a race that resolves itself.
    expect(await runRevert(ARGV, d)).toBe(CLAIM_REFUSED_EXIT);
    expect(d.lines.join("\n")).toContain("revert: refused:");
  });

  it("is a fault, not a refusal, when the registry answers with something that is not a list", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const gh = fakeGh();
    const broken: Gh & { calls: string[] } = Object.assign(
      async (args: string[]): Promise<Ran> => (args[1] === "list" && args[0] === "issue" ? ok("{}") : gh(args)),
      { calls: gh.calls },
    );
    const d = deps({ store, io: io({ gh: broken }) });
    // "No revert exists" is the one answer that must never be guessed: it is
    // the one that buys a second revert of the same commit.
    await expect(runRevert(ARGV, d)).rejects.toThrow(/could not read the ci-health registry/);
  });

  it("refuses to probe a dirty checkout rather than calling the revert a conflict", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store, io: io({ git: fakeGit({ "status --porcelain": ok(" M src/a.ts\n") }) }) });
    await expect(runRevert(ARGV, d)).rejects.toThrow(/not clean/);
  });

  it("reads the culprit's pull request off the case when the flag is absent", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const gh = fakeGh({ issueNumbers: [610, 620] });
    const d = deps({ store, io: io({ gh }) });
    // No `--culprit-pr`: the store has had the number since the scan.
    expect(await runRevert([KEY, "--evidence", "e"], d)).toBe(0);
    expect(created(gh, "issue").join("\n")).toContain("#300");
    expect(gh.calls.filter((call) => call.startsWith("pr comment 300"))).toHaveLength(1);
  });

  it("says so loudly when the forward fix could not be filed", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    // `fileForCoders` returns a NULL issue — not a throw — when its marker
    // search is unreadable (`case-issue.ts:187-197`). The search is by the
    // key's TOKEN, not the key, which is why this fake matches on the hash: an
    // earlier version of this test matched the raw key, missed the search
    // entirely, and tripped the `create` call instead — so it proved a throw
    // and left this branch untested.
    const base = fakeGh({ issueNumbers: [610] });
    const token = caseToken(forwardCaseKey(SHA));
    const gh: Gh & { calls: string[] } = Object.assign(
      async (args: string[]): Promise<Ran> =>
        args[0] === "issue" && args[1] === "list" && args.join(" ").includes(token) ? bad("could not search") : base(args),
      { calls: base.calls },
    );
    const d = deps({ store, io: io({ gh }) });
    // Exit 1 and a word that says the fix is NOT filed — not `reverted` with
    // the revert issue standing in for the re-land ticket. The revert itself
    // is open and fine; the next run files the fix.
    expect(await runRevert(ARGV, d)).toBe(1);
    expect(d.lines.join("\n")).toContain("forward fix could not be filed");
    expect(readStore(store.path).reverts[SHA]).toMatchObject({ pr: 777, forwardIssue: null });
  });
});

describe("retire — the urgent label comes off again", () => {
  const retiring = async (over: { state?: Case["state"]; main?: "green" | "red"; build?: number; evidenceBuild?: number }) =>
    seeded(storePath(), (s) => {
      s.cases[KEY] = {
        ...regression(),
        state: over.state ?? "retired",
        issue: 900,
        evidence: [{ build: over.evidenceBuild ?? 42, branch: "main", commit: SHA, kind: "assertion", line: "FAIL renders" }],
      };
      s.main = { state: over.main ?? "green", since: "2026-10-05T00:00:00.000Z", build: over.build ?? 50 };
    });
  const labelled = () => fakeGh({ views: { 900: { number: 900, labels: [{ name: URGENT_LABEL }] } } });

  it("removes it once the case has retired and main is green", async () => {
    const store = await retiring({});
    const gh = labelled();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls).toContain(`issue edit 900 --remove-label ${URGENT_LABEL}`);
    expect(d.lines.join("\n")).toContain("revert: retired:");
  });

  it("leaves it alone while main is still red", async () => {
    const store = await retiring({ main: "red" });
    const gh = labelled();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls.filter((call) => call.includes("--remove-label"))).toEqual([]);
    expect(d.lines.join("\n")).toContain("revert: nothing:");
  });

  it("leaves it alone while the case is still open", async () => {
    const store = await retiring({ state: "confirmed" });
    const gh = labelled();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls.filter((call) => call.includes("--remove-label"))).toEqual([]);
  });

  it("does not try to remove a label the issue does not carry", async () => {
    const store = await retiring({});
    const gh = fakeGh({ views: { 900: { number: 900, labels: [{ name: "ci-health" }] } } });
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls.filter((call) => call.includes("--remove-label"))).toEqual([]);
  });

  it("retires a `handed-off` case, which is the state the urgent filing actually writes", async () => {
    const store = await retiring({ state: "handed-off" });
    const gh = labelled();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls).toContain(`issue edit 900 --remove-label ${URGENT_LABEL}`);
  });

  it("will not retire a case whose test failed after main was read green", async () => {
    // "main green" is not "green on T": the recorded colour can be green
    // because T was skipped. The case's own newest evidence has to predate it.
    const store = await retiring({ build: 50, evidenceBuild: 51 });
    const gh = labelled();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([KEY], d)).toBe(0);
    expect(gh.calls.filter((call) => call.includes("--remove-label"))).toEqual([]);
    expect(d.lines.join("\n")).toContain("not green on this test yet");
  });

  it("sweeps with no key at all, which is the only form the doctor can reach", async () => {
    // `ci-doctor/gate.ts:274` stops offering a regression the moment it
    // retires, so there is never a key to pass — a single-key-only `retire`
    // drains nothing, which is the defect this covers.
    const other = "regression:src/b.test.ts > flaps";
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = { ...regression(), state: "handed-off", issue: 900, evidence: [] };
      s.cases[other] = { ...regression(), state: "retired", issue: 901, evidence: [] };
      // Live work, and a flake: neither is swept.
      s.cases["regression:src/c.test.ts > x"] = { ...regression(), state: "confirmed", issue: 902, evidence: [] };
      s.cases[FLAKE_KEY] = { ...regression(), kind: "flake", state: "retired", issue: 903, evidence: [] } as Case;
      s.main = { state: "green", since: "2026-10-05T00:00:00.000Z", build: 50 };
    });
    const gh = fakeGh({
      views: {
        900: { number: 900, labels: [{ name: URGENT_LABEL }] },
        901: { number: 901, labels: [{ name: URGENT_LABEL }] },
        902: { number: 902, labels: [{ name: URGENT_LABEL }] },
        903: { number: 903, labels: [{ name: URGENT_LABEL }] },
      },
    });
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([], d)).toBe(0);

    const removed = gh.calls.filter((call) => call.includes("--remove-label"));
    expect(removed).toHaveLength(2);
    expect(removed).toContain(`issue edit 900 --remove-label ${URGENT_LABEL}`);
    expect(removed).toContain(`issue edit 901 --remove-label ${URGENT_LABEL}`);
    // The open regression and the flake were never even read.
    expect(gh.calls.some((call) => call.startsWith("issue view 902"))).toBe(false);
    expect(gh.calls.some((call) => call.startsWith("issue view 903"))).toBe(false);
  });

  it("says so when nothing is retirable", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.main = { state: "green", since: "2026-10-05T00:00:00.000Z", build: 50 };
    });
    const gh = fakeGh();
    const d = deps({ store, io: io({ gh }) });
    expect(await runRetire([], d)).toBe(0);
    expect(gh.calls).toEqual([]);
    expect(d.lines.join("\n")).toContain("no retired regression");
  });
});

describe("evidenceFromStore — what the `failed` path files with", () => {
  it("names the first red build and the parent's green build, which the rows do not carry", () => {
    const body = evidenceFromStore({
      ...regression(),
      evidence: [{ build: 42, branch: "main", commit: SHA, kind: "assertion", line: "FAIL renders" }],
    } as Case);
    expect(body).toContain("#42");
    expect(body).toContain("#41");
    expect(body).toContain("FAIL renders");
  });

  it("says the parent had no green build rather than printing null", () => {
    const body = evidenceFromStore({ ...regression({ parentBuild: null }), evidence: [] } as Case);
    expect(body).not.toContain("null");
    expect(body).toContain("none in the window");
  });

  it("is not empty for a case the store has lost", () => {
    expect(evidenceFromStore(undefined).trim()).not.toBe("");
  });
});

describe("eligibility", () => {
  const args = {
    key: KEY,
    case: regression(),
    config: { ciDoctor: { autoRevert: true } },
    revertExists: false,
    culpritSubject: "feat: the thing",
    culpritBody: "",
    culpritFiles: ["src/a.ts"],
  };

  it("accumulates every refusal rather than stopping at the first", () => {
    const verdict = eligibility({
      ...args,
      case: regression({ unambiguous: false, why: ["never built"] }),
      culpritSubject: 'Revert "feat: the thing"',
    });
    expect(verdict.revert).toBe(false);
    expect(verdict.revert === false && verdict.why).toHaveLength(2);
  });

  it("passes a clean culprit", () => {
    expect(eligibility(args).revert).toBe(true);
  });

  it("refuses a case the store does not have", () => {
    expect(eligibility({ ...args, case: undefined }).revert).toBe(false);
  });

  it("refuses a case that is not a regression", () => {
    const flake = { ...regression(), kind: "flake" } as Case;
    expect(eligibility({ ...args, case: flake }).revert).toBe(false);
  });
});

describe("the config readers", () => {
  it("defaults autoRevert to on, including on a malformed value", () => {
    expect(autoRevert(null)).toBe(true);
    expect(autoRevert({})).toBe(true);
    expect(autoRevert({ ciDoctor: {} })).toBe(true);
    expect(autoRevert({ ciDoctor: { autoRevert: "no" } })).toBe(true);
    expect(autoRevert({ ciDoctor: { autoRevert: false } })).toBe(false);
  });

  it("falls back to the diff guard's neverTouch rather than fencing nothing", () => {
    expect(neverTouchOf(null)).toEqual(DEFAULT_NEVER_TOUCH);
    expect(neverTouchOf({ ciDoctor: { neverTouch: [] } })).toEqual(DEFAULT_NEVER_TOUCH);
    expect(neverTouchOf({ ciDoctor: { neverTouch: ["infra/**"] } })).toEqual(["infra/**"]);
  });
});

describe("probeRevert", () => {
  it("detaches before cutting, so a scratch branch it is standing on is replaceable", () => {
    const git = fakeGit();
    const probe = probeRevert({ git }, { sha: SHA, baseBranch: "main" });
    expect(probe.clean).toBe(true);
    expect(probe.branch).toBe(scratchBranch(SHA));
    const at = (needle: string): number => git.calls.findIndex((call) => call === needle);
    expect(at("switch --detach origin/main")).toBeLessThan(at(`branch -D ${scratchBranch(SHA)}`));
    expect(at(`branch -D ${scratchBranch(SHA)}`)).toBeLessThan(at(`switch -c ${scratchBranch(SHA)} origin/main`));
  });

  it("is a fault, not a refusal, when the conflicted checkout cannot be returned to the base", () => {
    const git = fakeGit({
      [`revert --no-edit ${SHA}`]: bad("conflict"),
      "switch --detach origin/main": bad("cannot"),
    });
    expect(() => probeRevert({ git }, { sha: SHA, baseBranch: "main" })).toThrow(/could not detach|could not be returned/);
  });
});

describe("decide", () => {
  it("writes nothing at all — no branch, no commit, no push", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
    });
    const d = deps({ store });
    expect(await runDecide([KEY], d)).toBe(0);

    expect(d.lines.join("\n")).toContain("revert: revert:");
    for (const verb of ["switch", "revert ", "commit", "push", "branch"]) {
      expect(d.io.git.calls.filter((call) => call.startsWith(verb))).toEqual([]);
    }
    expect(d.io.gh.calls.every((call) => call.includes("list") || call.includes("view"))).toBe(true);
  });

  it("prints the urgent verdict and its reasons when ineligible", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression({ unambiguous: false, why: ["never built"] });
    });
    const d = deps({ store });
    expect(await runDecide([KEY], d)).toBe(0);
    expect(d.lines.join("\n")).toContain("revert: urgent:");
    expect(d.lines.join("\n")).toContain("never built");
  });
});

describe("resuming a crashed run", () => {
  it("finishes the pull request and the forward fix rather than filing urgent", async () => {
    // Crashed after step 1: the issue exists and is recorded, nothing else is.
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: null, forwardIssue: null, state: "open" };
    });
    const gh = fakeGh({
      views: { 610: marked(610, revertCaseKey(SHA), ["ci-health", "ralph-wip"]) },
      issueNumbers: [620],
    });
    const d = deps({ store, io: io({ gh }) });
    expect(await runRevert(ARGV, d)).toBe(0);

    expect(d.lines.join("\n")).toContain("revert: reverted:");
    expect(created(gh, "pr")).toHaveLength(1);
    expect(readStore(store.path).reverts[SHA]).toMatchObject({ issue: 610, pr: 777, forwardIssue: 620 });
    // The probe DID run here, because no pull request was recorded yet.
    expect(d.io.git.calls).toContain(`revert --no-edit ${SHA}`);
  });

  it("reports `resumed` when there was nothing left to open", async () => {
    const store = await seeded(storePath(), (s) => {
      s.cases[KEY] = regression();
      s.reverts[SHA] = { case: KEY, issue: 610, pr: 777, forwardIssue: 620, state: "open" };
    });
    const notice = { body: revertNoticeMarker(SHA, "revert") };
    const gh = fakeGh({
      views: {
        // The revert issue, findable and already claimed.
        610: marked(610, revertCaseKey(SHA), ["ci-health", "ralph-wip"]),
        // The forward fix, findable by ITS OWN marker — the thing the first
        // version of this test got wrong, which let `fileForCoders` create a
        // fresh issue while the assertion still read `resumed`.
        620: { ...(marked(620, forwardCaseKey(SHA), ["ci-health", "ready-for-agent", "bug"]) as object) },
        // Both notices are already on the culprit, so `notify` writes nothing.
        299: { number: 299, state: "CLOSED", labels: [], body: "", comments: [notice] },
        300: { number: 300, state: "MERGED", labels: [], body: "", comments: [notice] },
      },
    });
    const d = deps({ store, io: io({ gh }) });
    expect(await runRevert(ARGV, d)).toBe(0);
    expect(d.lines.join("\n")).toContain("revert: resumed:");
    expect(created(gh, "pr")).toEqual([]);
    // `resumed` has to mean nothing was opened — including no issue, which the
    // weaker version of this test never checked.
    expect(created(gh, "issue")).toEqual([]);
    // And the pushed branch is left alone — the `log`/`show` reads of the
    // culprit still happen, but nothing MOVES the checkout. Re-probing would
    // make a fresh revert commit whose push is rejected as a
    // non-fast-forward, and would delete the branch §2.4 tells the doctor to
    // fix by hand after round 1.
    for (const verb of ["switch", "revert ", "branch", "push", "commit"]) {
      expect(d.io.git.calls.filter((call) => call.startsWith(verb))).toEqual([]);
    }
  });
});
