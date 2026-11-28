// @vitest-environment node
/**
 * The ci-doctor, end to end over one fixture repository (#164).
 *
 * `onboard the doctor on loggd` asks for three things to be true of a doctor
 * loop before one is pointed at a real project, and each of them is a SEAM —
 * the gate's verdict reaching the case filing, the case filing reaching the
 * parked coder whose ticket it unblocks, the refusal to revert reaching the
 * frontier's urgent lane. Every one of those is green in its module's own
 * suite; what nothing covered until now is the hand-over between them, which
 * is where an onboarding actually fails.
 *
 * So the fixture is a scratch repository with a `doc` loop in its roster, a
 * shared Git common directory (so every CLI resolves ONE ci-health store), and
 * a fake `git` and `gh` on PATH that record what was asked. `case-issue.ts`,
 * `unpark.ts` and `revert.ts` run as REAL subprocesses against it.
 *
 * Two limits, stated so nothing here reads as more than it is.
 *
 * **The gate runs in-process.** `ci-doctor/gate.ts` cannot be driven as a
 * subprocess against a fake Buildkite: `bk-log.ts`'s `API` is a module
 * constant, its fetcher is a constructor argument, and `poll` short-circuits on
 * a failed scan before it decides anything. So `poll()` is called directly with
 * an injected `scan` that seeds the store, exactly as `ci-doctor/gate-poll.test.ts`
 * does — the decision under test is the real one, the Buildkite read is not.
 *
 * **Part of AC 1 is pinned, not driven.** The provenance line and the
 * `AWAIT_PR` hand-off ARE driven — the stamp comes out of the rendered prompt
 * and the gate is shown offering a pull request carrying it. But no CLI labels
 * `doc-done` or writes the journal, and nothing here can reach "merged" at
 * all: those are asserted on the rendered prompt, and each such assertion says
 * so.
 *
 * **The three scenarios share one fixture and run in order.** That is the
 * criteria's own wording — "in the same test" — and it is what makes them a
 * loop rather than three unrelated calls: AC 2's parked ticket is unparked for
 * the very flake AC 1 filed, off the same store. So each `describe` leaves the
 * store, the config and the fake `gh`'s answers where the next one starts.
 * Most tests here therefore fail under `-t` on their own — every one that
 * drives a CLI, and the in-process ones that read back what a CLI left (the
 * readied pull request, the filed issue's number). Only the three that assert
 * nothing but a pure function pass alone.
 *
 * Nothing here touches this repository's Git metadata, GitHub, or the
 * operator's `.ralph/logs/`.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "../dashboard/fixtures";
import { provenance, shepherdable } from "../frontier-gate";
import { buildTickets, classify, roleUnits, type RawIssue } from "../frontier/next-tasks";
import { requiredLabelsFor } from "../preflight";
import { parseProjectConfig, rosterEntries, validateProjectConfig } from "../project-config";
import { subprocessSuite } from "../test-timeouts";
import { noCache, poll, type Gh, type PollDeps, type Ran } from "./gate";
import { DEFAULT_FIX_SCOPE, DEFAULT_NEVER_TOUCH } from "../executor-guard/diff-guard";
import { neverTouchOf } from "./revert";
import { readStore, withStore, type Case, type CiHealthStore } from "./store";

subprocessSuite("runs the ci-doctor's CLIs end to end");

const REPO = join(__dirname, "..");

/** The bun running this suite, by absolute path — the fixture replaces PATH. */
const BUN =
  process.env.RALPH_TEST_BUN ??
  (() => {
    try {
      return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
    } catch {
      return process.execPath;
    }
  })();

/** The flake every scenario is about, and the ticket a coder parked on it. */
const FLAKE = "src/server/imports/library-merge.integration.test.ts > Library Merge > returns exact counts";
const PARKED = 1557;
const PARKED_PR = 1681;
/** The regression nothing may revert, and its culprit. */
const REGRESSION = "src/server/slow.integration.test.ts > slow > counts";
const CULPRIT = "9f1c2d3a4b5e6f708192a3b4c5d6e7f809112233";
/** Inside `ciDoctor.neverTouch`'s default, which is what makes the revert refused. */
const CULPRIT_FILES = [".github/workflows/ci.yml", "src/server/imports/library-merge.ts"];

const CODERS = ["ralph", "rafa"] as const;

/* --------------------------------------------------------------------------
 * The fixture repository.
 * ----------------------------------------------------------------------- */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  /** The `doc` loop's worktree, and every subprocess's cwd. */
  project: string;
  /** The shared Git common directory, where the one ci-health store lives. */
  common: string;
  storePath: string;
  /** Every `gh` argv the fixture has been asked for, in order. */
  ghCalls(): string[];
  /** What the fake `gh` answers `issue list` / `pr list` with. */
  ghList(rows: unknown): void;
  /** What it answers `issue view <n> --json comments,labels` with. */
  ghComments(issue: number, value: unknown): void;
  /** What it answers `pr view <n> --json isDraft,body` with. */
  ghPr(pr: number, value: unknown): void;
  /** What it answers `issue view <n> --json labels` with. */
  ghLabels(issue: number, value: unknown): void;
  /** The pull request as the fake serves it NOW — `pr ready` rewrites it. */
  prNow(pr: number): { isDraft: boolean; body: string };
  /** The next number `gh issue create` will hand back. */
  ghNextIssue(number: number): void;
  /** Run one of the ci-doctor CLIs as the `doc` loop would. */
  cli(script: string, args: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  store(): CiHealthStore;
  seed(mutate: (store: CiHealthStore) => void): Promise<void>;
}

const script = (path: string, body: string): void => {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

function fixture(): Fixture {
  // Resolved, because `paths.ts` normalises `RALPH_PROJECT` through
  // `realpathSync` while the fake `git` answers `pwd -P`: an unresolved root
  // would be two strings for one directory on any host whose `TMPDIR` is a
  // symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ci-doctor-e2e-")));
  roots.push(root);
  const common = join(root, "gitcommon");
  const project = join(root, "doc");
  const bin = join(root, "bin");
  for (const dir of [common, join(project, ".ralph", "logs"), bin]) mkdirSync(dir, { recursive: true });

  // `doc` is a ci-doctor; `ralph` and `rafa` are the coders whose `-blocked`
  // labels the gate searches and whose provenance the unparked PR carries.
  writeProjectConfig(project, [...CODERS, { name: "doc", role: "ci-doctor" }]);
  writeFileSync(join(project, ".ralph", "loop-name"), "doc\n");
  // `writeProjectConfig` names three fragments; `--render-prompt` refuses a
  // config whose fragment is missing, so the fixture carries empty ones. Empty
  // is the point: every line this suite asserts has to come from the harness's
  // own templates, not from a fixture fragment.
  for (const fragment of ["prompt.md", "coder.md", "plan.md"]) {
    writeFileSync(join(project, ".ralph", fragment), "");
  }

  // A `git` that answers the four reads these CLIs make and nothing else. The
  // `--git-common-dir` answer is the load-bearing one: it is how both the
  // ci-health store (`store.ts:378`) and the claim-lease store
  // (`claim-lease.ts:163`) resolve to one file per repository rather than one
  // per worktree.
  script(
    join(bin, "git"),
    `#!/bin/sh
case "$*" in
  *--git-common-dir*) printf '%s\\n' '${common}' ;;
  "rev-parse --show-toplevel") pwd -P ;;
  "rev-parse --short"*) printf 'abc1234\\n' ;;
  "symbolic-ref"*) printf 'doc/1-case\\n' ;;
  "status --porcelain") : ;;
  "log -1 --format=%s "*) printf 'feat: slower counts (#1234)\\n' ;;
  "log -1 --format=%b "*) printf '\\n' ;;
  "show --name-only --format= "*) printf '%s\\n' ${CULPRIT_FILES.map((f) => `'${f}'`).join(" ")} ;;
  *) exit 0 ;;
esac
`,
  );

  // A `gh` that logs every call and answers per verb. Deliberately NOT
  // `dashboard/fixtures.ts`'s one-body stub: these CLIs read a search, create,
  // read labels and write labels inside one run, so a single canned body
  // cannot serve them.
  //
  // It answers no `pr create`, on purpose. Nothing in these three scenarios
  // may open a pull request, and a fixture that handed one back would let a
  // revert this suite forbids look like it had worked.
  script(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> '${root}/gh-calls.txt'
case "$*" in
  "issue create"*)
    n=$(cat '${root}/gh-next' 2>/dev/null || echo 900)
    printf '%s\\n' "$((n + 1))" > '${root}/gh-next'
    printf 'https://github.com/o/r/issues/%s\\n' "$n"
    ;;
  "issue list"*|"pr list"*)
    cat '${root}/gh-list.json' 2>/dev/null || printf '[]\\n'
    ;;
  "issue view"*assignees*)
    printf '{"assignees":[],"labels":[],"closedByPullRequestsReferences":[],"state":"OPEN"}\\n'
    ;;
  "issue view"*comments*)
    cat "${root}/gh-comments-$3.json" 2>/dev/null || printf '{"comments":[],"labels":[]}\\n'
    ;;
  "issue view"*labels*)
    cat "${root}/gh-labels-$3.json" 2>/dev/null || printf '{"labels":[]}\\n'
    ;;
  "pr view"*state*)
    printf '{"state":"CLOSED"}\\n'
    ;;
  "pr view"*)
    cat "${root}/gh-pr-$3.json" 2>/dev/null || printf '{"isDraft":false,"body":""}\\n'
    ;;
  "pr ready"*)
    # The one write the fake PERFORMS rather than records: without it the
    # coder's side would have to be handed a hand-written non-draft PR, and
    # the seam this suite exists for would not be crossed.
    pr="${root}/gh-pr-$3.json"
    if [ -f "$pr" ]; then
      sed 's/"isDraft":true/"isDraft":false/' "$pr" > "$pr.tmp" && mv "$pr.tmp" "$pr"
    fi
    ;;
  *) exit 0 ;;
esac
`,
  );

  const storePath = join(common, "ralph", "ci-health.json");
  return {
    project,
    common,
    storePath,
    ghCalls: () =>
      readFileSync(join(root, "gh-calls.txt"), "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    ghList: (rows) => writeFileSync(join(root, "gh-list.json"), JSON.stringify(rows)),
    ghComments: (issue, value) => writeFileSync(join(root, `gh-comments-${issue}.json`), JSON.stringify(value)),
    ghPr: (pr, value) => writeFileSync(join(root, `gh-pr-${pr}.json`), JSON.stringify(value)),
    ghLabels: (issue, value) => writeFileSync(join(root, `gh-labels-${issue}.json`), JSON.stringify(value)),
    prNow: (pr) => JSON.parse(readFileSync(join(root, `gh-pr-${pr}.json`), "utf8")) as { isDraft: boolean; body: string },
    ghNextIssue: (number) => writeFileSync(join(root, "gh-next"), `${number}\n`),
    cli: (path, args, env = {}) =>
      spawnSync(BUN, [join(REPO, path), ...args], {
        cwd: project,
        encoding: "utf8",
        // An explicit PATH, never the ambient one: a real `git` or `gh` reached
        // from here would talk to this repository and to GitHub.
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          RALPH_PROJECT: project,
          RALPH_HOME: REPO,
          RALPH_LOOP_NAME: "doc",
          RALPH_RUN_ID: "doc-run-1",
          RALPH_SESSION_ID: "session-1",
          RALPH_BASE_BRANCH: "main",
          ...env,
        },
      }),
    store: () => readStore(storePath),
    seed: (mutate) => withStore(storePath, mutate),
  };
}

/** One fixture for all three scenarios: #164's criteria are "in the same test". */
const repo = fixture();
// In-process readers — `shepherdable`'s provenance and `requiredLabelsFor`'s
// roster — read the project the same way the subprocesses do.
process.env.RALPH_PROJECT = repo.project;

/* --------------------------------------------------------------------------
 * The gate, in-process.
 * ----------------------------------------------------------------------- */

const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const ok = (value: unknown): Ran => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });

/**
 * A `gh` for the gate alone, answering its four reads from `over`.
 *
 * Split by the same discriminators `readGithub` uses (`gate.ts:546-648`): the
 * pull-request list, a single issue's comments, the parked SEARCH, and
 * everything else, which is the `ci-health` registry.
 */
const gateGh = (over: { prs?: unknown; registry?: unknown; search?: unknown } = {}): Gh =>
  (async (args: string[]): Promise<Ran> => {
    if (args[0] === "pr") return ok(over.prs ?? []);
    if (args[1] === "view") return ok({ comments: [] });
    if (args.includes("--search")) return ok(over.search ?? []);
    return ok(over.registry ?? []);
  }) as Gh;

const gateDeps = (
  over: Parameters<typeof gateGh>[0] & { seed?: (store: CiHealthStore) => void } = {},
): PollDeps => ({
  gh: gateGh(over),
  // The real scan is a Buildkite read. `seed` writes what it would have
  // written, INSIDE the injected scan rather than before the call, so the
  // store is reached in the order `poll` reaches it — the shape
  // `gate-poll.test.ts:86-107` uses for the same reason.
  scan: async () => {
    if (over.seed) await withStore(repo.storePath, over.seed);
    return { ok: true, why: "" };
  },
  notify: () => {},
  now: () => T0,
  storePath: repo.storePath,
  loop: "doc",
  run: "doc-run-1",
  coders: CODERS,
  alive: () => true,
});

const flakeCase = (over: Partial<Case> = {}): Case => ({
  kind: "flake",
  state: "confirmed",
  rule: "cross-branch recurrence",
  evidence: [{ build: 2627, branch: "rafa/1557-counts", commit: "deadbee", kind: "timeout", line: `FAIL ${FLAKE}` }],
  cost72h: { redBuilds: 3, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
  ...over,
});

/* --------------------------------------------------------------------------
 * AC 1 — a confirmed flake becomes a case the doctor holds.
 * ----------------------------------------------------------------------- */

describe("a confirmed flake, from the gate's verdict to a claimed ci-health issue", () => {
  it("offers the flake as the case, and leases it to this doctor", async () => {
    const polled = await poll(
      gateDeps({ seed: (store) => { store.cases[`flake:${FLAKE}`] = flakeCase(); } }),
      noCache(),
    );

    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.key).toBe(`flake:${FLAKE}`);
    // This exact string is what the iteration receives: `ralph.sh:1867` seds it
    // out of `… work available — <why>` into `RALPH_INTAKE_CASE`, so a reworded
    // verdict is a reworded case brief.
    expect(polled.verdict.why).toBe(`confirmed flake ${FLAKE} — 72h cost 3`);
    // Leased before the hand-over, or a second doctor on the same store would
    // be handed the same case.
    expect(repo.store().leases[`flake:${FLAKE}`]?.loop).toBe("doc");
  });

  it("files it as a ci-health issue the doctor claims with doc-wip", () => {
    repo.ghList([]);
    repo.ghNextIssue(1900);
    writeFileSync(join(repo.project, "case.md"), `72h cost 3, three red builds on two branches.\n`);

    const run = repo.cli("ci-doctor/case-issue.ts", [
      "ensure",
      `flake:${FLAKE}`,
      "--title",
      `flaky: ${FLAKE}`,
      "--body-file",
      join(repo.project, "case.md"),
    ]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // `created`, not `(created|found)`: nothing had filed this case, so a run
    // that reported `found` would have adopted an issue it matched by
    // accident. The word and the number are the contract; the sentence around
    // them is not, so this is `toContain` like every other outcome line here.
    expect(run.stdout).toContain(`#1900 created and claimed for flake:${FLAKE}`);

    const calls = repo.ghCalls();
    const created = calls.findIndex((c) => c.startsWith("issue create"));
    const claimed = calls.findIndex((c) => c === "issue edit 1900 --add-label doc-wip");
    expect(created, `no issue create in ${calls.join(" | ")}`).toBeGreaterThanOrEqual(0);
    // The doctor's own case carries `ci-health` and NOTHING else: handing it to
    // the coders as `ready-for-agent` is a different command
    // (`case-issue.ts:70` vs `:75`), and a case filed straight into the
    // coders' queue is a case the doctor never diagnoses.
    expect(calls[created]).toContain("--label ci-health");
    expect(calls[created]).not.toContain("ready-for-agent");
    expect(calls[created]).not.toContain("--label bug");
    // And the claim is written after the issue exists, with the doctor's own
    // label — the one the frontier's fence and the gate's resume both read.
    expect(claimed).toBeGreaterThan(created);

    const filed = repo.store().cases[`flake:${FLAKE}`];
    expect(filed?.state).toBe("filed");
    expect(filed?.issue).toBe(1900);
  });

  it("requires exactly the labels this project must carry for a doc loop", () => {
    // The list AC 4 checks on loggd by hand, derived two ways at once — the
    // triple from the loop's NAME (`next-tasks.ts:184-192`) and the role
    // vocabulary from the ci-doctor descriptor (`roles.ts:567`).
    //
    // `preflight.test.ts` already covers `roleLabels` and a doctor's whole
    // preflight, so this is not new proof of the function — it is the list
    // written down where the onboarding can be read off it. The roster comes
    // out of the fixture's own config for provenance, not for effect:
    // `requiresDifficultyLabels` is false for this role, so
    // `preflight.ts:229-230` returns before reading it and an empty roster
    // would answer the same.
    const roster = rosterEntries(parseProjectConfig(readFileSync(join(repo.project, ".ralph", "config.json"), "utf8")).loops);
    expect(requiredLabelsFor("doc", "ci-doctor", roster)).toEqual({
      labels: ["doc-wip", "doc-blocked", "doc-done", "ci-health", "priority:urgent"],
    });
  });

  it("asks for a provenance line its own gate will recognise, and hands the wait back on it", async () => {
    // AC 1's "a fix PR with the doctor's provenance, then `AWAIT_PR`".
    //
    // The stamp is taken out of the RENDERED prompt rather than written here,
    // because the drift this guards against is between the two halves: the
    // prompt tells the doctor what to write, and `frontier-gate.ts:71`'s
    // `provenance()` — a regex built from the project's roster — is what reads
    // it back. A stamp no gate recognises leaves a green pull request unread
    // for ever, and either half can be reworded on its own.
    const rendered = repo.cli("models.ts", ["--render-prompt", "--role", "ci-doctor"]);
    expect(rendered.status, rendered.stderr).toBe(0);
    const template = rendered.stdout.split("\n").find((line) => line.includes("🤖") && line.includes("loop — run"));
    expect(template, "the rendered ci-doctor prompt no longer asks for a provenance line").toBeDefined();
    // `<Loop>` is `$RALPH_LOOP_NAME` capitalised, per the prompt's own next
    // sentence; the rest of the line is substituted as the model would.
    const stamped = template!
      .trim()
      .replace("<Loop>", "Doc")
      .replace("$RALPH_RUN_ID", "doc-run-1")
      .replace("$RALPH_SESSION_ID", "session-1");
    expect(provenance().exec(stamped)?.[1]?.toLowerCase()).toBe("doc");

    // And the gate then OFFERS it, ahead of every case in the store: that
    // offer is what starts the iteration that ends in `AWAIT_PR`.
    const polled = await poll(
      gateDeps({ prs: [{ number: 1901, isDraft: false, body: `Closes #1900\n\n${stamped}\n` }] }),
      noCache(),
    );
    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.why).toBe("Doc PR #1901 to shepherd");
    // No case key: a pull request is claimed by its provenance line, and
    // leasing one would be a second claim on one thing.
    expect(polled.verdict.key).toBeNull();
    // A draft is a deliberate blocked hand-off and must NOT be offered, or the
    // doctor spins on a PR it is meant to leave alone.
    const draft = await poll(
      gateDeps({ prs: [{ number: 1901, isDraft: true, body: `Closes #1900\n\n${stamped}\n` }] }),
      noCache(),
    );
    expect(draft.verdict.why).not.toContain("to shepherd");
  });

  it("hands the rest of the criterion to a prompt that asks for it", () => {
    // What is left of AC 1 after the test above: `doc-done` and the journal's
    // `**Case:**` line. Both are the MODEL's steps — no CLI performs them, and
    // nothing in the repo parses a journal — so the only honest check is that
    // the prompt this fixture's doc loop renders still asks for them.
    // `prompt-render.test.ts` owns the generic render; what is proved here is
    // that the chain reaches a doc loop in a project whose roster was written
    // by `writeProjectConfig`. "Merged" is the one clause nothing here can
    // reach at all.
    const run = repo.cli("models.ts", ["--render-prompt", "--role", "ci-doctor"]);
    expect(run.status, run.stderr).toBe(0);
    const flat = run.stdout.replace(/\s+/g, " ");
    for (const needle of ["$RALPH_LOOP_NAME-done", "**Case:**"]) {
      expect(flat, `the rendered ci-doctor prompt no longer asks for ${needle}`).toContain(needle);
    }
  });

  it("names the rejection command, and asks for the reason in the journal (#240)", () => {
    // AC 1's "in one command" and AC 3's "the reason appears in the journal"
    // are the model's steps, as above: `recordRejected` writes the store, but
    // nothing in the repo makes a doctor RUN it or parses a journal entry
    // afterwards. So the fence is that the prompt a doc loop renders still
    // names the verb and still asks for the reason.
    const run = repo.cli("models.ts", ["--render-prompt", "--role", "ci-doctor"]);
    expect(run.status, run.stderr).toBe(0);
    const flat = run.stdout.replace(/\s+/g, " ");
    for (const needle of ['ci-doctor/case-issue.ts" reject', "--reason", "journal the rejection and its reason"]) {
      expect(flat, `the rendered ci-doctor prompt no longer names ${needle}`).toContain(needle);
    }
  });

  it("dispatches the `reject` verb the prompt names (#240)", () => {
    // The pair the test above cannot fence on its own: it only greps the
    // rendered prompt, so renaming the verb in `main()` alone would leave it
    // green while every doctor following §1.1 got "unknown command". Every
    // `runReject` unit test calls the function directly and misses the same
    // gap, so the dispatch is asserted here, through the real CLI.
    const run = repo.cli("ci-doctor/case-issue.ts", ["reject", "flake:src/nothing.test.ts > x", "--reason", "not a flake"]);
    expect(run.stderr).not.toContain("unknown command");
    // The store this synthesised project has never seen the case, which is the
    // `reject` path's own refusal — reached only if the verb dispatched at all.
    expect(run.stderr).toContain("nothing rejected");
    expect(run.status).toBe(1);
  });

  it("refuses to reject a case the scan never re-proposes (#240)", () => {
    // A rejection the fold can never lift would be worse than the re-offer
    // this ticket set out to stop: `infra:check:` evidence is written with
    // `build: 0`, so no build could ever overtake the boundary.
    const run = repo.cli("ci-doctor/case-issue.ts", [
      "reject",
      "infra:check:Vercel:deployment blocked",
      "--reason",
      "not ours to fix",
    ]);
    expect(run.stderr).toContain("nothing could ever lift the rejection");
    expect(run.status).toBe(1);
  });
});

/* --------------------------------------------------------------------------
 * AC 2 — the coder's parked ticket, unparked once the fix has merged.
 * ----------------------------------------------------------------------- */

describe("a parked coder ticket, unparked once the flake's fix has merged", () => {
  /** The block record a coder leaves under §6, which is where the test id comes from. */
  const BLOCK = `blocked: PR #${PARKED_PR} red twice in CI; not reproducible locally\n\nquality: FAIL ${FLAKE} — Error: timed out in 5000ms\n`;
  /** The coder's own provenance line — `shepherdable` reads this and nothing else. */
  const PROVENANCE = "🤖 Rafa loop — run `rafa-run-1` · iteration session `s1`";

  it("offers the parked ticket as the next case once the flake reads fixed", async () => {
    const seed = (store: CiHealthStore): void => {
      // The fix landed: #1900 closed and the case is `fixed`, which is the
      // first of `actionable`'s two openings (`gate.ts:202-217`).
      store.cases[`flake:${FLAKE}`] = flakeCase({ state: "fixed", issue: 1900, fixedAt: { build: 2631, at: "2026-10-06T09:00:00.000Z" } });
      store.cases[`parked:${PARKED}`] = {
        kind: "parked",
        state: "confirmed",
        rule: FLAKE,
        parkedOn: "flake",
        evidence: [],
        cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
        issue: PARKED,
        pr: PARKED_PR,
        fixAttempts: 0,
        unparks: {},
      };
      // The lease scenario 1 took is this doctor's own and would otherwise
      // still hold the flake case; the fix has merged, so it is released.
      delete store.leases[`flake:${FLAKE}`];
    };

    const polled = await poll(
      gateDeps({
        seed,
        // The registry: the case's own issue, closed by the merge, so priority
        // 3 ("this loop's unfinished claim") correctly does not fire.
        registry: [{ number: 1900, state: "CLOSED", labels: [{ name: "ci-health" }] }],
        search: [{ number: PARKED, labels: [{ name: "rafa-blocked" }] }],
      }),
      noCache(),
    );

    expect(polled.verdict.work).toBe(true);
    expect(polled.verdict.key).toBe(`parked:${PARKED}`);
    // `toContain`, as `gate-poll.test.ts` pins every verdict but the one
    // `ralph.sh` seds: what has to hold is the ticket, the state the flake is
    // in, and which flake — not the sentence around them.
    expect(polled.verdict.why).toContain(`parked ticket #${PARKED}`);
    expect(polled.verdict.why).toContain(`(fixed) is ${FLAKE}`);
  });

  it("comments, unblocks and readies the draft, in that order", () => {
    repo.ghComments(PARKED, { comments: [{ body: BLOCK }], labels: [{ name: "rafa-blocked" }] });
    // The draft the coder left behind. Its body MUST name the ticket or
    // `unpark.ts:575-578` refuses — the one fence that stops a mistyped
    // `--pr` readying somebody else's draft.
    repo.ghPr(PARKED_PR, { isDraft: true, body: `Closes #${PARKED}\n\n${PROVENANCE}\n` });
    const before = repo.ghCalls().length;

    const run = repo.cli("ci-doctor/unpark.ts", [
      String(PARKED),
      "--pr",
      String(PARKED_PR),
      "--diagnosis",
      `flake:${FLAKE}`,
      "--evidence",
      "three red builds on two branches; fixed by #1900",
    ]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // The steps are the contract — all four of them, in one run. The line's
    // doubled `unpark: unpark:` is `PREFIX` meeting an outcome KIND of the
    // same name (`unpark.ts:517`, `:607`); nothing machine-reads it, so it is
    // reported on the pull request rather than frozen here.
    expect(run.stdout).toContain(`unparked #${PARKED} — commented, unblocked, readied, recorded`);

    const calls = repo.ghCalls().slice(before);
    const writes = calls.filter((c) => /^(issue comment|issue edit|pr ready)/.test(c)).map((c) => c.split(" --body")[0]);
    // The order is the module's crash-safety contract: readying last leaves an
    // interruption showing a visibly unfinished draft rather than a silently
    // lost one.
    expect(writes).toEqual([
      `issue comment ${PARKED}`,
      `issue edit ${PARKED} --remove-label rafa-blocked`,
      `pr ready ${PARKED_PR}`,
    ]);
    // The label removed is the one the ticket CARRIES, not the doctor's own:
    // `doc-blocked` here would leave the coder's claim in place and the ticket
    // invisible to everyone.
    expect(calls.join(" | ")).not.toContain("doc-blocked");

    const unparks = repo.store().cases[`parked:${PARKED}`]?.unparks[`flake:${FLAKE}`];
    expect(unparks).toHaveLength(1);
  });

  it("does nothing the second time, and records no second unpark", () => {
    // The world the first run left behind. The pull request is already
    // non-draft because the fake's `pr ready` rewrote it, not because this
    // test said so — which is the half that matters: with the PR still
    // showing as a draft the module correctly reads an interrupted run and
    // RESUMES it, a different outcome from this one.
    expect(repo.prNow(PARKED_PR).isDraft).toBe(false);
    const comment = repo
      .ghCalls()
      .find((c) => c.startsWith(`issue comment ${PARKED}`))!;
    const body = comment.slice(comment.indexOf("--body ") + "--body ".length);
    repo.ghComments(PARKED, { comments: [{ body: BLOCK }, { body }], labels: [] });

    const run = repo.cli("ci-doctor/unpark.ts", [
      String(PARKED),
      "--pr",
      String(PARKED_PR),
      "--diagnosis",
      `flake:${FLAKE}`,
      "--evidence",
      "three red builds on two branches; fixed by #1900",
    ]);

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^unpark: nothing:/);
    expect(repo.store().cases[`parked:${PARKED}`]?.unparks[`flake:${FLAKE}`]).toHaveLength(1);
  });

  it("leaves a PR the coder's own gate will shepherd", () => {
    // The point of readying it, and the seam: the pull request handed to the
    // coder's answer is the one the fake `gh` serves NOW — after
    // `unpark.ts`'s own `pr ready` — not one this test wrote. `shepherdable`
    // (`frontier-gate.ts:199`) is the coder gate's own answer, and it reads
    // the provenance line rather than the branch prefix.
    const readied = { number: PARKED_PR, ...repo.prNow(PARKED_PR) };
    expect(readied.isDraft).toBe(false);
    expect(shepherdable([readied], "rafa")?.number).toBe(PARKED_PR);
    // A draft is invisible to it, which is exactly what the unpark changed.
    expect(shepherdable([{ ...readied, isDraft: true }], "rafa")).toBeNull();
    // And it is rafa's, not this doctor's, whoever readied it. This is the
    // assertion that depends on the roster: `provenance()` is built from
    // `loopRoster()`, so a project whose config did not list `rafa` would
    // answer null here even for a correctly stamped pull request.
    expect(shepherdable([readied], "doc")).toBeNull();
  });
});

/* --------------------------------------------------------------------------
 * AC 3 — a regression nothing may revert, filed urgent, offered first.
 * ----------------------------------------------------------------------- */

describe("a regression nothing may revert, filed urgent and offered to a coder first", () => {
  /** The number the urgent filing got, parsed out of the subprocess's stdout. */
  let urgent = 0;
  /** The labels the subprocess actually put on it, read off the `gh` call log. */
  let urgentLabels: string[] = [];

  /**
   * The `ciDoctor` block #164 step 1 prescribes for loggd.
   *
   * `fixScope` is `DEFAULT_FIX_SCOPE` written out
   * (`executor-guard/diff-guard.ts:65-70`) — test files only, which is what
   * felipearos/ralph#152 decided; the issue names the key without enumerating
   * it, and widening it to `src/**` here would put a block in front of whoever
   * writes loggd's that lets the doctor edit production source.
   *
   * `neverTouch` deliberately DIFFERS from `DEFAULT_NEVER_TOUCH`: it narrows
   * `.github/**` to `.github/workflows/**` and drops `scripts/buildkite-*`.
   * That difference is what makes the refusal below falsifiable — with the
   * default's own entries, a `neverTouchOf` that ignored project config
   * entirely would pass the test identically.
   */
  const CI_DOCTOR_BLOCK = {
    fixScope: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**", "src/test/**"],
    neverTouch: [".buildkite/**", ".mergify.yml", ".github/workflows/**", ".ralph/**"],
    pollSeconds: 300,
    windowHours: 72,
    autoRevert: true,
    retry: { perCandidate: 1, perDay: 6 },
  };

  it("accepts the ciDoctor block the ticket prescribes", () => {
    const path = join(repo.project, ".ralph", "config.json");
    const config = { ...JSON.parse(readFileSync(path, "utf8")), ciDoctor: CI_DOCTOR_BLOCK };
    // The one part of step 1 this repository can judge without loggd: that the
    // block the ticket dictates is one `project-config.ts` accepts. `retry`
    // may be lowered and never raised, so 1/6 passing is also the check that
    // the prescribed figures are the ceiling rather than above it.
    expect(validateProjectConfig(config)).toEqual([]);
    // And that the declared fence is the one the revert path will read, rather
    // than the harness default it replaces.
    expect(neverTouchOf(config)).toEqual(CI_DOCTOR_BLOCK.neverTouch);
    expect(neverTouchOf(config)).not.toEqual(DEFAULT_NEVER_TOUCH);
    // `fixScope` is the harness's own default, so a loggd that copies this
    // block keeps the doctor inside test files (felipearos/ralph#152).
    expect(CI_DOCTOR_BLOCK.fixScope).toEqual(DEFAULT_FIX_SCOPE);
    writeFileSync(path, JSON.stringify(config));
  });

  it("files it priority:urgent instead of reverting it", async () => {
    await repo.seed((store) => {
      store.cases[`regression:${REGRESSION}`] = {
        kind: "regression",
        state: "confirmed",
        rule: "red on 2 consecutive main builds",
        evidence: [
          { build: 2, branch: "main", commit: CULPRIT, kind: "timeout", line: `FAIL ${REGRESSION}` },
          { build: 3, branch: "main", commit: "0011223344", kind: "timeout", line: `FAIL ${REGRESSION}` },
        ],
        cost72h: { redBuilds: 2, mainReds: 2, dequeues: 0 },
        issue: null,
        pr: null,
        fixAttempts: 0,
        unparks: {},
        culprit: { commit: CULPRIT, build: 2, parentBuild: 1, pr: null, unambiguous: true, why: [] },
      };
    });
    repo.ghList([]);
    repo.ghNextIssue(1950);
    const before = repo.ghCalls().length;

    const run = repo.cli("ci-doctor/revert.ts", [
      "run",
      `regression:${REGRESSION}`,
      "--evidence",
      "main red on builds 2 and 3",
    ]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    // The refusal is quoted into the outcome, because a coder told only "not
    // reverted" would go looking for the wrong thing. What refuses is the
    // `ciDoctor.neverTouch` the test above DECLARED — `.github/workflows/**`,
    // which is not one of the harness default's entries.
    expect(run.stdout.trim()).toMatch(/^revert: filed-urgent: #\d+ carries the regression for the coders — /);
    expect(run.stdout).toContain(".github/workflows/ci.yml");
    // Parsed, not assumed: the number the next test ranks is the number this
    // subprocess filed, which is the whole of the seam between the doctor's
    // refusal and the coders' queue.
    urgent = Number(/filed-urgent: #(\d+)/.exec(run.stdout)![1]);
    expect(urgent).toBeGreaterThan(0);

    const calls = repo.ghCalls().slice(before);
    const created = calls.findIndex((c) => c.startsWith("issue create"));
    expect(created, `no issue create in ${calls.join(" | ")}`).toBeGreaterThanOrEqual(0);
    // Filed for the CODERS, so all three of their labels — unlike the doctor's
    // own case in AC 1, which carries `ci-health` alone.
    for (const label of ["--label ci-health", "--label ready-for-agent", "--label bug"]) {
      expect(calls[created]).toContain(label);
    }
    // `priority:urgent` is a SECOND write: `gh issue create` cannot apply a
    // label the create call does not carry, and this is the one label the
    // frontier's lane reads.
    expect(calls.slice(created + 1)).toContain(`issue edit ${urgent} --add-label priority:urgent`);
    // The labels the next test ranks on are taken from these two calls and
    // from nothing else, so a filing that stopped applying one of them would
    // change the ranking rather than leave the ranking passing on a literal.
    // Read off the END of the create argv, not scanned across the whole of it:
    // `case-issue.ts:361` passes the issue BODY inline before the labels, and
    // a body that ever contained the string `--label ` would otherwise be
    // scraped as one.
    const CREATE_LABELS = ["ci-health", "ready-for-agent", "bug"];
    const suffix = CREATE_LABELS.map((label) => `--label ${label}`).join(" ");
    expect(calls[created]!.endsWith(suffix), `create argv does not end in ${suffix}`).toBe(true);
    urgentLabels = [
      ...CREATE_LABELS,
      ...calls
        .slice(created + 1)
        .filter((call) => call.startsWith(`issue edit ${urgent} --add-label `))
        .map((call) => call.slice(`issue edit ${urgent} --add-label `.length)),
    ];
    expect(urgentLabels).toEqual([...CREATE_LABELS, "priority:urgent"]);
    // Recorded as handed off, or the gate re-offers the same regression on
    // every poll (`gate.ts:280-285`).
    const filed = repo.store().cases[`regression:${REGRESSION}`];
    expect(filed?.state).toBe("handed-off");
    expect(filed?.issue).toBe(1950);
    // And no revert pull request was opened for a culprit it may not touch.
    expect(calls.join(" | ")).not.toContain("pr create");
    expect(repo.store().reverts[CULPRIT]).toBeUndefined();
  });

  it("is the first ticket the frontier offers a coder", () => {
    // The real path a coder's `--take-one` walks: `roleUnits("coder", …)`,
    // which is `routeByDifficulty(takeOneCandidates(…))`
    // (`next-tasks.ts:2829`). `frontier/next.ts` is only a launcher — without
    // `--local` it re-executes `next-tasks.ts` out of `$RALPH_HOME`'s
    // `origin/main` (`next.ts:39-40`) — so asserting here is asserting on the
    // module the CLI runs.
    const issue = (number: number, title: string, body: string, labels: string[]): RawIssue => ({
      number,
      title,
      body,
      labels: labels.map((name) => ({ name })),
      assignees: [],
      author: { login: "felipearosr" },
      comments: [],
    });
    // Three competing groups, so the urgent lane is tested against every key
    // the frontier ranks by and not merely against issue number: #1200 frees
    // two dependents, #1210 has progress (its blocker #1199 is closed), and
    // the urgent one is the highest-numbered of the three and unblocks
    // nothing — it would come LAST on every other criterion.
    const raw = [
      issue(1200, "frees two", "## What to build\n\nStuff.\n", ["ready-for-agent"]),
      issue(1201, "waits on 1200", "## Blocked by\n\n- #1200\n", ["ready-for-agent"]),
      issue(1202, "waits on 1201", "## Blocked by\n\n- #1201\n", ["ready-for-agent"]),
      issue(1210, "has progress", "## Blocked by\n\n- #1199\n", ["ready-for-agent"]),
      // The filing, with the labels the subprocess actually applied.
      issue(urgent, "main red on the regression", "## What to build\n\nStuff.\n", urgentLabels),
    ];
    const tickets = buildTickets(raw, raw.map(() => []), new Set([1199]));
    const frontier = classify(tickets, [], {});
    const offered = (): number[] =>
      roleUnits("coder", tickets, frontier, { route: null }).flatMap((unit) =>
        unit.tickets.map((ticket) => ticket.number),
      );

    // Urgent first, then progress (#1210's blocker #1199 is closed), then
    // unblocking power (#1200 frees two) — the order `next-tasks.ts:996-1010`
    // documents. The urgent one has no progress, no power and the highest
    // number, so it leads on the lane alone.
    expect(offered()).toEqual([urgent, 1210, 1200]);

    // Without the label it comes last, so the lane is doing the work rather
    // than the issue number.
    const plain = raw.map((row) =>
      row.number === urgent ? { ...row, labels: [{ name: "ready-for-agent" }] } : row,
    );
    const plainTickets = buildTickets(plain, plain.map(() => []), new Set([1199]));
    expect(
      roleUnits("coder", plainTickets, classify(plainTickets, [], {}), { route: null }).flatMap((unit) =>
        unit.tickets.map((ticket) => ticket.number),
      ),
    ).toEqual([1210, 1200, urgent]);

    // And it survives Jav difficulty routing (felipearos/ralph#233). The filing
    // carries no difficulty label and cannot — `ci-doctor/revert.ts` applies
    // `ci-health`, `ready-for-agent`, `bug` and `priority:urgent`, and the
    // doctor has no way to know whether reverting a culprit is easy work — so
    // `routeByDifficulty` (`jav.ts`) exempts `priority:urgent` and `ci-health`
    // from the filter rather than dropping them. Without that exemption the
    // whole lane is the lane no coder is offered, while the ordinary backlog
    // proceeds.
    //
    // The fixture is that shape rather than an empty answer: the two routable
    // tickets are KEPT by their `difficulty:hard` label and the urgent filing is
    // kept by the exemption, in the same order the unrouted case offers.
    const routed = raw.map((row) =>
      row.number === urgent ? row : { ...row, labels: [...row.labels, { name: "difficulty:hard" }] },
    );
    const routedTickets = buildTickets(routed, routed.map(() => []), new Set([1199]));
    // `javLabels` as well as `route`, the production shape (`next-tasks.ts`'s
    // `main`): the configured list is what makes the exemption narrow, so
    // omitting it here would assert through a blanket exemption instead.
    expect(
      roleUnits("coder", routedTickets, classify(routedTickets, [], {}), {
        route: ["difficulty:hard"],
        javLabels: () => ["difficulty:easy", "difficulty:hard"],
      }).flatMap((unit) => unit.tickets.map((ticket) => ticket.number)),
    ).toEqual([urgent, 1210, 1200]);
  });

  it("drops the lane again once the regression retires", async () => {
    // The mirror of the filing, and the reason `retire` exists: an urgent
    // label nobody removes makes every later ticket wait behind a regression
    // that is over.
    //
    // Three conditions, all read off the store: main green, the case no longer
    // live, and the test's newest failure OLDER than the build that read main
    // green — "main is green" is not "green on this test".
    await repo.seed((store) => {
      store.main = { state: "green", since: "2026-10-06T09:30:00.000Z", build: 10 };
    });
    repo.ghLabels(urgent, { labels: [{ name: "priority:urgent" }, { name: "ci-health" }] });
    const before = repo.ghCalls().length;
    const run = repo.cli("ci-doctor/revert.ts", ["retire", `regression:${REGRESSION}`]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(repo.ghCalls().slice(before)).toContain(`issue edit ${urgent} --remove-label priority:urgent`);
  });
});
