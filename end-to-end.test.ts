// @vitest-environment node
/**
 * Ralph and Rafa, end to end (#705).
 *
 * Every other suite in `ralph/` proves one module. This one proves the seams
 * BETWEEN them, which is where the two-loop failures actually live: a lease
 * store both worktrees have to resolve to the same file, a durable record and
 * an Orca board (the Orca plugin, enabled here) fed by one `record()` call
 * that must never disagree, a
 * recovery command in one worktree that has to be refused in the other.
 *
 * So the fixture is a scratch **clone**, not a scratch worktree: two checkouts
 * — `ralph` and `rafa` — sharing one Git common directory, each with its own
 * `.ralph/loop-name`, `.ralph/logs/` and branch, driven through the REAL CLIs
 * with a fake `git` and a fake `orca` on PATH. Liveness is real too: a loop
 * that has to look alive gets an actual `bash …/ralph/ralph.sh` process in its
 * own worktree, because `loop-state.ts` reads `/proc` and a mock there would
 * test the mock.
 *
 * Nothing here touches this repository's Git metadata, GitHub, Orca, or the
 * operator's own `.ralph/logs/`.
 *
 * Two limits, stated so nothing here reads as more than it is. The
 * fresh-worktree cases below check that the README's checklist AGREES with the
 * mechanisms it documents — they do not execute it, because `preflight.ts`
 * anchors itself to its own checkout and cannot be pointed at a fixture. And
 * "concurrently" here means two loops sharing one clone with their writers
 * genuinely overlapping ("at the same moment", below); it does not mean a live
 * run against a real frontier, which `README.md` §Known gaps still owes.
 */
import { execFileSync, spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claimLease,
  leaseStatus,
  readLeaseStore,
  reconnectLease,
  writeLeaseStore,
  type ClaimLease,
  type LeaseStore,
} from "./claim-lease";
import { createAgentsAdapter } from "./dashboard/agents-adapter";
import { createProcessExecutor, createRalphControlAdapter } from "./dashboard/control-adapter";
import { writeProjectConfig } from "./dashboard/fixtures";
import { createRalphLifecycleAdapter } from "./dashboard/lifecycle-adapter";
import { notificationFeed } from "./dashboard/records";
import { createRecordsAdapter } from "./dashboard/records-adapter";
import { DEFAULT_RETRY_SCHEDULE_MINUTES, createReconcileAdapter, reconcile } from "./dashboard/reconcile";
import { STATE_RELATIVE_PATH, supervisorPidMatches, type LoopReport, type Snapshot } from "./loop-state";
import {
  ALLOWED_VERBS,
  FORBIDDEN_ARGS,
  ORCA_STATE_RELATIVE_PATH,
  parseAdapterState,
  type AdapterState,
} from "./plugins/orca/lifecycle";
import { CONTROL_STATE_RELATIVE_PATH, parseControlState, type ControlState } from "./controls";
import { CONTROL_VERBS } from "./plugins/orca/mailbox";
import {
  STAGES as MODEL_STAGES,
  envNameFor,
  runnerEnvNameFor,
} from "./models";
import { CLERK_DEFAULTS, parseProjectConfig, sentinelRules, verifierRules, type ClerkRules } from "./project-config";
import { ALLOWED_COMMANDS, ALLOWED_GIT_SUBCOMMANDS, attribute } from "./runner-failure";
import { subprocessSuite } from "./test-timeouts";
import { fixtureGitEnv } from "./test-git-env";
import {
  buildTickets,
  claimByNumber,
  classify,
  readKeyedFrontierInputs,
  readLiveIssue,
  readParks,
  takeOneCandidates,
  triageBuckets,
  useFrontierTracker,
} from "./frontier/next-tasks";
import { sweep } from "./park-probe";
import { listStore } from "./park-store";
import { fetchFromTracker, renderSpec } from "./issue-spec";
import { main as trackerCli, type CliDeps } from "./tracker";
import { createFakeTracker, type FakeTracker } from "./tracker/fake";
import { INTAKE_LABEL, RECEIVED_REPLY } from "./clerk/apply";
import { INTAKE_WORKFLOW, SITE, after, fakeJira, fakeSlack, APP_LABELS } from "./clerk/fakes";
import { noCache, poll, type PollDeps } from "./clerk/gate";
import { jiraClient } from "./clerk/jira";
import { summarise, type MetricsEvent } from "./clerk/metrics";
import { resolvedReply } from "./clerk/outcomes";
import { slackClient, tsMs } from "./clerk/slack";
import { readClerkStore } from "./clerk/store";
import { READY_FOR_AGENT_LABEL } from "./triage/intake";
import { FAKE_GH_BIN } from "./fake-gh";
import { buildTrial, disposeTrial, runTrial, trialEnv, trialPreflight } from "./trial-sandbox";
import { run as runCheckin } from "./verifier/checkin";
import type { Fetch as VerifierFetch } from "./verifier/credentials";
import { vercelLandedDeploy, type Gh as VerifierGh } from "./verifier/deploys";
import { poll as verifierPoll, type PollDeps as VerifierPollDeps } from "./verifier/gate";
import { readStore as readVerifierStore } from "./verifier/watches";
import { NOW, hoursAgo, seedBreadcrumb, seedEvents, seedFrame, seedIssue, seedOf } from "./reporter/contract";
import { createSentryReporter } from "./reporter/sentry";
import { sentryEmulator } from "./reporter/sentry-emulator";
import { poll as sentinelPoll, type PollDeps as SentinelPollDeps } from "./sentinel/gate";
import { run as runSentinelIssue } from "./sentinel/issue";
import { readStore as readSentinelStore } from "./sentinel/store";

subprocessSuite("runs ralph.sh and its bun CLIs end to end");

const REPO_ROOT = __dirname;

/** The bun running this suite, by absolute path — the fixtures replace PATH. */
const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const scratchRoots: string[] = [];
const supervisors: ChildProcess[] = [];

/**
 * Supervisors a real `start.sh` published, which this suite knows only by pid:
 * `start.sh` detaches them with `nohup setsid`, so there is no child handle.
 * (This suite runs with `RALPH_LOOP_SCOPE=off`, from `test-ralph-env.setup.ts`,
 * so it always takes that fallback path and never creates a systemd scope.)
 * The process GROUP is recorded beside the pid, and recorded while the leader
 * is still alive, because it cannot be derived from the pid afterwards.
 */
const supervisorsByPid: { pid: number; pgid: number | null }[] = [];

/**
 * Remember one published supervisor, with the group that will reap its
 * children.
 *
 * The pid `start.sh` publishes is NOT a group leader: its `nohup setsid`
 * wrapper calls `setsid()` and keeps its own pid, then forks the supervisor
 * inside that group, so the group is the WRAPPER's. `start.sh` signals
 * `-$wrapper` for exactly this reason. Two things follow, and both are why
 * the group is read here rather than negated at kill time: `kill(-pid)` is an
 * ESRCH no-op, so the supervisor's children survive; and once this suite has
 * killed the pid, the number is free, so a later `kill(-pid)` could signal
 * whatever group had taken it — on a host that also runs the live loops and
 * the CI runner.
 */
const rememberSupervisor = (pid: number): void => {
  let pgid: number | null = null;
  try {
    const read = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    // Never 0 or NaN: `kill(-0)` would signal this test runner's own group.
    pgid = Number.isInteger(read) && read > 1 ? read : null;
  } catch {
    /* already gone, or no ps */
  }
  supervisorsByPid.push({ pid, pgid });
};

/**
 * Kill every fixture supervisor.
 *
 * Wired to `afterAll` AND to this process exiting, because these are real
 * `bash …/ralph/ralph.sh` processes and their argv is exactly what the
 * operator's own `pkill -f 'ralph/ralph\.sh'` matches machine-wide. A vitest
 * killed between the spawn and `afterAll` would leave them for that command to
 * find; `afterAll` alone does not run on a hard kill.
 */
const reap = (): void => {
  while (supervisorsByPid.length > 0) {
    const entry = supervisorsByPid.pop();
    if (entry === undefined || !Number.isInteger(entry.pid) || entry.pid <= 1) continue;
    // The group first, which is one atomic kill of every generation — the
    // supervisor, its `nohup setsid` wrapper and the children it forked — so
    // nothing can fork between two signals and nothing is left orphaned and
    // detached. Then the pid itself, in case the group could not be read.
    if (entry.pgid !== null) {
      try {
        process.kill(-entry.pgid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  while (supervisors.length > 0) {
    try {
      supervisors.pop()?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", reap);

afterAll(() => {
  reap();
  scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const LOOPS = ["ralph", "rafa"] as const;
type Loop = (typeof LOOPS)[number];

interface Clone {
  root: string;
  /** The Git common directory both checkouts resolve — the fence between them. */
  common: string;
  worktree: (loop: Loop) => string;
  branch: (loop: Loop, name: string) => void;
  /** Add a worktree to what the fake `git worktree list` reports. */
  registry: (lines: string[]) => void;
  /** Every `orca` invocation from either worktree, one line of arguments each. */
  orcaCalls: () => string[];
  /** Fill the mailbox the next `orchestration check` returns. */
  mailbox: (messages: Record<string, unknown>[]) => void;
  leases: () => Record<string, ClaimLease>;
  writeLeases: (store: LeaseStore) => void;
  /** `ralph.sh`'s own `record()`: the durable record and the mirror, one call. */
  record: (loop: Loop, args: string[], env?: Record<string, string>) => void;
  loopState: (loop: Loop) => Record<string, unknown> | null;
  adapter: (loop: Loop) => AdapterState | null;
  controls: (loop: Loop) => ControlState | null;
  panel: (loop: Loop, env?: Record<string, string>) => Snapshot;
  /** Run one of the loop CLIs in a worktree, as the supervisor would. */
  cli: (
    loop: Loop,
    script: string,
    args: string[],
    env?: Record<string, string>,
  ) => SpawnSyncReturns<string>;
  /** A real `bash <home>/ralph.sh` with that worktree as cwd, so `/proc` says alive. */
  supervise: (loop: Loop) => ChildProcess;
  env: (loop: Loop) => Record<string, string>;
}

const runIdFor = (loop: Loop): string => `${loop}-run-1`;

function clone(label: string): Clone {
  const root = mkdtempSync(join(tmpdir(), `loggd-ralph-e2e-${label}-`));
  scratchRoots.push(root);
  const common = join(root, "gitcommon");
  mkdirSync(common, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);

  const callLog = join(root, "orca.calls");
  const mailboxFile = join(root, "mailbox.json");
  writeFileSync(mailboxFile, JSON.stringify({ ok: true, result: { messages: [] } }));
  const registryFile = join(root, "registry.txt");

  const paths: Record<Loop, string> = { ralph: "", rafa: "" };
  for (const loop of LOOPS) {
    const path = join(root, loop === "ralph" ? "loggd" : "loggd-rafa");
    mkdirSync(join(path, ".ralph", "logs"), { recursive: true });
    writeProjectConfig(path);
    writeFileSync(join(path, ".ralph", "loop-name"), `${loop}\n`);
    writeFileSync(join(path, "branch.txt"), "detached");
    paths[loop] = path;
  }
  writeFileSync(
    registryFile,
    LOOPS.flatMap((loop) => [`worktree ${paths[loop]}`, "HEAD abc1234", "detached", ""]).join("\n"),
  );

  // One `git` for both checkouts. Everything it answers is resolved from the
  // CALLER'S cwd, which is what makes one binary serve two worktrees: the
  // common directory is shared (the lease fence), the branch is not.
  const git = join(bin, "git");
  writeFileSync(
    git,
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "worktree list" ]; then',
      `  cat ${JSON.stringify(registryFile)}`,
      "  exit 0",
      "fi",
      'if [ "$2" = "--path-format=absolute" ]; then',
      `  printf '%s\\n' ${JSON.stringify(common)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "symbolic-ref" ]; then',
      '  branch=$(cat ./branch.txt 2>/dev/null || echo detached)',
      '  [ "$branch" = "detached" ] && exit 1',
      "  printf '%s\\n' \"$branch\"",
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "rev-parse --short" ]; then printf \'%s\\n\' "abc1234"; exit 0; fi',
      'if [ "$1 $2" = "rev-parse --show-toplevel" ]; then pwd; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(git, 0o755);

  // A tracker with no labels on anything: `release` and `abandon` look for the
  // claim label before taking it off, and must never reach the real `gh`.
  const gh = join(bin, "gh");
  writeFileSync(gh, ["#!/bin/sh", `[ "$2" = "view" ] && printf '{"labels":[]}\\n'`, "exit 0", ""].join("\n"));
  chmodSync(gh, 0o755);

  // The fake Orca, in the shape the real CLI answers in — `{ok, result}` — and
  // enforcing the one task rule the runtime enforces, so a second attempt on
  // one ticket is a different call sequence from the first.
  const statusFile = join(root, "task-status.txt");
  const orca = join(bin, "orca");
  writeFileSync(
    orca,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
      `status=$(cat ${JSON.stringify(statusFile)} 2>/dev/null || echo none)`,
      `set_status() { printf '%s' "$1" > ${JSON.stringify(statusFile)}; }`,
      'case "$1 $2" in',
      '  "orchestration run-current") printf \'{"ok":true,"result":{}}\\n\' ;;',
      '  "orchestration run-create") printf \'{"ok":true,"result":{"run":{"id":"run_%s"}}}\\n\' "${RALPH_LOOP_NAME:-x}" ;;',
      '  "orchestration task-create")',
      "    set_status ready",
      '    printf \'{"ok":true,"result":{"task":{"id":"task_%s"}}}\\n\' "${RALPH_LOOP_NAME:-x}" ;;',
      '  "orchestration dispatch")',
      '    if [ "$status" != "ready" ]; then',
      '      printf \'{"ok":false,"error":{"code":"runtime_error","message":"Task is %s; only ready tasks can be dispatched"}}\\n\' "$status"',
      "      exit 0",
      "    fi",
      "    set_status dispatched",
      '    printf \'{"ok":true,"result":{"dispatch":{"id":"ctx_%s"}}}\\n\' "${RALPH_LOOP_NAME:-x}" ;;',
      '  "orchestration worker-stop")',
      "    set_status blocked",
      '    printf \'{"ok":true,"result":{"state":"stopped","processAction":"none"}}\\n\' ;;',
      '  "orchestration task-update")',
      '    prev=""; for a in "$@"; do [ "$prev" = "--status" ] && set_status "$a"; prev="$a"; done',
      '    printf \'{"ok":true,"result":{}}\\n\' ;;',
      '  "orchestration check")',
      '    case "$*" in *--ack*)',
      `      printf '{"ok":true,"result":{"messages":[]}}\\n' > ${JSON.stringify(mailboxFile)}.next`,
      `      mv ${JSON.stringify(mailboxFile)}.next ${JSON.stringify(mailboxFile)}`,
      '      printf \'{"ok":true,"result":{"messages":[]}}\\n\'',
      "      exit 0 ;;",
      "    esac",
      `    cat ${JSON.stringify(mailboxFile)} ;;`,
      '  "orchestration gate-list") printf \'{"ok":true,"result":{"gates":[]}}\\n\' ;;',
      '  "orchestration send")',
      '    case "$*" in *"--type worker_done"*)',
      '      case "$*" in *"--outcome failed"*) set_status failed ;; *) set_status completed ;; esac ;;',
      "    esac",
      '    printf \'{"ok":true,"result":{}}\\n\' ;;',
      '  *) printf \'{"ok":true,"result":{}}\\n\' ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(orca, 0o755);

  const leasePath = join(common, "ralph-claim-leases.json");
  const environmentFor = (loop: Loop): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: paths[loop],
    RALPH_ORCA_CLI: orca,
    RALPH_LOOP_NAME: loop,
    RALPH_RUN_ID: runIdFor(loop),
    ORCA_TERMINAL_HANDLE: `term_${loop}`,
    RALPH_RUNNER_FAILURE_LOG: join(paths[loop], ".ralph", "logs", "runner-failures.jsonl"),
    // The board is the Orca plugin's, so it is on for these two loops.
    RALPH_PLUGINS: "orca",
  });

  const cli: Clone["cli"] = (loop, script, args, env = {}) =>
    spawnSync(BUN, [join(REPO_ROOT, script), ...args], {
      encoding: "utf8",
      cwd: paths[loop],
      env: { ...process.env, ...environmentFor(loop), ...env },
    });

  const readJson = (path: string): Record<string, unknown> | null =>
    existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;

  return {
    root,
    common,
    worktree: (loop) => paths[loop],
    branch: (loop, name) => writeFileSync(join(paths[loop], "branch.txt"), name),
    registry: (lines) => writeFileSync(registryFile, `${lines.join("\n")}\n`),
    orcaCalls: () =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
    mailbox: (messages) =>
      writeFileSync(
        mailboxFile,
        JSON.stringify({ ok: true, result: { messages, deliveryId: "delivery-1" } }),
      ),
    leases: () => (existsSync(leasePath) ? readLeaseStore(leasePath).leases : {}),
    writeLeases: (store) => writeLeaseStore(leasePath, store),
    record: (loop, args, env = {}) => {
      // Exactly `ralph.sh`'s `record()`: one set of flags, the durable record
      // first and then every enabled plugin through the host.
      cli(loop, "loop-state.ts", ["record", ...args], env);
      cli(loop, "plugins.ts", ["event", ...args], env);
    },
    loopState: (loop) => readJson(join(paths[loop], STATE_RELATIVE_PATH)),
    adapter: (loop) => {
      const path = join(paths[loop], ORCA_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseAdapterState(readFileSync(path, "utf8")) : null;
    },
    controls: (loop) => {
      const path = join(paths[loop], CONTROL_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseControlState(readFileSync(path, "utf8")) : null;
    },
    panel: (loop, env = {}) => {
      const run = cli(loop, "loop-state.ts", ["status", "--json"], env);
      expect(run.status, run.stderr).toBe(0);
      return JSON.parse(run.stdout) as Snapshot;
    },
    cli,
    supervise: (loop) => {
      // A REAL process, because `supervisorPidMatches` reads `/proc/<pid>/
      // cmdline` and `/proc/<pid>/cwd`: it must be `bash …/ralph/ralph.sh`
      // (never `-c`), and its cwd must be this worktree.
      //
      // It watches its STARTER and exits when that pid goes away, which is the
      // only reaping that survives the case worth reaping for. `afterAll` and
      // `process.on("exit")` both need this process to run some code; a vitest
      // worker killed with SIGKILL runs none, and what would be left behind is
      // an endless process whose argv is exactly what the operator's own
      // `pkill -f 'ralph/ralph\.sh'` matches machine-wide. Watching beats
      // `detached: false`, which only stops the child sharing a process group.
      //
      // The pid is an ordinary trailing argument, as `50` was: the liveness
      // check reads the SCRIPT PATH out of argv, and refuses only `-c`.
      // One script for every loop, outside both worktrees — as `~/ralph/ralph.sh`
      // is — so the cwd is the ONLY thing telling the two supervisors apart.
      mkdirSync(join(root, "home"), { recursive: true });
      const script = join(root, "home", "ralph.sh");
      writeFileSync(
        script,
        ["#!/bin/bash", 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done', ""].join("\n"),
      );
      chmodSync(script, 0o755);
      const child = spawn("bash", [script, String(process.pid)], {
        cwd: paths[loop],
        stdio: "ignore",
        detached: false,
      });
      supervisors.push(child);
      // Wait for the EXEC, not for a fixed interval: `/proc/<pid>/cmdline` is
      // `bash` until the kernel has replaced the image, and a sleep long
      // enough today is a flake on a loaded machine. Bounded, because a
      // supervisor that never appears must fail here rather than as a
      // mystifying `stale` three assertions later.
      const cmdline = join("/proc", String(child.pid), "cmdline");
      const deadline = Date.now() + 5_000;
      let seen = "";
      while (Date.now() < deadline) {
        try {
          seen = readFileSync(cmdline, "utf8");
        } catch {
          seen = "";
        }
        if (seen.includes("/ralph.sh")) return child;
        execFileSync("bash", ["-c", "sleep 0.02"]);
      }
      throw new Error(`the ${loop} fixture supervisor never reached /proc (${seen || "no cmdline"})`);
    },
    env: environmentFor,
  };
}

/** The row for one worktree out of the panel's JSON. */
const rowFor = (snap: Snapshot, worktree: string): LoopReport | undefined =>
  snap.loops.find((loop) => loop.worktree === resolve(worktree));

/** The machine line `ralph.sh` reads off the control channel: verdict, detail, why. */
const verdictOf = (run: SpawnSyncReturns<string>): string[] =>
  run.stdout.split("\n")[0]?.split("\t") ?? [];

/** The message an operator's `orchestration send --payload` produces. */
const mail = (
  control: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `msg_${String(control.command)}`,
  from_handle: "term_operator",
  sequence: 1,
  type: "status",
  payload: JSON.stringify({ control }),
  ...over,
});

const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

/**
 * One `##` section of the README, by title.
 *
 * Line-based and fence-aware rather than an `indexOf("\n## ")`, because the
 * second-loop checklist itself contains a fenced ```markdown block whose body
 * is a `## Staffing group` heading — scanning for the next `## ` cuts the
 * section in half there and every assertion below silently passes on a stub.
 */
function section(title: string): string {
  const lines = README.split("\n");
  const start = lines.findIndex((line) => line === `## ${title}`);
  expect(start, `README.md no longer has a \`## ${title}\` section`).toBeGreaterThan(-1);
  const body: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n");
}

/** The fresh-worktree checklist itself. */
const SECOND_LOOP_SECTION = section("Running a second loop");

/* --------------------------------------------------------------------------
 * AC 1 — a fresh worktree, set up from the README alone.
 * ----------------------------------------------------------------------- */

describe("setting a second loop up from the README alone", () => {
  it("names the baseline a loop starts from, and never a branch to check out", () => {
    // `ralph.sh` refuses a worktree strictly behind origin/main, and a second
    // checkout that took `main` breaks `git fetch` in EVERY worktree. Both are
    // properties of the baseline the checklist has to name.
    expect(SECOND_LOOP_SECTION).toContain("worktree add --detach");
    expect(SECOND_LOOP_SECTION).toContain("origin/main");
    expect(SECOND_LOOP_SECTION).toContain("git checkout --detach origin/main");
    expect(SECOND_LOOP_SECTION).toMatch(/[Nn]ever check `main` out/);
  });

  it("names the identity file, and a name the claim fence actually reads", () => {
    expect(SECOND_LOOP_SECTION).toContain(".ralph/loop-name");
    // The roster is the project's `loops`, read through `project-config`, and
    // the checklist's example name has to be in it — a checklist naming a loop
    // the fence refuses would fail at `preflight.ts loop-identity` with the doc
    // as the cause. Loggd's config is the project the checklist describes.
    const loggd = parseProjectConfig(readFileSync(join(REPO_ROOT, "fixtures", "loggd", ".ralph", "config.json"), "utf8"));
    expect(loggd.loops).toContain("rafa");
    expect(SECOND_LOOP_SECTION).toContain("echo rafa > .ralph/loop-name");
    // And it says where a new name goes before its first start.
    expect(SECOND_LOOP_SECTION).toContain("`loops`");
  });

  it("names every environment prerequisite the preflight would deny on", () => {
    // The checklist and `preflight.ts` are two statements of one list. These
    // are the checks whose remedy is an operator step in a fresh worktree.
    // `logs-writable` is among them only as the `mkdir -p` below: the
    // directory exists in a fresh checkout ONLY where the project tracks a
    // file inside `.ralph/logs`, and neither loggd nor this repo does — so
    // the step is listed and the check is not.
    expect(SECOND_LOOP_SECTION).toContain("mkdir -p .ralph/logs");
    expect(SECOND_LOOP_SECTION).toContain("gh label create rafa-wip");
    expect(SECOND_LOOP_SECTION).toContain("gh label create rafa-blocked");
    expect(SECOND_LOOP_SECTION).toContain("gh label create rafa-done");
    // The secrets scope is the project's config, named as such.
    expect(SECOND_LOOP_SECTION).toContain("secrets.project");
    expect(SECOND_LOOP_SECTION).toContain("bun install");
    expect(SECOND_LOOP_SECTION).toContain(".env.local");
    // And the mechanical check that catches whatever the prose missed.
    expect(SECOND_LOOP_SECTION).toContain("bun ~/ralph/preflight.ts");
    expect(SECOND_LOOP_SECTION).toContain("~/ralph/frontier-gate.ts --once");
    // Run from inside the project worktree, by the harness path.
    expect(SECOND_LOOP_SECTION).toContain("~/ralph/start.sh");
  });

  it("says where the loop will show up in Orca, and how to place it there", () => {
    // The mirror's failure mode is silence: a board with no loop on it cannot
    // distinguish "not mirrored" from "never started". A checklist that stops
    // at `start.sh` leaves an operator with no way to tell which they have.
    expect(SECOND_LOOP_SECTION).toContain("ORCA_TERMINAL_HANDLE");
    expect(SECOND_LOOP_SECTION).toContain("RALPH_PLUGINS=orca");
    expect(SECOND_LOOP_SECTION).toContain("plugins.ts status");
  });

  it("names no environment variable that nothing in the loop reads", () => {
    // Doc drift, mechanically: a README naming `RALPH_WAIT_FOR_SECONDS` is
    // worse than one that says nothing, because an operator will export it.
    //
    // Two things make this a real check rather than a grep. The TESTS are
    // excluded — `ralph/*.ts` includes `ralph/*.test.ts`, so a variable whose
    // last reader was deleted still appeared in the suite that used to cover
    // it, and the drift this exists to catch is exactly a name that survives
    // in prose after its reader is gone. And a bare substring is not a read:
    // the name has to appear in an ACCESS shape, so a mention in a comment or
    // a fixture string does not vouch for it.
    const sources = execFileSync(
      "bash",
      [
        "-c",
        // Every directory holding a module that reads one of these names has to
        // be listed. A knob read only from an unlisted directory reads as
        // undocumented-and-unread here, which is a false failure — and the
        // reverse, a name the README keeps after its reader moves, is the real
        // one this test exists for.
        "cat $(ls *.ts frontier/*.ts triage/*.ts clerk/*.ts plugins/*/*.ts | grep -v '\\.test\\.ts$') *.sh *.jsonc *.py",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );

    // COMMENTS ARE NOT CODE, and this file's sources are dense with them: every
    // variable here is discussed in prose right beside the line that reads it,
    // so a matcher that sees comments cannot tell a live reader from its own
    // documentation. Verified: commenting out
    // `seconds("RALPH_STALE_AFTER_SECONDS", …)` left the name in `loop-state.ts`
    // and the check went on passing.
    //
    // `//` is required to start a line or follow whitespace so `https://` keeps
    // its line, and `#` likewise for `"#705"`. Over-stripping is the safe error
    // in either direction: it can only drop a real read, which fails loudly
    // here rather than quietly vouching for a name nothing uses.
    const runtime = sources
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\s)\/\/.*$/gm, "$1")
      .replace(/(^|\s)#.*$/gm, "$1");

    // The per-stage overrides are GENERATED rather than written down —
    // `RALPH_MODEL_REVIEW_SPEC` appears nowhere in any source — so they are
    // resolved through the same functions the loop resolves them with. That
    // is stronger than exempting them: renaming a stage now breaks the README
    // line that names its variable.
    const generated = new Set(
      MODEL_STAGES.flatMap((stage) => [envNameFor(stage), runnerEnvNameFor(stage), `${envNameFor(stage)}_EFFORT`]),
    );

    /** Every way the loop's own sources actually READ one of these names. */
    const isRead = (name: string): boolean =>
      generated.has(name) ||
      [
        // TypeScript: `process.env.X`, `process.env["X"]`, and the `env.X` of
        // the modules that take an environment as a parameter.
        `process\\.env\\.${name}\\b`,
        `process\\.env\\[["']${name}["']\\]`,
        `\\benv\\.${name}\\b`,
        // A quoted literal in ARGUMENT position, handed to a reader that
        // indexes `process.env` itself — `seconds("RALPH_STALE_AFTER_SECONDS",
        // …)` and its kin. Anchored to `(` or `,` rather than left bare: an
        // unconstrained literal counts any leftover string as a read.
        `[(,]\\s*["']${name}["']`,
        // Shell: an expansion, or an assignment establishing the default.
        `\\$\\{?${name}\\b`,
        `^\\s*(?:export\\s+|readonly\\s+)?${name}=`,
        // opencode's own interpolation, and usage.py's reads.
        `\\{env:${name}\\}`,
        `environ(?:\\.get)?\\(\\s*["']${name}["']`,
      ].some((pattern) => new RegExp(pattern, "m").test(runtime));

    // `{{RALPH_HOWTO_<STAGE>}}` and friends are prompt-template placeholders
    // that `models.ts --render-prompt` fills, not variables an operator could
    // export. Stripped by their braces rather than exempted by name, so a new
    // placeholder needs no edit here.
    const prose = README.replace(/\{\{[^}]*\}\}/g, "");
    const named = new Set(prose.match(/\b(?:RALPH|ORCA)_[A-Z0-9_]+\b/g) ?? []);
    // `RALPH_LOOP_NAME`'s own documentation of the shape, not a variable.
    named.delete("RALPH_LOOP_NAME_FILE");
    const unread = [...named].filter((name) => !isRead(name));
    expect(unread, "README.md names variables nothing reads").toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * AC 2 — two loops, one clone, at the same time.
 * ----------------------------------------------------------------------- */

/**
 * One lease out of the store, or a failure that names what was missing.
 *
 * `store.leases[key]` is `ClaimLease | undefined` to the checker and
 * `ClaimLease` to the lint rule's own program, so a `!` here is required by
 * one and removed by the other — and lint-staged's `--fix` is what removes
 * it. A guard is the shape both agree on.
 */
function leaseFor(store: LeaseStore, issue: number): ClaimLease {
  const lease = store.leases[String(issue)];
  if (lease === undefined) throw new Error(`no claim lease for #${issue}`);
  return lease;
}

/**
 * Claim a ticket the way `next-tasks.ts` does: through the shared store.
 *
 * `pid` is the SUPERVISOR's, not this process's, wherever the test then pulses
 * a heartbeat: `renewLease` fences on run, loop and pid together, so a lease
 * claimed under the wrong pid is silently never renewed and the test reads as
 * a concurrency failure it is not.
 */
function claimFrom(
  c: Clone,
  loop: Loop,
  issue: number,
  { nowMs = Date.now(), pid = process.pid }: { nowMs?: number; pid?: number } = {},
): ReturnType<typeof claimLease> {
  const store: LeaseStore = { version: 1, leases: c.leases() };
  const result = claimLease(store, {
    issue,
    run: runIdFor(loop),
    loop,
    pid,
    host: "fedora",
    worktree: c.worktree(loop),
    branch: `${loop}/${issue}`,
    nowMs,
  });
  c.writeLeases(store);
  return result;
}

describe("two loops working one clone at the same time", () => {
  it("fences their claims through one store, whichever worktree asks", () => {
    // The property the whole two-loop design rests on: `leasePathFromGit`
    // resolves Git's COMMON directory, so the file ralph writes is the file
    // rafa reads. Asserted through the claim itself rather than by comparing
    // two paths — a shared path that both sides then ignored would pass that.
    const c = clone("shared-store");
    expect(claimFrom(c, "ralph", 705).outcome).toBe("claimed");

    const contested = claimFrom(c, "rafa", 705);
    expect(contested.outcome).toBe("held");
    expect(contested.lease.loop).toBe("ralph");
    expect(contested.lease.claim).toBe("ralph-wip");

    // And through `leasePathFromGit` from the OTHER worktree, which is the
    // resolution the fence actually depends on: rafa asking to take #705 back
    // is told who holds it, not that no such claim exists. Two per-worktree
    // stores would answer `already`, and every assertion above would still pass.
    c.mailbox([mail({ command: "abandon", issue: 705, why: "is ralph gone?" })]);
    expect(c.cli("rafa", "controls.ts", ["poll"]).status).toBe(0);
    const refusal = c.controls("rafa")?.applied.at(-1);
    expect(refusal?.outcome).toBe("refused");
    expect(refusal?.why).toContain("ralph@fedora");

    // And rafa is not blocked from the rest of the frontier by the collision.
    expect(claimFrom(c, "rafa", 706).outcome).toBe("claimed");
    expect(Object.keys(c.leases()).sort()).toEqual(["705", "706"]);
  });

  it("applies a plan usage stop override from either worktree, and reads each loop's own usage", () => {
    // The override lives in git's common directory, like the leases: rafa's
    // checkout setting a stop for ralph is the stop ralph's checkpoint reads.
    // The reading is the loop's own logs, so the same override parks the
    // loop that spent and leaves the one that did not alone.
    const c = clone("shared-usage-stop");
    const resetsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    const spent = (loop: Loop, utilization: number) =>
      writeFileSync(
        join(c.worktree(loop), ".ralph", "logs", "iter-1.events.jsonl"),
        `${JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", unifiedWindows: { seven_day: { utilization, resetsAt } } },
        })}\n`,
      );
    spent("ralph", 0.97);
    spent("rafa", 0.4);
    const verdict = (loop: Loop) => c.cli(loop, "usage-stop.ts", ["check", "--loop", loop]).stdout.split("\t")[0];
    expect(verdict("ralph")).toBe("run");

    expect(c.cli("rafa", "usage-stop.ts", ["set", "--loop", "*", "--percent", "80"]).status).toBe(0);
    expect(existsSync(join(c.common, "ralph-usage-stop.json"))).toBe(true);
    expect(verdict("ralph")).toBe("park");
    expect(verdict("rafa")).toBe("run");

    // A waiver taken in ralph's own checkout lets it run until the reset.
    expect(c.cli("ralph", "usage-stop.ts", ["waive", "--loop", "ralph"]).status).toBe(0);
    expect(verdict("ralph")).toBe("run");

    // And the supervisor's park reads as blocked on the panel, never failed.
    c.supervise("ralph");
    c.record("ralph", START);
    c.record("ralph", ["--event", "usage-stop", "--stage", "gate", "--detail", "seven_day 97% ≥ 95% — parked until Sun 15 11:02; at its hard threshold"]);
    expect(rowFor(c.panel("ralph"), c.worktree("ralph"))?.loopStatus).toBe("blocked");
  });

  it("puts both loops to sleep through one marker, whichever worktree took it", () => {
    // A project's sleep is git's common directory again: rafa's checkout
    // sleeping the project holds ralph's loop too, and either one waking it
    // lets both go on. Two per-worktree markers would hold only the loop that
    // took one, and the operator would be back to pausing loop by loop.
    const c = clone("shared-sleep");
    // The supervisor's own poll: only that one holds for a sleep.
    const verdictOf = (loop: Loop) => {
      const run = c.cli(loop, "controls.ts", ["poll", "--supervised"]);
      return [run.status, run.stdout.split("\n")[0]?.split("\t")[1]];
    };
    expect(verdictOf("ralph")).toEqual([0, "-"]);

    expect(c.cli("rafa", "project-sleep.ts", ["sleep", "--why", "bedtime", "--json"]).status).toBe(0);
    expect(verdictOf("ralph")).toEqual([10, "sleep"]);
    expect(verdictOf("rafa")).toEqual([10, "sleep"]);

    expect(c.cli("ralph", "project-sleep.ts", ["wake", "--json"]).status).toBe(0);
    expect(verdictOf("ralph")).toEqual([0, "-"]);
    expect(verdictOf("rafa")).toEqual([0, "-"]);
  });

  it("escalates one shared blocker once, through the store both worktrees resolve", () => {
    // No RALPH_BLOCKER_STORE: `blockerStorePath` has to find Git's common
    // directory from each worktree, as it does on the host. Two per-worktree
    // stores would each hold one waiter and never escalate. Blanked rather
    // than left out, so a loop running this suite cannot leak its own.
    const c = clone("shared-blocker");
    const key = "ci:buildkite/loggd:production-migrations";
    const pushes = join(c.root, "pushes.log");
    const pushCli = join(c.root, "push.ts");
    // One JSON line per invocation: the push body has newlines of its own.
    writeFileSync(
      pushCli,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pushes)}, JSON.stringify(process.argv.slice(2).join(" ")) + "\\n");\n`,
    );
    const lookup = join(c.root, "lookup.ts");
    writeFileSync(lookup, `console.log(JSON.stringify({ baseSha: "abc", baseFailing: true }));\n`);
    // The supervisor pid is pinned to this test process, alive, so neither
    // waiter is pruned before the other joins — `c.cli` spreads process.env,
    // and a loop running this suite has a RALPH_SUPERVISOR_PID of its own.
    const env = {
      RALPH_BLOCKER_STORE: "",
      RALPH_PUSH_CLI: pushCli,
      RALPH_BACKOFF_BASE_LOOKUP: lookup,
      RALPH_SUPERVISOR_PID: String(process.pid),
    };

    for (const loop of LOOPS) {
      writeFileSync(
        join(c.worktree(loop), "retry-blocker.json"),
        JSON.stringify({ key, summary: "prod migrations red" }),
      );
      const settled = c.cli(loop, "backoff.ts", ["settle", "--sigil", "retry-later", "--blocker-file", "retry-blocker.json"], env);
      expect(settled.status).toBe(0);
    }

    const store = JSON.parse(readFileSync(join(c.common, "ralph-blockers.json"), "utf8")) as {
      blockers: Record<string, { waiters: Record<string, unknown> }>;
    };
    expect(Object.keys(store.blockers[key]?.waiters ?? {}).sort()).toEqual(["rafa", "ralph"]);
    const lines = readFileSync(pushes, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--kind shared-blocker");
  });

  it("gives each loop its own ticket on the board, and never the other's", () => {
    // The mirror asks the SHARED store "what does THIS run hold?". Two loops
    // in it is exactly the case where a filter on run and loop earns its keep:
    // without it, whichever lease sorted first would become both boards' task.
    const c = clone("own-ticket");
    claimFrom(c, "ralph", 705);
    claimFrom(c, "rafa", 706);
    // Both worktrees stay DETACHED, which is the case the lease exists for:
    // `prompt.md` §7 detaches before the iteration returns, so a ticket taken
    // and finished in one iteration is on `<loop>/<issue>` at no instant the
    // supervisor looks. With a branch to fall back on, this test would pass
    // without the shared store being consulted at all.
    for (const loop of LOOPS) {
      c.record(loop, ["--event", "supervisor-start", "--stage", "starting"]);
      c.record(loop, ["--event", "iteration-start", "--stage", "iteration", "--iteration", "1", "--max", "50"]);
      c.record(loop, ["--event", "iteration-end", "--stage", "iteration", "--iteration", "1", "--max", "50"]);
    }

    expect(c.adapter("ralph")?.task?.issue).toBe(705);
    expect(c.adapter("rafa")?.task?.issue).toBe(706);
    expect(c.adapter("ralph")?.loop).toBe("ralph");
    expect(c.adapter("rafa")?.loop).toBe("rafa");
    expect(c.adapter("ralph")?.ralphRun).toBe("ralph-run-1");
    expect(c.adapter("rafa")?.ralphRun).toBe("rafa-run-1");
    // The terminal is the pane each supervisor was started from, and the two
    // are different panes — this is what an operator clicks on the board.
    expect(c.adapter("ralph")?.terminal).toBe("term_ralph");
    expect(c.adapter("rafa")?.terminal).toBe("term_rafa");
  });

  it("keeps each loop's durable record in its own worktree", () => {
    // `pgrep -f ralph/ralph.sh` is machine-wide, so with two loops running the
    // panel's whole job is to keep them apart. Both records exist, both are
    // read from either worktree, and neither is filed under the other's name.
    const c = clone("two-records");
    c.record("ralph", ["--event", "iteration-start", "--stage", "iteration", "--iteration", "3", "--max", "50"]);
    c.record("rafa", ["--event", "frontier-wait", "--stage", "gate"]);

    for (const from of LOOPS) {
      const snap = c.panel(from);
      const ralph = rowFor(snap, c.worktree("ralph"));
      const rafa = rowFor(snap, c.worktree("rafa"));
      expect(ralph?.state?.owner.loop, `read from ${from}`).toBe("ralph");
      expect(rafa?.state?.owner.loop, `read from ${from}`).toBe("rafa");
      expect(ralph?.state?.run).toBe("ralph-run-1");
      expect(rafa?.state?.run).toBe("rafa-run-1");
      expect(ralph?.stateProblem).toBeNull();
      expect(rafa?.stateProblem).toBeNull();
    }
  });

  it("reports only the loop that is actually running as running", () => {
    // Liveness is real here: one worktree gets a genuine `bash …/ralph.sh`,
    // the other does not. A panel that answered from `pgrep` alone would call
    // both of them running, which is the cross-attribution this fences.
    const c = clone("one-alive");
    c.supervise("ralph");
    for (const loop of LOOPS) {
      c.record(loop, ["--event", "iteration-start", "--stage", "iteration", "--iteration", "1", "--max", "50"]);
    }
    const snap = c.panel("rafa");
    expect(rowFor(snap, c.worktree("ralph"))?.loopStatus).toBe("running");
    expect(rowFor(snap, c.worktree("ralph"))?.supervisor).toBe("alive");
    expect(rowFor(snap, c.worktree("rafa"))?.loopStatus).toBe("stale");
    expect(rowFor(snap, c.worktree("rafa"))?.supervisor).toBe("dead");
  });

  it("will not write the shared store while another writer holds the lock", () => {
    // THE fence between two loops, and the only way to test it is to stop
    // racing for it. Spawning two pulses together does not make their critical
    // sections overlap — each is sub-millisecond and a `bun` start is a
    // hundred of them — so a race-based test passes whether or not the lock is
    // consulted at all. Verified: with `withLeaseStoreLock` reduced to
    // `critical()`, the ten-round race below still passed every assertion.
    //
    // So the collision is arranged rather than hoped for. The lock is held the
    // way a claim walk holds it — `next-tasks-claim.lock` in the Git common
    // directory — and the question is whether a pulse that finds it held
    // declines to write. Removing the lock check makes this fail immediately.
    const c = clone("lock-held");
    const supervisorPid = c.supervise("ralph").pid ?? 0;
    claimFrom(c, "ralph", 705, { pid: supervisorPid });
    const before = leaseFor({ version: 1, leases: c.leases() }, 705);

    const lock = join(c.common, "next-tasks-claim.lock");
    writeFileSync(lock, "");
    const blocked = c.cli("ralph", "claim-lease.ts", ["heartbeat"], {
      RALPH_SUPERVISOR_PID: String(supervisorPid),
      HOSTNAME: "fedora",
    });
    // Declined, not failed: the holder finishes in milliseconds and the lease
    // runs four heartbeats long, so a skipped pulse is the correct answer and
    // costs nothing. What it may not do is write anyway.
    expect(blocked.status, blocked.stderr).toBe(0);
    const during = leaseFor({ version: 1, leases: c.leases() }, 705);
    expect(during.heartbeatAt, "a pulse wrote while the claim lock was held").toBe(
      before.heartbeatAt,
    );
    expect(during.expiresAt).toBe(before.expiresAt);

    // And once the holder is gone it writes, so the assertion above is the
    // lock working rather than the pulse being broken in some other way.
    rmSync(lock, { force: true });
    const allowed = c.cli("ralph", "claim-lease.ts", ["heartbeat"], {
      RALPH_SUPERVISOR_PID: String(supervisorPid),
      HOSTNAME: "fedora",
    });
    expect(allowed.status, allowed.stderr).toBe(0);
    const after = leaseFor({ version: 1, leases: c.leases() }, 705);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    // The lock is released again rather than left for the next writer.
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps each loop's lease its own while both write the store at once", async () => {
    // The other half, and deliberately NOT a claim about the lock — see the
    // test above for why a race cannot make that claim. What the overlapping
    // writers do prove is that two loops pulsing one file leave it readable
    // and leave each other's leases alone: `writeLeaseStore` renames a temp
    // file into place, and `renewLease` fences on run, loop and pid together.
    const c = clone("simultaneous");
    const supervisor: Record<Loop, number> = { ralph: 0, rafa: 0 };
    for (const loop of LOOPS) supervisor[loop] = c.supervise(loop).pid ?? 0;
    claimFrom(c, "ralph", 705, { pid: supervisor.ralph });
    claimFrom(c, "rafa", 706, { pid: supervisor.rafa });
    const before = c.leases();

    // Ten rounds, because a lock collision is a millisecond-wide window and
    // one round would pass whether or not anything serialised the writers.
    //
    // The order ALTERNATES, and that is not tidiness. A pulse that finds
    // `next-tasks-claim.lock` held gives up rather than retrying — by design,
    // since a lease runs four heartbeats long and a skipped pulse costs
    // nothing — so two pulses spawned in a fixed order let the loop that
    // starts first win every race, and the other loop's lease is never
    // renewed at all. Alternating gives each loop the lead half the time,
    // which is what two supervisors on independent 30s timers get anyway.
    for (let round = 0; round < 10; round++) {
      const order = round % 2 === 0 ? LOOPS : [...LOOPS].reverse();
      await Promise.all(
        order.map(
          (loop) =>
            new Promise<void>((done) => {
              const child = spawn(
                BUN,
                [join(REPO_ROOT, "claim-lease.ts"), "heartbeat"],
                {
                  cwd: c.worktree(loop),
                  stdio: "ignore",
                  env: {
                    ...process.env,
                    ...c.env(loop),
                    RALPH_SUPERVISOR_PID: String(supervisor[loop]),
                    HOSTNAME: "fedora",
                  },
                },
              );
              child.on("exit", () => done());
            }),
        ),
      );
      // Readable after every round, never half-written: a torn store throws
      // out of `readLeaseStore`, which is what this loop is watching for.
      expect(Object.keys(c.leases()).sort()).toEqual(["705", "706"]);
    }

    const after = c.leases();
    // Each lease still belongs to the loop that claimed it, on the pid that
    // pulsed it. A pulse that renewed across loops would show up right here.
    expect(after["705"]?.loop).toBe("ralph");
    expect(after["705"]?.run).toBe("ralph-run-1");
    expect(after["705"]?.pid).toBe(supervisor.ralph);
    expect(after["706"]?.loop).toBe("rafa");
    expect(after["706"]?.run).toBe("rafa-run-1");
    expect(after["706"]?.pid).toBe(supervisor.rafa);
    // And both were genuinely renewed rather than merely left alone, so the
    // rounds above prove liveness and not just the absence of a crash.
    for (const issue of ["705", "706"] as const) {
      expect(
        Date.parse(after[issue]?.expiresAt ?? ""),
        `#${issue} was never renewed`,
      ).toBeGreaterThan(Date.parse(before[issue]?.expiresAt ?? ""));
    }
  });

  it("attributes a runner failure to the lease its own run holds", () => {
    // Two live leases in one store. `leaseForRun` filters by run, so ralph's
    // denial names ralph's ticket and owner — the failure is only actionable
    // if it says which loop paid for it and what it cost.
    const c = clone("attribution");
    claimFrom(c, "ralph", 705);
    claimFrom(c, "rafa", 706);
    const leasePath = join(c.common, "ralph-claim-leases.json");
    // In-process, the loop name is checked against the roster of the project
    // this process runs in — the clone, as it is for the supervisor.
    process.env.RALPH_PROJECT = c.worktree("ralph");
    try {
      const ralph = attribute(
        { stage: "executor", runner: "opencode", model: "opencode-go/ox" },
        { ...c.env("ralph"), RALPH_ITERATION: "3", RALPH_SESSION_ID: "session-ralph" },
        leasePath,
      );
      const rafa = attribute(
        { stage: "review.spec", runner: "codex", model: "gpt-5.6" },
        { ...c.env("rafa"), RALPH_ITERATION: "1", RALPH_SESSION_ID: "session-rafa" },
        leasePath,
      );

      expect(ralph).toMatchObject({ loop: "ralph", run: "ralph-run-1", issue: 705, owner: "ralph@fedora" });
      expect(rafa).toMatchObject({ loop: "rafa", run: "rafa-run-1", issue: 706, owner: "rafa@fedora" });
    } finally {
      delete process.env.RALPH_PROJECT;
    }
  });

  it("refuses one loop's recovery command in the other loop's worktree", () => {
    // A `stop` addressed to ralph's run, replayed into rafa's mailbox. Both
    // fences have to hold: rafa is not ralph, and rafa's run is not the run
    // the operator named. Stopping the wrong supervisor is the failure.
    const c = clone("cross-command");
    c.mailbox([mail({ command: "stop", loop: "ralph", run: "ralph-run-1", stop: "blocked", why: "needs triage" })]);
    const poll = c.cli("rafa", "controls.ts", ["poll", "--supervised"]);
    expect(poll.status, poll.stderr).toBe(0);
    expect(verdictOf(poll)[0]).toBe("continue");
    expect(c.controls("rafa")?.stop).toBeNull();
    // Refused for the right reason: the message REACHED rafa and was turned
    // away by the loop fence. A `continue` because the mailbox was empty would
    // assert nothing at all about the fence.
    expect(c.controls("rafa")?.applied.at(-1)).toMatchObject({
      command: "stop",
      outcome: "not-for-this-loop",
    });

    // And the same command in ralph's own worktree is obeyed, so the refusal
    // above is the fence working rather than the channel being broken.
    c.mailbox([mail({ command: "stop", loop: "ralph", run: "ralph-run-1", stop: "blocked", why: "needs triage" })]);
    const mine = c.cli("ralph", "controls.ts", ["poll", "--supervised"]);
    expect(verdictOf(mine)[0]).toBe("stop");
    expect(c.controls("ralph")?.stop?.kind).toBe("blocked");
  });
});

/* --------------------------------------------------------------------------
 * AC 3 — the CLI panel and the Orca board, on the same events.
 * ----------------------------------------------------------------------- */

/**
 * One `record()` sequence, and what each side of it has to say afterwards.
 *
 * The two readers are fed by ONE call site in `ralph.sh`, so agreement is not
 * a coincidence to be checked once — it is the invariant that call site exists
 * for, and the way it breaks is a status word added to one roster and not the
 * other.
 *
 * Both sides are read three ways, because a settlement, a board and a panel
 * are three different questions: `boardSays` / `boardNever` match the `orca`
 * ARGUMENT LOG, which is the only place a settlement is observable; `board`
 * matches the mirror's own one-line panel, which is what an operator reads
 * beside the CLI's; and `holdsTicket` says whether the board should still be
 * showing a ticket at all — the discriminator that stops "idle" and "running"
 * from being satisfied by the same evidence.
 */
interface StateCase {
  status: string;
  alive: boolean;
  /** Held on a ticket at the end — the branch still names it. */
  onTicket: boolean;
  /** Whether a claim lease exists at all: an idle loop holds no ticket. */
  holdsTicket: boolean;
  events: string[][];
  boardSays: RegExp[];
  boardNever: RegExp[];
  /**
   * The mirror's whole one-line panel, exactly — everything after
   * `Orca lifecycle: `. Exact rather than a `toMatch`, because what
   * distinguishes these states on the board is which parts are ABSENT: an
   * open attempt separates `running` from `blocked`, and no task at all
   * separates `idle` from both. A loose regex passes on all three.
   */
  board: string;
}

const START = ["--event", "supervisor-start", "--stage", "starting"];
const ITER = (i: number): string[] => [
  "--event", "iteration-start", "--stage", "iteration", "--iteration", String(i), "--max", "50",
];
const ITER_END = (i: number): string[] => [
  "--event", "iteration-end", "--stage", "iteration", "--iteration", String(i), "--max", "50", "--detail", ".ralph/logs/iter-1.log",
];

const STATE_CASES: StateCase[] = [
  {
    status: "running",
    alive: true,
    onTicket: true,
    holdsTicket: true,
    events: [START, ITER(1)],
    boardSays: [/orchestration task-create/, /orchestration run-create/],
    boardNever: [/--type worker_done/],
    board: "run run_ralph, task task_ralph (#705), attempt 1 ctx_ralph, terminal term_ralph",
  },
  {
    status: "idle",
    alive: true,
    onTicket: false,
    // No lease and no branch: a loop waiting on an empty frontier holds no
    // ticket, and that absence is the whole difference from `running`. With a
    // ticket, `run-create` alone is evidence both states produce.
    holdsTicket: false,
    events: [START, ["--event", "frontier-wait", "--stage", "gate"]],
    boardSays: [/orchestration run-create/],
    boardNever: [/--type worker_done/, /orchestration task-create/, /orchestration dispatch/],
    board: "run run_ralph, terminal term_ralph",
  },
  {
    status: "blocked",
    alive: true,
    onTicket: true,
    holdsTicket: true,
    events: [START, ITER(1), ITER_END(1), ["--event", "blocked-wait", "--stage", "gate", "--detail", "everything is blocked"]],
    // The attempt is over and the ticket is not: fenced, and handed back ready
    // so the next attempt on it can be opened at all.
    boardSays: [/orchestration worker-stop/, /task-update .*--status ready/],
    boardNever: [/--outcome succeeded/, /--outcome failed/],
    board: "run run_ralph, task task_ralph (#705), terminal term_ralph",
  },
  {
    status: "blocked",
    alive: true,
    onTicket: true,
    holdsTicket: true,
    events: [START, ITER(1), ITER_END(1), ["--event", "control-hold", "--stage", "paused", "--detail", "pause: held from Orca"]],
    boardSays: [/orchestration worker-stop/],
    boardNever: [/--outcome succeeded/, /--outcome failed/],
    board: "run run_ralph, task task_ralph (#705), terminal term_ralph",
  },
  {
    status: "blocked",
    alive: true,
    onTicket: true,
    holdsTicket: true,
    // Waiting out the account's usage limit (#407): parked on its ticket like
    // a blocked wait, and never read as the failure it used to stop as.
    events: [START, ITER(1), ITER_END(1), ["--event", "usage-wait", "--stage", "gate", "--detail", "waiting for usage reset until 22:32 (five_hour, event)"]],
    boardSays: [/orchestration worker-stop/, /task-update .*--status ready/],
    boardNever: [/--outcome succeeded/, /--outcome failed/],
    board: "run run_ralph, task task_ralph (#705), terminal term_ralph",
  },
  {
    status: "completed",
    alive: false,
    onTicket: false,
    holdsTicket: true,
    events: [START, ITER(1), ITER_END(1), ["--event", "frontier-empty", "--stop", "completed", "--why", "the backlog is drained"]],
    boardSays: [/--type worker_done/, /--outcome succeeded/],
    boardNever: [/--outcome failed/],
    // `worker_done` settles the dispatch and the task together, so the ticket
    // leaves the board with the attempt that reported it.
    board: "run run_ralph, terminal term_ralph",
  },
  {
    status: "failed",
    alive: false,
    onTicket: true,
    holdsTicket: true,
    events: [START, ITER(1), ITER_END(1), ["--event", "no-sigil", "--stop", "failed", "--detail", ".ralph/logs/iter-1.log", "--why", "iteration 1 ended without a sigil"]],
    boardSays: [/--type worker_done/, /--outcome failed/],
    boardNever: [/--outcome succeeded/],
    board: "run run_ralph, terminal term_ralph",
  },
  {
    status: "completed",
    alive: false,
    onTicket: true,
    holdsTicket: true,
    // The cap running out mid-ticket. The loop is DONE, the ticket is not, and
    // `worker_done` has no word for that — so the task is marked blocked.
    events: [START, ITER(1), ITER_END(1), ["--event", "cap-reached", "--stop", "completed", "--why", "iteration cap (50) reached"]],
    boardSays: [/task-update .*--status blocked/],
    boardNever: [/--outcome succeeded/],
    // Kept, unlike the two endings above: the loop stopped ON the ticket.
    board: "run run_ralph, task task_ralph (#705), terminal term_ralph",
  },
  {
    status: "stale",
    alive: false,
    onTicket: true,
    holdsTicket: true,
    // A closed terminal, a reboot, a `kill -9`: a record with no ending and no
    // supervisor. Nothing may claim an outcome for the attempt it left open.
    events: [START, ITER(1)],
    boardSays: [/orchestration task-create/],
    boardNever: [/--type worker_done/, /orchestration worker-stop/],
    // Still open, which is the honest board for a loop nobody settled.
    board: "run run_ralph, task task_ralph (#705), attempt 1 ctx_ralph, terminal term_ralph",
  },
];

describe("the panel and the board, on one record() call", () => {
  for (const testCase of STATE_CASES) {
    const label = `${testCase.status} (${testCase.events.at(-1)?.[1] ?? "?"})`;
    it(`agrees that a loop is ${label}`, () => {
      const c = clone(`agree-${testCase.status}-${testCase.events.at(-1)?.[1] ?? "x"}`);
      if (testCase.holdsTicket) {
        claimFrom(c, "ralph", 705);
        c.branch("ralph", "ralph/705");
      }
      if (testCase.alive) c.supervise("ralph");
      for (const [index, event] of testCase.events.entries()) {
        // A loop that finished its ticket detaches BEFORE the ending is
        // recorded — `prompt.md` §7 runs `git switch --detach origin/main` at
        // the end of the iteration — and the mirror samples the branch on
        // every event. So the detach belongs in front of the last one, not
        // after the sequence.
        if (!testCase.onTicket && index === testCase.events.length - 1) {
          c.branch("ralph", "detached");
        }
        c.record("ralph", event);
      }

      const row = rowFor(c.panel("ralph"), c.worktree("ralph"));
      expect(row?.loopStatus, `panel for ${label}`).toBe(testCase.status);

      // The board's own line, beside the panel's word — the two panels an
      // operator actually has in front of them. `status` must never fail, and
      // must never be showing a ticket the panel says the loop does not hold.
      const board = c.cli("ralph", "plugins/orca/lifecycle.ts", ["status"]);
      expect(board.status, `orca-lifecycle status for ${label}`).toBe(0);
      expect(board.stdout.trim(), `board for ${label}`).toBe(
        `Orca lifecycle: ${testCase.board}`,
      );

      const calls = c.orcaCalls().join("\n");
      for (const says of testCase.boardSays) {
        expect(calls, `board for ${label} never made ${String(says)}`).toMatch(says);
      }
      for (const never of testCase.boardNever) {
        expect(calls, `board for ${label} made ${String(never)}`).not.toMatch(never);
      }
      // Whatever the state, the mirror never places a process where the loop's
      // own fences decide what a runner may do.
      expect(calls).not.toMatch(/worker-start|--inject|terminal send/);
    });
  }

  it("agrees that an operator's stop is a blocked loop, not a finished one", () => {
    // The seventh state, and the only one that starts outside the loop:
    // `orca-controls.ts` records the stop, `ralph.sh` carries it out, and the
    // panel has to read it as blocked — claimed, unworked, waiting for a human.
    const c = clone("agree-stopped");
    claimFrom(c, "ralph", 705);
    c.branch("ralph", "ralph/705");
    c.record("ralph", START);
    c.record("ralph", ITER(1));
    c.record("ralph", ITER_END(1));

    c.mailbox([mail({ command: "stop", stop: "blocked", why: "needs triage" })]);
    const poll = c.cli("ralph", "controls.ts", ["poll", "--supervised"]);
    const verdict = verdictOf(poll);
    expect(verdict[0]).toBe("stop");
    expect(verdict[1]).toBe("blocked");
    expect(c.controls("ralph")?.stop?.confirmation).toBe("confirmed");

    // The supervisor then records that stop through the same call site.
    c.record("ralph", ["--event", "control-stop", "--stop", "blocked", "--why", "needs triage"]);
    expect(rowFor(c.panel("ralph"), c.worktree("ralph"))?.loopStatus).toBe("blocked");
    const calls = c.orcaCalls().join("\n");
    expect(calls).toMatch(/task-update .*--status blocked/);
    expect(calls).not.toMatch(/--outcome succeeded/);
  });

  it("agrees that a loop resumed after the usage limit reset is running its ticket again", () => {
    const c = clone("agree-usage-reset");
    claimFrom(c, "ralph", 705);
    c.branch("ralph", "ralph/705");
    c.supervise("ralph");
    c.record("ralph", START);
    c.record("ralph", ITER(1));
    c.record("ralph", ITER_END(1));
    c.record("ralph", ["--event", "usage-wait", "--stage", "gate", "--detail", "waiting for usage reset until 22:32 (five_hour, event)"]);
    c.record("ralph", ["--event", "usage-reset", "--stage", "gate"]);
    c.record("ralph", ITER(2));

    const row = rowFor(c.panel("ralph"), c.worktree("ralph"));
    expect(row?.loopStatus).toBe("running");
    const board = c.cli("ralph", "plugins/orca/lifecycle.ts", ["status"]);
    expect(board.status).toBe(0);
    expect(board.stdout.trim()).toContain("task task_ralph (#705)");
    expect(c.orcaCalls().join("\n")).not.toMatch(/--outcome failed/);
  });
});

/* --------------------------------------------------------------------------
 * AC 4 — the scenarios an operator meets after something went wrong.
 * ----------------------------------------------------------------------- */

describe("recovering a loop, end to end", () => {
  it("hands an expired claim to the other loop, and never a live one", () => {
    // The whole point of a lease: ralph dies on #705 and nothing else may take
    // it until the lease expires — not even an operator with a command. After
    // expiry, `abandon` clears it and rafa's own claim then succeeds.
    const c = clone("stale-claim");
    const inTenMinutes = new Date(Date.now() + 10 * 60_000).toISOString();
    claimFrom(c, "ralph", 705);
    let store: LeaseStore = { version: 1, leases: c.leases() };
    // Dead: a pid nothing holds. A lease whose supervisor still runs on this
    // host is held past its expiry too (#119), and this runner is alive.
    store.leases["705"] = { ...leaseFor(store, 705), run: "ralph-run-0", pid: 2 ** 22, expiresAt: inTenMinutes };
    c.writeLeases(store);

    c.mailbox([mail({ command: "abandon", issue: 705, why: "I think it is dead" })]);
    expect(c.cli("ralph", "controls.ts", ["poll"]).status).toBe(0);
    expect(Object.keys(c.leases()), "an unexpired lease was reclaimed").toEqual(["705"]);
    expect(c.controls("ralph")?.applied.at(-1)).toMatchObject({ outcome: "refused" });
    expect(claimFrom(c, "rafa", 705).outcome).toBe("held");

    // Now let it expire. The lease store is the same file rafa reads, so the
    // recovery is visible to the loop that needs it without any handshake.
    store = { version: 1, leases: c.leases() };
    store.leases["705"] = { ...leaseFor(store, 705), expiresAt: "2020-01-01T00:00:00.000Z" };
    c.writeLeases(store);
    c.mailbox([mail({ command: "abandon", issue: 705, why: "the host is gone", id: "abandon-2" })]);
    expect(c.cli("ralph", "controls.ts", ["poll"]).status).toBe(0);
    expect(Object.keys(c.leases())).toEqual([]);
    expect(c.controls("ralph")?.abandoned.at(-1)).toMatchObject({ issue: 705, run: "ralph-run-0" });

    const taken = claimFrom(c, "rafa", 705);
    expect(taken.outcome).toBe("claimed");
    expect(taken.lease.claim).toBe("rafa-wip");
  });

  it("never reports a prunable or orphaned worktree as a loop at work", () => {
    // `git worktree list` is a registry, not an observation. Both failures
    // look identical in it, and a record left inside says "iteration 3 of 50,
    // heartbeat a minute ago" the whole time.
    const c = clone("prunable");
    c.record("rafa", ["--event", "iteration-start", "--stage", "iteration", "--iteration", "3", "--max", "50"]);
    const gone = join(c.root, "loggd-deleted");
    c.registry([
      `worktree ${c.worktree("ralph")}`,
      "HEAD abc1234",
      "detached",
      "",
      `worktree ${c.worktree("rafa")}`,
      "HEAD def5678",
      "detached",
      "prunable gitdir file points to non-existent location",
      "",
      `worktree ${gone}`,
      "HEAD 0123456",
      "detached",
      "",
    ]);

    const snap = c.panel("ralph");
    const rafa = rowFor(snap, c.worktree("rafa"));
    expect(rafa?.worktreeStatus).toBe("prunable");
    expect(rafa?.loopStatus).not.toBe("running");
    expect(rowFor(snap, gone)?.worktreeStatus).toBe("orphaned");
    expect(rowFor(snap, gone)?.loopStatus).toBe("orphaned");
    expect(snap.reconciliation.prunable).toContain(c.worktree("rafa"));
    expect(snap.reconciliation.orphaned).toContain(gone);
  });

  it("degrades the board when the loop lost its terminal, and leaves the loop alone", () => {
    // A supervisor started from a shell that never had `ORCA_TERMINAL_HANDLE`
    // — a reboot, a `nohup` from a plain pane — has nothing to address. That
    // is a recorded reason and exit 0, never a loop that stops.
    const c = clone("no-terminal");
    const run = c.cli("ralph", "plugins/orca/lifecycle.ts", ["record", ...START], {
      ORCA_TERMINAL_HANDLE: "",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(c.adapter("ralph")?.degraded?.why).toBeTruthy();
    expect(c.orcaCalls()).toEqual([]);

    const line = c.cli("ralph", "plugins/orca/lifecycle.ts", ["status"], { ORCA_TERMINAL_HANDLE: "" });
    expect(line.status).toBe(0);
    expect(line.stdout).toContain("degraded");

    // And the durable record — the panel that does not need Orca at all — is
    // untouched by any of it.
    c.record("ralph", ITER(1), { ORCA_TERMINAL_HANDLE: "" });
    expect(c.loopState("ralph")).toMatchObject({ run: "ralph-run-1", stage: "iteration" });
  });

  it("lets a restarted supervisor reconnect to its own claim rather than lose it", () => {
    // `nohup` survives a closed terminal, not a reboot. The lease outlives
    // both — it is in Git's common directory — so the loop that comes back in
    // the same worktree takes its claim over instead of starting an attempt.
    const c = clone("reconnect");
    const claimedAt = Date.now() - 60_000;
    claimFrom(c, "ralph", 705, { nowMs: claimedAt });
    const store: LeaseStore = { version: 1, leases: c.leases() };
    // The owner is gone: a pid nothing holds, a heartbeat inside the grace.
    const orphan: ClaimLease = {
      ...leaseFor(store, 705),
      pid: 2 ** 22,
      heartbeatAt: new Date(Date.now() - 5_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    store.leases["705"] = orphan;
    expect(leaseStatus(orphan, { nowMs: Date.now() })).toBe("reconnecting");

    const before = orphan.attempt;
    c.writeLeases(store);
    c.branch("ralph", "ralph/705");

    // Through the pulse the supervisor actually runs — `claim-lease.ts
    // heartbeat` — rather than by calling `reconnectLease` here. The unit
    // suite already owns the function; what is unproven is that the CLI
    // reaches this store, resolves this worktree from `git`, and takes the
    // lease over when the restarted supervisor pulses.
    const supervisor = c.supervise("ralph");
    const pulse = c.cli("ralph", "claim-lease.ts", ["heartbeat"], {
      RALPH_RUN_ID: "ralph-run-2",
      RALPH_SUPERVISOR_PID: String(supervisor.pid),
      HOSTNAME: "fedora",
    });
    expect(pulse.status, pulse.stderr).toBe(0);

    const after = leaseFor({ version: 1, leases: c.leases() }, 705);
    // A reconnect is not a new attempt: the predecessor's provenance is kept
    // and the attempt counter does not move, so it still counts real rescues.
    expect(after.attempt).toBe(before);
    expect(after.run).toBe("ralph-run-2");
    expect(after.pid).toBe(supervisor.pid);
    expect(after.reconnects).toHaveLength(1);
    expect(after.reconnects?.[0]?.run).toBe("ralph-run-1");

    // And a reconnect from the OTHER worktree is not a reconnect at all: the
    // lease names a checkout, and a different one has to wait out the expiry
    // like anybody else.
    expect(
      reconnectLease({ version: 1, leases: c.leases() }, 705, {
        run: "rafa-run-2", loop: "rafa", pid: process.pid, host: "fedora",
        worktree: c.worktree("rafa"), branch: "rafa/705",
      }, Date.now()),
    ).toBeNull();
  });

  it("clears a failed run's stop so the next start.sh runs instead of exiting", () => {
    // Retry starts nothing — launching a runner is the capability this channel
    // refuses. What it does is clear the way: the linked attempt is opened,
    // the predecessor's evidence is copied, and the stop is dropped.
    // The event replayed below is the one `ralph.sh` actually emits, log path
    // and all. That the supervisor emits it is asserted where the supervisor
    // is driven — `ralph.test.ts`, "separates a loop that broke from one that
    // ran out of work" — rather than by grepping its source here, which would
    // fail a reformatting and prove nothing about what it writes.
    const c = clone("retry");
    claimFrom(c, "ralph", 705);
    c.branch("ralph", "ralph/705");
    c.record("ralph", START);
    c.record("ralph", ITER(1));
    c.record("ralph", ITER_END(1));
    c.record("ralph", [
      "--event", "no-sigil", "--stop", "failed", "--detail", ".ralph/logs/iter-1.log",
      "--why", "iteration 1 ended without a sigil",
    ]);
    expect(rowFor(c.panel("ralph"), c.worktree("ralph"))?.loopStatus).toBe("failed");

    c.mailbox([mail({ command: "stop", stop: "failed", why: "iteration 1 ended without a sigil" })]);
    expect(c.cli("ralph", "controls.ts", ["poll", "--supervised"]).status).toBe(20);
    expect(c.controls("ralph")?.stop?.kind).toBe("failed");

    c.mailbox([mail({ command: "retry", why: "the denial is fixed" })]);
    const retried = c.cli("ralph", "controls.ts", ["poll"]);
    expect(retried.status, retried.stderr).toBe(0);
    expect(c.controls("ralph")?.stop, "the retry left the stop in place").toBeNull();
    const link = c.controls("ralph")?.retries.at(-1);
    expect(link?.attempt).toBe("ralph-run-1/attempt-2");
    expect(link?.predecessor).toBe("ralph-run-1/attempt-1");
    // Copied, not referenced: a day later the log is rotated and the dispatch
    // is settled, so a link that only NAMED them would name nothing.
    expect(link?.evidence).toMatchObject({
      iteration: 1,
      log: ".ralph/logs/iter-1.log",
      outcome: "failed",
      why: "iteration 1 ended without a sigil",
    });

    // The next supervisor's first checkpoint therefore continues.
    c.mailbox([]);
    const next = c.cli("ralph", "controls.ts", ["poll", "--supervised"]);
    expect(next.status).toBe(0);
    expect(verdictOf(next)[0]).toBe("continue");
  });

  it("costs the loop nothing when Orca is not there at all", () => {
    // No CLI: the mirror records a reason and the channel answers continue.
    // Both exit 0, because neither may hold, stop or fail a loop by accident.
    const c = clone("no-orca");
    const missing = join(c.root, "no-such-orca");

    const mirrored = c.cli("ralph", "plugins/orca/lifecycle.ts", ["record", ...START], {
      RALPH_ORCA_CLI: missing,
    });
    expect(mirrored.status, mirrored.stderr).toBe(0);
    expect(c.adapter("ralph")?.degraded?.why).toBeTruthy();

    const controlled = c.cli("ralph", "controls.ts", ["poll", "--supervised"], {
      RALPH_ORCA_CLI: missing,
    });
    expect(controlled.status).toBe(0);
    expect(verdictOf(controlled)[0]).toBe("continue");
    // The reason is the plugin's health, not the loop's record.
    const health = JSON.parse(readFileSync(join(c.worktree("ralph"), ".ralph", "logs", "plugins.json"), "utf8"));
    expect(health.plugins.orca.degraded?.why).toBeTruthy();
    expect(JSON.stringify(c.controls("ralph"))).not.toContain("Orca");

    // Switched off deliberately is the same answer, and says which it is.
    const off = c.cli("ralph", "plugins.ts", ["status", "--line"], { RALPH_ORCA_CONTROLS: "0" });
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("Orca route off");
  });
});

/* --------------------------------------------------------------------------
 * AC 5 — the fences the two-loop work had to leave exactly where they were.
 *
 * Every rail below is already proven by the suite that owns it. What is NOT
 * proven anywhere else is that adding a second loop, a board and a control
 * channel left them intact: each of those is a new way for a runner to be
 * reached, and the whole safety case for them is that none of them is one.
 * So this is an inventory, deliberately shallow and deliberately here.
 * ----------------------------------------------------------------------- */

const readRepo = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), "utf8");

describe("the fences a second loop must not have loosened", () => {
  it("keeps the executor away from history, GitHub, the database and CI", () => {
    const rails = readRepo("opencode-executor.jsonc");
    // Everything below is asserted against the `bash` block alone, so the
    // prose above it (which quotes the patterns it warns about) cannot make an
    // assertion pass or fail by accident.
    const bash = rails.slice(rails.indexOf('"bash": {'));
    for (const denied of [
      '"*git commit*": "deny"',
      '"*git push*": "deny"',
      '"*gh *": "deny"',
      '"*psql*": "deny"',
      '"*supabase*": "deny"',
    ]) {
      expect(rails, `opencode-executor.jsonc no longer denies ${denied}`).toContain(denied);
    }
    // A prefix-anchored rail is not a rail: the matcher globs the whole command
    // string and does not look inside `&&`/`;` chains, so a `"git commit*"`-style
    // prefix let `true && git commit` through. The verb must be wrapped in `*…*`.
    for (const unanchored of ['"git commit*"', '"git push*"', '"gh *"']) {
      expect(bash, `opencode-executor.jsonc still has the chainable rail ${unanchored}`).not.toContain(
        unanchored,
      );
    }
    // Order is the rail: last match wins, so the catch-all must come FIRST.
    // With it last it silently overrode every deny above and a probe made a
    // real commit. Both indices are checked for presence before they are
    // compared — `indexOf` answers -1 for a string that is GONE, and -1 is
    // less than every real index, so the ordering alone passes on a file that
    // no longer has the thing being ordered.
    const catchAll = bash.indexOf('"*": "allow"');
    const firstDeny = bash.indexOf('"*git commit*": "deny"');
    expect(catchAll, "opencode-executor.jsonc has no bash catch-all any more").toBeGreaterThan(-1);
    expect(firstDeny).toBeGreaterThan(-1);
    expect(catchAll).toBeLessThan(firstDeny);
    // And the environment it runs in is an allowlist, not the loop's own.
    expect(readRepo("delegate.sh")).toContain("env -i");
  });

  it("keeps the read-only stages denied by default and inside this checkout", () => {
    const rails = readRepo("opencode-readonly.jsonc");
    // `"*": "deny"` FIRST, because last match wins — this is the floor the
    // rest of the block stands on.
    expect(rails.indexOf('"*": "deny"')).toBeGreaterThan(-1);
    expect(rails.indexOf('"*": "deny"')).toBeLessThan(rails.indexOf('"external_directory": "deny"'));
    expect(rails).toContain('"edit": "deny"');
    expect(rails).toContain('"external_directory": "deny"');
    // The rail that cannot live in a permission file: git's own configuration
    // turns an allowed read into command execution.
    const inspect = readRepo("inspect.sh");
    expect(inspect).toContain("GIT_ATTR_SOURCE");
    expect(inspect).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(inspect).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(inspect).toContain("core.fsmonitor=false");
    expect(inspect).toContain("core.pager=cat");
    expect(inspect).toContain("--no-ext-diff");
    expect(inspect).toContain("bwrap");
  });

  it("gives the mirror and the control channel no way to place a process", () => {
    // The safety case for both directions of the Orca integration, asserted
    // against the exported allowlists rather than the source text they are
    // written in: a rule about "does this string appear in that file" passes
    // for every string that could never have appeared there anyway.
    //
    // `startsWith("orchestration ")` is the load-bearing half. Every verb that
    // would put a process somewhere lives under a DIFFERENT Orca noun —
    // `terminal send`, `worktree …` — so the prefix is what makes them
    // unreachable rather than a list of the ones somebody thought of.
    for (const verb of ALLOWED_VERBS) {
      expect(verb.startsWith("orchestration "), `orca-lifecycle.ts allows ${verb}`).toBe(true);
    }
    for (const verb of CONTROL_VERBS) {
      expect(verb.startsWith("orchestration "), `orca-controls.ts allows ${verb}`).toBe(true);
    }
    // And the one placement verb that IS under `orchestration`.
    expect([...ALLOWED_VERBS]).not.toContain("orchestration worker-start");
    expect([...CONTROL_VERBS]).not.toContain("orchestration worker-start");
    // A record becomes a placement by flag as well as by verb.
    expect([...FORBIDDEN_ARGS]).toContain("--inject");
    // The channel that reads orders may not open a Run of its own either.
    expect([...CONTROL_VERBS]).not.toContain("orchestration run-create");
  });

  it("lets observability spawn nothing but a git read", () => {
    // Observing must grant nothing: the module that watches every runner is
    // itself the narrowest thing in the loop. `toEqual` rather than
    // `toContain`, so widening the list by one binary fails here.
    expect([...ALLOWED_COMMANDS]).toEqual(["git"]);
    expect([...ALLOWED_GIT_SUBCOMMANDS]).toEqual(["rev-parse"]);
  });
});


describe("findings become fixes and retire through the real publisher", () => {
  it("reconciles a pending learning, deduplicates its fix ticket and retires it after merge", () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-findings-e2e-"));
    scratchRoots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    const remote = join(root, "origin.git");
    const bin = join(root, "bin");
    mkdirSync(home); mkdirSync(project); mkdirSync(bin);
    writeProjectConfig(home); writeProjectConfig(project);
    const env = fixtureGitEnv({
      PATH: `${bin}:${process.env.PATH}`,
      GIT_AUTHOR_NAME: "Findings Test", GIT_AUTHOR_EMAIL: "finding@example.invalid",
      GIT_COMMITTER_NAME: "Findings Test", GIT_COMMITTER_EMAIL: "finding@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      RALPH_PROJECT: project, RALPH_LOOP_NAME: "ralph",
      RALPH_JOURNAL_HOME: home, RALPH_JOURNAL_WORKTREE: join(root, "publisher"),
      RALPH_JOURNAL_LOCK: join(root, "publisher.lock"), RALPH_FINDINGS_DISABLED: "",
      RALPH_FINDINGS_RECORD: join(root, "findings.json"),
      FINDINGS_REGISTRY: join(root, "registry.json"),
    });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    git(home, "init", "--quiet", "--initial-branch=main");
    mkdirSync(join(home, "learnings"));
    writeFileSync(join(home, "learnings/fixture.md"), `# Fixture learnings

## Open: fix these

### Missing fixture
<!-- learning: missing-fixture -->
- **Seen:** build 31 failed because genres.json is absent.
- **Workaround:** use the existing stub.
- **Change:** add the missing genres fixture.
- **Verify:** the genre discovery regression test passes.
- **Fix:** no issue yet.
`);
    git(home, "add", "."); git(home, "commit", "--quiet", "-m", "init");
    git(home, "remote", "add", "origin", remote); git(home, "push", "--quiet", "-u", "origin", "main");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
p = Path(os.environ["FINDINGS_REGISTRY"])
rows = json.loads(p.read_text()) if p.exists() else []
if args[0] == "api":
    # Like real gh: --slurp refuses --jq/--template and prints an array of pages.
    if "--slurp" in args and ("--jq" in args or "--template" in args):
        sys.exit("the --slurp option is not supported with --jq or --template")
    print(json.dumps([[dict(r, html_url=r["url"]) for r in rows]]))
elif args[:2] == ["issue", "create"]:
    body = Path(args[args.index("--body-file") + 1]).read_text()
    row = {"number": len(rows)+1, "url": "https://github.com/your-org/your-repo/issues/"+str(len(rows)+1), "body": body+"\\n---\\n\\n_Posted by test-model via Codex_"}
    rows.append(row); p.write_text(json.dumps(rows)); print(row["url"])
elif args[:2] != ["label", "create"]:
    sys.exit(2)
`);
    chmodSync(join(bin, "gh"), 0o755);
    const run = (script: string, ...args: string[]) => spawnSync(BUN, [join(REPO_ROOT, script), ...args], {
      cwd: project, env, encoding: "utf8", timeout: 60_000,
    });
    const first = run("findings.ts", "reconcile");
    expect(first.status, first.stdout + first.stderr).toBe(0);
    const linked = git(home, "show", "origin/main:learnings/fixture.md");
    expect(linked).toContain("- **Fix:** https://github.com/your-org/your-repo/issues/1");
    const again = run("findings.ts", "reconcile");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    const rows = JSON.parse(readFileSync(env.FINDINGS_REGISTRY!, "utf8"));
    expect(rows).toHaveLength(1);
    expect(rows[0].body.match(/_Posted by/g)).toHaveLength(1);
    const closed = run("publish-journal.ts", "--close", "missing-fixture", "--pr", "44", "--scope", "project");
    expect(closed.status, closed.stdout + closed.stderr).toBe(0);
    const retired = git(home, "show", "origin/main:learnings/fixture.md");
    expect(retired).toContain("| Missing fixture | #44 |");
    expect(retired).not.toContain("<!-- learning: missing-fixture -->");
  }, 60_000);
});

describe("a loop whose supervisor died is restarted end to end", () => {
  it("brings it back through the real start.sh and records the restart in its own feed", async () => {
    // The dashboard's reconciler (#346) against the implementations that own
    // each fact: the real `start.sh` with its worktree lock and pid file, the
    // real `loop-state status --json` matching the supervisor by argv and cwd
    // in `/proc`, the real `agents.ts` start gate, and the real
    // `push-notification.ts` writing the feed. Only `ralph.sh` is a fake, and
    // only because an iteration would need a model.
    const scratch = mkdtempSync(join(tmpdir(), "ralph-e2e-reconcile-"));
    scratchRoots.push(scratch);
    const worktree = join(scratch, "project");
    const home = join(scratch, "home");
    const bin = join(scratch, "bin");
    for (const dir of [join(worktree, ".ralph", "logs"), home, bin]) mkdirSync(dir, { recursive: true });
    writeProjectConfig(worktree);
    writeFileSync(join(worktree, ".ralph", "loop-name"), "ralph\n");
    for (const file of ["start.sh", "project.sh"]) cpSync(join(REPO_ROOT, file), join(home, file));
    chmodSync(join(home, "start.sh"), 0o755);

    const script = (path: string, lines: string[]): void => {
      writeFileSync(path, [...lines, ""].join("\n"));
      chmodSync(path, 0o755);
    };
    // Read-only git: no registry, so `loop-state` falls back to the worktree
    // it was asked about, and nothing here can repair a checkout.
    script(join(bin, "git"), [
      "#!/bin/sh",
      'case "$1" in',
      "  symbolic-ref) printf '%s\\n' 'ralph/346-reconcile' ;;",
      "  status) ;;",
      "esac",
      "exit 0",
    ]);
    // A supervisor that writes its record and then waits, as the real one does
    // between iterations. `$$` is the pid the record names and `start.sh`
    // publishes, and its argv is `bash …/ralph.sh N` with the worktree as cwd,
    // which is what `supervisorPidMatches` reads.
    script(join(home, "ralph.sh"), [
      "#!/usr/bin/env bash",
      'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
      `printf '{"version":1,"run":"ralph-run-dead","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/346-reconcile","stage":"iteration","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$$" "$PWD" "$now" > .ralph/logs/state.json`,
      // Short, so a child this suite somehow fails to reap clears itself in
      // seconds rather than sitting on the host for ten minutes. One pass is
      // all the test needs it alive for.
      "sleep 30",
    ]);

    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RALPH_LOOP_NAME: "ralph",
      RALPH_PLUGINS: "",
      RALPH_PUSH_NOTIFICATIONS: "1",
    };
    const pidFile = join(worktree, ".ralph", "logs", "supervisor.pid");
    const pidOf = (): number => Number(readFileSync(pidFile, "utf8").trim());
    const started = spawnSync(join(home, "start.sh"), [], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    expect(started.status, started.stderr).toBe(0);
    const dead = pidOf();
    rememberSupervisor(dead);

    // Wait for the record, then kill the supervisor outright: an oomd kill
    // leaves exactly this — a `stopReason`-less record and no process.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(join(worktree, ".ralph", "logs", "state.json"))) break;
      execFileSync("bash", ["-c", "sleep 0.05"]);
    }
    process.kill(dead, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(dead, 0);
      } catch {
        break;
      }
      execFileSync("bash", ["-c", "sleep 0.05"]);
    }

    const executor = createProcessExecutor({ timeoutMs: 60_000 });
    const lifecycleDeps = {
      control: createRalphControlAdapter({ cliDir: REPO_ROOT, root: worktree, bunPath: BUN, env, exec: executor }),
      lifecycle: createRalphLifecycleAdapter({
        cliDir: REPO_ROOT,
        root: worktree,
        bunPath: BUN,
        env,
        startScript: join(home, "start.sh"),
        exec: executor,
      }),
      loop: "ralph",
    };
    const pass = await reconcile({
      targets: () => [
        {
          project: "software-factory",
          loop: "ralph",
          worktree,
          lifecycle: lifecycleDeps,
          agents: {
            agents: createAgentsAdapter({ cliDir: REPO_ROOT, root: worktree, project: "software-factory", bunPath: BUN, exec: executor }),
          },
        },
      ],
      records: (root) => createRecordsAdapter({ root }),
      adapter: createReconcileAdapter({ cliDir: REPO_ROOT, bunPath: BUN, env, exec: executor }),
    });

    expect(pass.skipped, JSON.stringify(pass)).toEqual([]);
    expect(pass.attempts[0]).toMatchObject({ outcome: "restarted", loop: "ralph", run: "ralph-run-dead" });
    // A NEW supervisor, live, in the same worktree.
    const live = pidOf();
    rememberSupervisor(live);
    expect(live).not.toBe(dead);
    expect(supervisorPidMatches(live, worktree)).toBe("alive");
    // And the restart is on the record the page reads, with its reason.
    const feed = notificationFeed("ralph", createRecordsAdapter({ root: worktree }).readFeed());
    const [alert] = feed.notifications.filter((entry) => entry.kind === "loop-restarted");
    expect(alert?.run).toBe("ralph-run-dead");
    expect(alert?.body).toContain("no stopReason");
    expect(alert?.body).toContain("outcome: restarted");
  }, 120_000);
});

/**
 * One worktree wired as the dashboard's reconciler sees it, for the retry
 * cases: the real `start.sh` copied into a scratch home, a read-only fake
 * `git`, and a fake `ralph.sh` whose body the case supplies (an iteration
 * would need a model). `stop` writes the record a loop leaves when it stopped
 * itself; `pass` runs one `reconcile()` with the injected clock.
 */
const retryFixture = (supervisor: string[]) => {
  const scratch = mkdtempSync(join(tmpdir(), "ralph-e2e-retry-"));
  scratchRoots.push(scratch);
  const worktree = join(scratch, "project");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  for (const dir of [join(worktree, ".ralph", "logs"), home, bin]) mkdirSync(dir, { recursive: true });
  writeProjectConfig(worktree);
  writeFileSync(join(worktree, ".ralph", "loop-name"), "ralph\n");
  for (const file of ["start.sh", "project.sh"]) cpSync(join(REPO_ROOT, file), join(home, file));
  chmodSync(join(home, "start.sh"), 0o755);
  const script = (path: string, lines: string[]): void => {
    writeFileSync(path, [...lines, ""].join("\n"));
    chmodSync(path, 0o755);
  };
  script(join(bin, "git"), [
    "#!/bin/sh",
    'case "$1" in',
    "  symbolic-ref) printf '%s\\n' 'ralph/420-retry' ;;",
    "  status) ;;",
    "esac",
    "exit 0",
  ]);
  script(join(home, "ralph.sh"), ["#!/usr/bin/env bash", ...supervisor]);

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_LOOP_NAME: "ralph",
    RALPH_PLUGINS: "",
    RALPH_PUSH_NOTIFICATIONS: "1",
  };
  const statePath = join(worktree, ".ralph", "logs", "state.json");
  const pidFile = join(worktree, ".ralph", "logs", "supervisor.pid");
  const pidOf = (): number => Number(readFileSync(pidFile, "utf8").trim());
  const runOf = (): string | null => {
    try {
      return (JSON.parse(readFileSync(statePath, "utf8")) as { run?: string }).run ?? null;
    } catch {
      return null;
    }
  };
  // A supervisor that is gone: a pid that exited, so liveness reads `dead`.
  const stop = (lastEvent: { name: string; detail?: string }, at: string): void => {
    const gone = spawnSync("true").pid ?? 0;
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        run: "ralph-run-stopped",
        owner: { loop: "ralph", pid: gone, host: "test" },
        worktree,
        branch: "ralph/420-retry",
        stage: "stopped",
        iteration: { index: 1, max: 50 },
        heartbeat: at,
        lastEvent: { ...lastEvent, at },
        stopReason: { kind: "failed", why: `the loop stopped on ${lastEvent.name}`, at },
      }),
    );
  };
  const executor = createProcessExecutor({ timeoutMs: 60_000 });
  const lifecycleDeps = {
    control: createRalphControlAdapter({ cliDir: REPO_ROOT, root: worktree, bunPath: BUN, env, exec: executor }),
    lifecycle: createRalphLifecycleAdapter({
      cliDir: REPO_ROOT,
      root: worktree,
      bunPath: BUN,
      env,
      startScript: join(home, "start.sh"),
      exec: executor,
    }),
    loop: "ralph",
  };
  const pass = (now: () => Date, bootTime?: () => number | null) =>
    reconcile({
      targets: () => [
        {
          project: "software-factory",
          loop: "ralph",
          worktree,
          lifecycle: lifecycleDeps,
          agents: {
            agents: createAgentsAdapter({ cliDir: REPO_ROOT, root: worktree, project: "software-factory", bunPath: BUN, exec: executor }),
          },
        },
      ],
      records: (root) => createRecordsAdapter({ root }),
      adapter: createReconcileAdapter({ cliDir: REPO_ROOT, bunPath: BUN, env, exec: executor }),
      now,
      ...(bootTime === undefined ? {} : { bootTime }),
    });
  // The raised lines as `push-notification.ts` wrote them, in order.
  const raised = (kind: string): { kind: string; priority: string; retry?: unknown }[] => {
    const path = join(worktree, ".ralph", "logs", "notifications.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { event: string; kind: string; priority: string; retry?: unknown })
      .filter((line) => line.event === "raised" && line.kind === kind);
  };
  // The supervisor started as the Start button starts it, by the real start.sh.
  const start = (): number => {
    const started = spawnSync(join(home, "start.sh"), [], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    expect(started.status, started.stderr).toBe(0);
    const pid = pidOf();
    rememberSupervisor(pid);
    return pid;
  };
  return { worktree, pidOf, runOf, stop, pass, raised, start, statePath };
};

/** Poll a predicate rather than sleep a fixed time; false when it never held. */
const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((settle) => setTimeout(settle, 50));
  }
  return predicate();
};

const MINUTE = 60_000;

describe("a loop ended by a signal stays stopped, and one killed outright is restarted", () => {
  // The real trap (`signal-stop.sh`) in a supervisor that waits the way the
  // real one waits on a turn — in the background, under `wait` — and the real
  // `controls.ts` writing what it records. A shutdown, a reboot and an
  // operator's `kill` are SIGTERM; oomd, the kernel's OOM killer and a power
  // cut leave what SIGKILL leaves. On 2026-10-28 the first kind came back at
  // boot like the second.
  const trapped = (label: string): string[] => [
    `export RALPH_HOME=${JSON.stringify(REPO_ROOT)} RALPH_RUN_ID=ralph-run-${label}`,
    'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
    `printf '{"version":1,"run":"%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/420-retry","stage":"iteration","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$RALPH_RUN_ID" "$$" "$PWD" "$now" > .ralph/logs/state.json`,
    '. "$RALPH_HOME/signal-stop.sh"',
    "sleep 30 &",
    'wait "$!"',
  ];
  const gone = (pid: number) => (): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };

  it("records SIGTERM as interrupted and leaves the loop alone; restarts the SIGKILLed one", async () => {
    const termed = retryFixture(trapped("termed"));
    const killed = retryFixture(trapped("killed"));
    const termedPid = termed.start();
    const killedPid = killed.start();
    expect(await until(() => termed.runOf() === "ralph-run-termed" && killed.runOf() === "ralph-run-killed")).toBe(true);

    process.kill(termedPid, "SIGTERM");
    process.kill(killedPid, "SIGKILL");
    expect(await until(gone(termedPid))).toBe(true);
    expect(await until(gone(killedPid))).toBe(true);

    const state = JSON.parse(readFileSync(termed.statePath, "utf8")) as { stopReason: { kind: string; why: string } | null };
    expect(state.stopReason).toMatchObject({ kind: "interrupted", why: "stopped by SIGTERM (a shutdown, a reboot or a kill)" });
    const control = parseControlState(readFileSync(join(termed.worktree, CONTROL_STATE_RELATIVE_PATH), "utf8"));
    // Confirmed, so Resume work takes it like a Stop now.
    expect(control?.stop).toMatchObject({ kind: "interrupted", confirmation: "confirmed" });

    const left = await termed.pass(() => new Date());
    expect(left.attempts, JSON.stringify(left)).toEqual([]);
    expect(termed.raised("loop-restarted")).toEqual([]);
    expect(termed.pidOf()).toBe(termedPid);

    const back = await killed.pass(() => new Date());
    expect(back.attempts[0], JSON.stringify(back)).toMatchObject({ outcome: "restarted", run: "ralph-run-killed" });
    const live = killed.pidOf();
    rememberSupervisor(live);
    expect(live).not.toBe(killedPid);
  }, 120_000);

  it("restarts the SIGTERMed one at the next boot: the shutdown stopped it, nobody chose to (#6)", async () => {
    const termed = retryFixture(trapped("shutdown"));
    const termedPid = termed.start();
    expect(await until(() => termed.runOf() === "ralph-run-shutdown")).toBe(true);
    process.kill(termedPid, "SIGTERM");
    expect(await until(gone(termedPid))).toBe(true);

    const state = JSON.parse(readFileSync(termed.statePath, "utf8")) as { stopReason: Record<string, unknown> | null };
    expect(state.stopReason).toMatchObject({ kind: "interrupted", signal: "SIGTERM", self: true });
    const stoppedAt = Date.parse(String(state.stopReason?.at));

    // The same host, before any reboot: a kill after the boot stays stopped.
    const kept = await termed.pass(() => new Date(), () => stoppedAt - 60_000);
    expect(kept.attempts, JSON.stringify(kept)).toEqual([]);

    // The host came back up after the stop: that SIGTERM was the shutdown.
    const back = await termed.pass(() => new Date(), () => stoppedAt + 60_000);
    expect(back.attempts[0], JSON.stringify(back)).toMatchObject({ outcome: "restarted", run: "ralph-run-shutdown" });
    const live = termed.pidOf();
    rememberSupervisor(live);
    expect(live).not.toBe(termedPid);
    expect(termed.raised("loop-restarted")).toHaveLength(1);
  }, 120_000);
});

describe("a loop that stopped itself on a transient fault is retried end to end", () => {
  // A supervisor that writes its record and then waits, as the real one does
  // between iterations. Short, so a child the suite somehow fails to reap
  // clears itself in seconds.
  const staysUp = [
    'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
    `printf '{"version":1,"run":"ralph-run-%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/420-retry","stage":"iteration","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":null,"stopReason":null}' "$$" "$$" "$PWD" "$now" > .ralph/logs/state.json`,
    "sleep 30",
  ];

  it("waits out the first gap on a no-sigil stop, then starts it and records the attempt", async () => {
    const fixture = retryFixture(staysUp);
    const stoppedAt = new Date();
    fixture.stop({ name: "no-sigil" }, stoppedAt.toISOString());

    const early = await fixture.pass(() => new Date(Date.now() + MINUTE));
    expect(early.attempts, JSON.stringify(early)).toEqual([]);
    expect(early.skipped.map((entry) => entry.why)).toEqual([
      `retry 1 of 7 for no-sigil is due at ${new Date(stoppedAt.getTime() + 5 * MINUTE).toISOString()}`,
    ]);
    expect(fixture.raised("loop-retried")).toEqual([]);

    const due = await fixture.pass(() => new Date(Date.now() + 6 * MINUTE));
    expect(due.attempts[0], JSON.stringify(due)).toMatchObject({
      outcome: "restarted",
      loop: "ralph",
      run: "ralph-run-stopped",
      retry: { attempt: 1, of: 7, cause: "no-sigil" },
    });
    const live = fixture.pidOf();
    rememberSupervisor(live);
    expect(supervisorPidMatches(live, fixture.worktree)).toBe("alive");
    const retried = fixture.raised("loop-retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]?.retry).toEqual({ attempt: 1, of: 7, cause: "no-sigil" });
  }, 120_000);

  it("retries a preflight refusal on doppler scope once its gap is past", async () => {
    const fixture = retryFixture(staysUp);
    fixture.stop({ name: "preflight-denied", detail: "doppler-scope" }, new Date().toISOString());

    // The fake supervisor just runs: that is the secrets read succeeding.
    const due = await fixture.pass(() => new Date(Date.now() + 6 * MINUTE));
    expect(due.attempts[0], JSON.stringify(due)).toMatchObject({
      outcome: "restarted",
      retry: { attempt: 1, of: 7, cause: "preflight-denied" },
    });
    const live = fixture.pidOf();
    rememberSupervisor(live);
    expect(supervisorPidMatches(live, fixture.worktree)).toBe("alive");
    expect(fixture.raised("loop-retried").map((line) => line.retry)).toEqual([
      { attempt: 1, of: 7, cause: "preflight-denied" },
    ]);
  }, 120_000);

  // Longer than the cases above: nine passes, seven of them real starts
  // through `start.sh` and the `agents.ts` gate, each a few bun processes, on
  // a host that also runs the live loops.
  it("caps after the schedule is spent with one high alert, and starts nothing more", async () => {
    // Every start stops again: the supervisor records a fresh no-sigil
    // failure and exits. The second's sleep keeps it alive past `start.sh`'s
    // startup check, so each attempt reads as a start rather than a crash.
    const fixture = retryFixture([
      'now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"',
      `printf '{"version":1,"run":"ralph-run-%s","owner":{"loop":"ralph","pid":%s,"host":"test"},"worktree":"%s","branch":"ralph/420-retry","stage":"stopped","iteration":{"index":1,"max":50},"heartbeat":"%s","lastEvent":{"name":"no-sigil","at":"%s"},"stopReason":{"kind":"failed","why":"no sigil","at":"%s"}}' "$$" "$$" "$PWD" "$now" "$now" "$now" > .ralph/logs/state.json`,
      "sleep 1",
    ]);
    fixture.stop({ name: "no-sigil" }, new Date().toISOString());

    for (const [index, gap] of DEFAULT_RETRY_SCHEDULE_MINUTES.entries()) {
      // The records stamp wall-clock time, so the clock is set relative to
      // it: one minute past this attempt's gap from the newest record.
      const pass = await fixture.pass(() => new Date(Date.now() + (gap + 1) * MINUTE));
      expect(pass.attempts.map((attempt) => attempt.retry), JSON.stringify(pass)).toEqual([
        { attempt: index + 1, of: 7, cause: "no-sigil" },
      ]);
      const pid = fixture.pidOf();
      rememberSupervisor(pid);
      // It stopped again, on its own record, before the next pass reads it.
      expect(
        await until(() => fixture.runOf() === `ralph-run-${String(pid)}` && supervisorPidMatches(pid, fixture.worktree) !== "alive"),
      ).toBe(true);
    }
    expect(fixture.raised("loop-retried")).toHaveLength(7);

    for (let extra = 0; extra < 2; extra += 1) {
      const pass = await fixture.pass(() => new Date(Date.now() + 120 * MINUTE));
      expect(pass.attempts, JSON.stringify(pass)).toEqual([]);
    }
    const capped = fixture.raised("loop-retry-capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]?.priority).toBe("high");
    expect(fixture.raised("loop-retried")).toHaveLength(7);
    expect(supervisorPidMatches(fixture.pidOf(), fixture.worktree)).not.toBe("alive");
  }, 240_000);
});

/**
 * The frontier's census and pick, then the claim fence and the claim, as a
 * `ralph` coder iteration runs them on a keyed tracker (`AND` on Linear by
 * default). The pick must be `expected`: a census that offers another ticket
 * is the bug.
 */
const pickAndClaim = async (tracker: FakeTracker, expected: number, key = "AND"): Promise<number> => {
  useFrontierTracker(tracker, key, async () => []);
  const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
  const tickets = buildTickets(inputs.raw, inputs.natives, new Set(inputs.closed.map((issue) => issue.number)), inputs.openPrs);
  const [pick] = takeOneCandidates(classify(tickets, []));
  expect(pick?.number).toBe(expected);
  const claim = await claimByNumber(pick!.number, "ralph-wip", {
    readLive: readLiveIssue,
    claim: async (n, label) => void (await tracker.claim(n, label)),
  });
  expect(claim.claimed).toBe(true);
  return pick!.number;
};

/**
 * The tracker CLI the prompts call, in-process against `tracker`, as loop
 * `ralph`. `blockPark` is the park hand-off `blocked` records (#776); absent,
 * as in production's tests, `blocked` touches no park store.
 */
const cli = (tracker: FakeTracker, blockPark?: CliDeps["blockPark"]) => {
  const out: string[] = [];
  const run = (...argv: string[]) =>
    trackerCli(argv, {
      tracker: () => tracker,
      loop: () => "ralph",
      out: (line) => out.push(line),
      err: () => {},
      ...(blockPark === undefined ? {} : { blockPark }),
    });
  return { out, run };
};

/*
 * One coder iteration on a project whose tickets live in Linear (#340), through
 * the real modules each step of `prompt.md` reaches: the frontier's census and
 * pick, the claim fence and the claim, the executor's spec file, the PR's
 * ticket line, and the finish or the park. The tracker is the in-memory fake in
 * its Linear shape, so the whole lifecycle is asserted on one tracker's state.
 */
describe("a coder iteration on a Linear project", () => {
  const ticketBody = "## Parent\n\nAND-171\n\n## Acceptance criteria\n\n- [ ] the listing goes through the one call point\n";
  const backlog = () =>
    createFakeTracker({
      kind: "linear",
      key: "AND",
      labels: ["ready-for-agent", "spec", "ralph-wip", "ralph-blocked", "ralph-done"],
      issues: [
        { number: 171, title: "Spec: search module", labels: ["spec"] },
        { number: 184, title: "Route the listing through the one call point", body: ticketBody, labels: ["ready-for-agent"], parent: 171 },
        { number: 185, title: "Waits on 184", body: "## Blocked by\n\n* AND-184\n", labels: ["ready-for-agent"], parent: 171 },
      ],
    });
  const previousProject = process.env.RALPH_PROJECT;
  beforeEach(() => {
    // The roster the claim fence reads: loggd's coders.
    process.env.RALPH_PROJECT = join(__dirname, "fixtures", "loggd");
  });
  afterEach(() => {
    useFrontierTracker(null);
    if (previousProject === undefined) delete process.env.RALPH_PROJECT;
    else process.env.RALPH_PROJECT = previousProject;
  });

  it("claims into In Progress, specs the ticket, names it on the PR, and finishes it Done", async () => {
    const tracker = backlog();
    const n = await pickAndClaim(tracker, 184);
    expect(tracker.issues.get(n)).toMatchObject({ status: "In Progress", labels: ["ready-for-agent", "ralph-wip"] });

    const fetched = await fetchFromTracker(tracker, n);
    const spec = renderSpec(fetched.ok ? fetched.issue : (null as never), "2026-10-20T12:00:00Z");
    expect(spec).toContain("# AND-184 — Route the listing through the one call point");
    expect(spec).toContain("- [ ] the listing goes through the one call point");

    const { out, run } = cli(tracker);
    expect(await run("pr-ref", String(n))).toBe(0);
    expect(out.at(-1)).toBe("Ticket: AND-184 https://linear.app/fake/issue/AND-184");

    expect(await run("done", String(n))).toBe(0);
    expect(tracker.issues.get(n)).toMatchObject({ state: "closed", status: "Done", labels: ["ready-for-agent", "ralph-done"] });
    // Its dependent is free now: the next census offers it.
    const next = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
    const after = buildTickets(next.raw, next.natives, new Set(next.closed.map((issue) => issue.number)), next.openPrs);
    expect(takeOneCandidates(classify(after, [])).map((ticket) => ticket.number)).toEqual([185]);
  });

  it("parks a stuck ticket blocked, with the reason on it, and keeps its state for a human", async () => {
    const tracker = backlog();
    const n = await pickAndClaim(tracker, 184);
    const { run } = cli(tracker);
    expect(await run("comment", String(n), "--body", "blocked: the listing contract is ambiguous; asked in the spec")).toBe(0);
    expect(await run("blocked", String(n))).toBe(0);
    const issue = tracker.issues.get(n)!;
    expect(issue).toMatchObject({ state: "open", status: "In Progress", labels: ["ready-for-agent", "ralph-blocked"] });
    expect(issue.comments.at(-1)!.body).toMatch(/^blocked: /);
    // A parked ticket is nobody's to take until a human unblocks it.
    useFrontierTracker(tracker, "AND", async () => []);
    expect(await claimByNumber(n, "rafa-wip", { readLive: readLiveIssue, claim: async () => {} })).toMatchObject({
      claimed: false,
      refusal: "labeled ralph-blocked",
    });
  });

  // #776: a block with a wake condition is parked, the triager leaves it to
  // the park probe, and the probe hands it back to the coders on its own.
  it("parks a block with a wake condition, withholds it from rescue, wakes it, and offers it again", async () => {
    const tracker = backlog();
    // Rescue reads the GitHub-shaped triage path, which only lifts an owner's ticket.
    const owner = "felipearosr";
    tracker.issues.get(184)!.author = owner;
    const n = await pickAndClaim(tracker, 184);

    const dir = mkdtempSync(join(tmpdir(), "ralph-e2e-park-"));
    scratchRoots.push(dir);
    const file = join(dir, "block-park.json");
    const storePath = join(dir, "ralph-parks.json");
    writeFileSync(
      file,
      JSON.stringify({ ticket: n, condition: { kind: "reference", ref: "#186" }, summary: "waiting for #186 to merge" }),
    );
    const pushes: string[][] = [];
    const { run } = cli(tracker, () => ({ file, storePath, push: (argv) => void pushes.push(argv), env: {} }));
    expect(await run("comment", String(n), "--body", "blocked: waiting for #186 to merge first")).toBe(0);
    expect(await run("blocked", String(n))).toBe(0);
    expect(tracker.issues.get(n)!.labels).toEqual(["ready-for-agent", "ralph-blocked"]);
    expect(listStore(storePath)).toEqual([
      expect.objectContaining({
        ticket: n,
        loop: "ralph",
        label: "ralph-blocked",
        condition: { kind: "reference", ref: "#186" },
        expired: false,
      }),
    ]);
    expect(existsSync(file)).toBe(false);
    expect(pushes).toEqual([]);

    // Withheld: the triager's buckets over this census, with and without the store.
    const census = async () => {
      const inputs = await readKeyedFrontierInputs(tracker, { gh: async () => "[]" });
      const tickets = buildTickets(inputs.raw, inputs.natives, new Set(inputs.closed.map((issue) => issue.number)), inputs.openPrs);
      return { tickets, frontier: classify(tickets, []) };
    };
    const rescue = async (parked: boolean): Promise<number[]> => {
      const { tickets, frontier } = await census();
      const now = new Date();
      return triageBuckets(tickets, frontier, {
        owner,
        coders: ["ralph"],
        now,
        ...(parked ? { parks: readParks(now, { RALPH_PARK_STORE: storePath }) } : {}),
      }).rescue.map((ticket) => ticket.number);
    };
    expect(await rescue(true)).not.toContain(n);
    // The control: the same census without the park is a rescue, so the park is what withheld it.
    expect(await rescue(false)).toContain(n);

    // Woken: the real sweep, with #186 merged and its label removal through the tracker CLI.
    const logs: string[] = [];
    const tally = await sweep({
      storePath,
      repo: "felipearos/ralph",
      readCap: 60,
      minIntervalSeconds: 0,
      now: () => new Date().toISOString(),
      log: (line) => void logs.push(line),
      reader: {
        prChecks: async () => null,
        baseChecks: async () => null,
        prState: async (_repo, number) => (number === 186 ? "merged" : null),
        issueState: async () => null,
        stepPassed: async () => null,
        issueLive: async (ticket) => {
          const issue = tracker.issues.get(ticket);
          return issue === undefined ? null : { state: issue.state, labels: [...issue.labels], assignees: [...issue.assignees] };
        },
        prDraft: async () => null,
      },
      writer: {
        prReady: async () => {
          throw new Error("a park with no PR has no draft to ready");
        },
        removeLabel: async (ticket, label) => {
          if ((await run("label", "remove", String(ticket), label)) !== 0) throw new Error(`label remove ${label} failed`);
        },
        notify: () => {
          throw new Error("a woken park pages nobody");
        },
      },
    });
    expect(tally, logs.join("\n")).toMatchObject({ woke: 1, dropped: 0, failed: 0 });
    expect(listStore(storePath)).toEqual([]);
    expect(tracker.issues.get(n)!.labels).not.toContain("ralph-blocked");

    // Offered again: the coder frontier's census picks it, and the claim lands.
    expect(await pickAndClaim(tracker, n)).toBe(n);
    expect(tracker.issues.get(n)!.labels).toEqual(["ready-for-agent", "ralph-wip"]);
  });
});

/*
 * A Slack report, end to end through the intake board (#399, #443): clara
 * files it on the Jira intake board in "Por confirmar", nobody's frontier
 * offers it while it waits, a person confirms it for an agent, the gate's
 * sweep makes it ready, a coder iteration claims and finishes it, and the
 * outcome scan records the close, so the metrics count the report valuable.
 *
 * The clerk's stages run against the fake Jira at its HTTP seam, the coder's
 * against the in-memory tracker in its Jira shape: two seams, so the ticket is
 * carried across by hand twice — into the tracker as the sweep left it, and
 * back onto the board as the coder finished it. Nothing else is re-seeded.
 */
describe("a Slack report through the intake board, from filing to a valuable outcome", () => {
  const T0 = "1760961600.000000";
  const channel = "C0TEAMCHAN1";
  const previousProject = process.env.RALPH_PROJECT;
  beforeEach(() => {
    // The roster the claim fence reads: loggd's coders.
    process.env.RALPH_PROJECT = join(__dirname, "fixtures", "loggd");
  });
  afterEach(() => {
    useFrontierTracker(null);
    if (previousProject === undefined) delete process.env.RALPH_PROJECT;
    else process.env.RALPH_PROJECT = previousProject;
  });

  it("files it, waits for a person, codes it once confirmed, and records it valuable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-e2e-intake-"));
    scratchRoots.push(dir);
    const rules: ClerkRules = {
      ...CLERK_DEFAULTS,
      appLabels: APP_LABELS,
      mode: "live",
      channel,
      canvas: "F0CHANCANV1",
      shadowCanvas: null,
      operator: null,
      jira: { site: SITE, project: "OA", intakeProject: "OAI" },
    };
    const storePath = join(dir, "clara.json");
    const slack = fakeSlack(channel, { users: { U0ANA: "Ana Pérez" } });
    const jira = fakeJira("OA", { projects: ["OAI"], workflows: { OAI: INTAKE_WORKFLOW } });
    const plans = new Map<string, unknown>();
    const events: MetricsEvent[] = [];
    const deps = (minutes: number): PollDeps => ({
      rules,
      now: () => tsMs(after(T0, minutes)),
      slack: slackClient("xoxb-fake", slack.fetch, channel),
      jira: jiraClient(SITE, { email: "clerk@example.com", token: "fake" }, jira.fetch),
      storePath,
      ledger: (event) => events.push(event) > 0,
      intervalSeconds: 300,
      readPlan: (batch) => plans.get(batch),
      journal: () => {},
      notify: () => {},
      alert: () => {},
      secret: "test-secret",
      stop: () => true,
    });
    const store = () => readClerkStore(storePath, channel).store;
    const ticketOf = (key: string) => jira.issues.find((issue) => issue.key === key)!;
    /** The board ticket as the coder loops' tracker lists it: open, with its labels and description. */
    const coderTracker = (key: string) => {
      const ticket = ticketOf(key);
      return createFakeTracker({
        kind: "jira",
        key: "OAI",
        states: { claimed: "En curso", done: "Listo" },
        workflow: INTAKE_WORKFLOW.statuses.map((status) => status.name),
        issues: [{ number: Number(key.slice("OAI-".length)), title: ticket.summary, body: ticket.description ?? "", labels: [...(ticket.labels ?? [])] }],
      });
    };

    // 1. clara: the first poll starts the clock, the report settles, the batch plan files it.
    await poll(deps(0), noCache());
    const root = after(T0, 1);
    slack.post({ ts: root, user: "U0ANA", text: "No puedo exportar el reporte de checklists" });
    expect((await poll(deps(15), noCache())).verdict.work).toBe(true);
    const batch = store().batch!;
    // One app, Medium priority: nothing that forces it to a person.
    const entry = { verdict: "issue", type: "Error", app: "Backoffice", priority: "Medium", duplicate_of: null, assignee: "agent", difficulty: "hard", story_points: 3, summary_es: "No se puede exportar", description_es: "Falla." };
    plans.set(batch.id, { batch: batch.id, entries: [{ report: batch.reports[0]!.id, ...entry }] });
    await poll(deps(16), noCache());
    expect(store().batch).toBeNull();
    const filed = store().processed[root]!;
    expect(filed).toMatchObject({ state: "filed", key: expect.stringMatching(/^OAI-\d+$/) });
    const key = filed.key!;
    const n = Number(key.slice("OAI-".length));
    expect(ticketOf(key)).toMatchObject({ status: "Por confirmar", labels: [INTAKE_LABEL, "acme-backoffice", "difficulty:hard", "para-agente"] });

    // 2. Waiting for a person, it is nobody's to take.
    const waiting = coderTracker(key);
    useFrontierTracker(waiting, "OAI", async () => []);
    const census = await readKeyedFrontierInputs(waiting, { gh: async () => "[]" });
    const unconfirmed = buildTickets(census.raw, census.natives, new Set(), census.openPrs);
    expect(takeOneCandidates(classify(unconfirmed, []))).toEqual([]);

    // 3. A person confirms it on the board; the gate's next poll makes it ready.
    Object.assign(ticketOf(key), { status: "Confirmado", statusCategory: "indeterminate" });
    ticketOf(key).history!.push({ from: "Por confirmar", to: "Confirmado", at: new Date().toISOString(), by: { accountId: "557058:ana", displayName: "Ana Pérez" } });
    await poll(deps(20), noCache());
    expect(ticketOf(key).labels).toContain(READY_FOR_AGENT_LABEL);
    expect(events.filter((event) => event.kind === "confirmed")).toEqual([expect.objectContaining({ key, overrides: [] })]);

    // 4. A coder iteration: the frontier offers THIS ticket, the claim takes it, the finish closes it.
    const tracker = coderTracker(key);
    await pickAndClaim(tracker, n, "OAI");
    expect(tracker.issues.get(n)).toMatchObject({ status: "En curso", labels: expect.arrayContaining(["ralph-wip"]) });
    const { out, run } = cli(tracker);
    expect(await run("pr-ref", String(n))).toBe(0);
    expect(out.at(-1)).toMatch(new RegExp(`^Ticket: ${key} `));
    expect(await run("done", String(n))).toBe(0);
    expect(tracker.issues.get(n)).toMatchObject({ state: "closed", status: "Listo", labels: expect.arrayContaining(["ralph-done"]) });

    // 5. Done on the board, the outcome scan records the close, once, and the report counts as valuable.
    Object.assign(ticketOf(key), { status: "Listo", statusCategory: "done", resolution: "Done", resolved: new Date().toISOString() });
    await poll(deps(25), noCache());
    await poll(deps(30), noCache());
    expect(events.filter((event) => event.kind === "closed")).toEqual([expect.objectContaining({ key, report: root, resolution: "Done", status: "Listo" })]);
    expect(summarise(events, { by: "reporter" })).toEqual([expect.objectContaining({ key: "U0ANA", reports: 1, valuable: 1, noise: 0 })]);
    // The reporter was told once that it was received, and once that it is resolved.
    expect(slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => [call.params.thread_ts, call.params.text])).toEqual([
      [root, RECEIVED_REPLY],
      [root, resolvedReply(key)],
    ]);
  });
});

/*
 * One verifier watch, merge to verdict (#566): a merged PR that closes a
 * ticket, its Vercel production deploy, the gate opening the watch and
 * handing over each check-in with the evidence it gathered, and the session's
 * `verifier/checkin.ts decide` recording the acceptance check once — at the
 * first check-in — and judging the later ones by it. The two halves meet only
 * at the watch store, as they do across the process boundary in a real run,
 * so both are driven in-process against one temp store on one fake clock. The
 * acceptance file stands in for what `verifier/acceptance.ts` checked in the
 * session; no browser and no `ralph.sh` run here.
 */
describe("a verifier watch, from a merged PR to its verdict", () => {
  const HOUR = 3_600_000;
  const T0 = Date.parse("2026-10-29T10:00:00Z");
  const config = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "loggd", ".ralph", "config.json"), "utf8"));
  const rules = verifierRules(parseProjectConfig(JSON.stringify({
    ...config,
    loops: [...config.loops, { name: "sent", role: "verifier" }],
    verifier: { productionUrl: "https://loggd.app", deploy: { source: "vercel", project: "prj_loggd" }, sentry: { org: "loggd", project: "web" } },
  })))!;
  const caseOf = (offset: number): string => `verifier check-in +${offset}h of PR #12 (#184), deploy dpl_1`;

  /** PR #12 closes #184 and lands in production at T0; the gate and the session share one store and one clock. */
  function watched() {
    const dir = mkdtempSync(join(tmpdir(), "ralph-e2e-verifier-"));
    scratchRoots.push(dir);
    const storePath = join(dir, "verifier-watches.json");
    const clock = { now: T0 };
    const pr = {
      number: 12,
      title: "feat: settings page (#184)",
      body: "Closes #184",
      headRefName: "ralph/184",
      mergeCommit: { oid: "m12" },
      mergedAt: new Date(T0 - 10 * 60_000).toISOString(),
      labels: [],
      closingIssuesReferences: [{ number: 184 }],
    };
    const gh: VerifierGh = async (args) => {
      if (args[0] === "pr" && args[1] === "list") return { ok: true, stdout: JSON.stringify([pr]), stderr: "" };
      if (args[0] === "pr" && args[1] === "view" && args[2] === "12") return { ok: true, stdout: "app/settings/page.tsx\nlib/x.ts\n", stderr: "" };
      return { ok: false, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    const deployments = [{ uid: "dpl_1", url: "dpl_1.vercel.app", created: T0, ready: T0, meta: { githubCommitSha: "m12" } }];
    const fetcher: VerifierFetch = async () => new Response(JSON.stringify({ deployments }), { status: 200 });
    const deploy = rules.deploy as Extract<VerifierPollDeps["rules"]["deploy"], { source: "vercel" }>;
    const gate: VerifierPollDeps = {
      rules,
      gh,
      // The deploy is of the merge commit itself, so containment is identity.
      landed: { read: vercelLandedDeploy(deploy, "tok", fetcher, async (a, d) => a === d) },
      storePath,
      now: () => new Date(clock.now),
      baseBranch: "main",
      tracker: { kind: "github" },
      roster: [{ name: "ralph", role: "coder" }],
      holder: { run: "run-1", loop: "sent", pid: 4242, host: "test-host" },
      alive: () => true,
      // Healthy, and the changed route was hit, so the traffic floor (on by default) is met.
      sentry: { read: async () => ({ health: { reachable: true, issues: [] }, traffic: { reachable: true, hits: 42 } }) },
      reporter: { tracker: null, why: "no tracker in this test" },
      repoSlug: "felipearos/loggd",
    };
    /** The session: `decide` on the case the gate answered with, as ralph.sh hands it over in RALPH_INTAKE_CASE. */
    const decide = (offset: number, extra: string[] = []) =>
      runCheckin(["decide", ...extra], { storePath, rules, env: { RALPH_INTAKE_CASE: caseOf(offset) }, now: () => new Date(clock.now) });
    let files = 0;
    const acceptanceFile = (value: unknown): string[] => {
      files += 1;
      const file = join(dir, `acceptance-${files}.json`);
      writeFileSync(file, JSON.stringify(value));
      return ["--acceptance", file];
    };
    const watch = () => readVerifierStore(storePath).watches["12"]!;
    return { storePath, clock, gate, decide, acceptanceFile, watch };
  }

  it("opens the watch, records the acceptance check once at +1h, and ends verified at +24h", async () => {
    const { storePath, clock, gate, decide, acceptanceFile, watch } = watched();
    const criteria = [
      { criterion: "the settings page loads for the test account", result: "passed", evidence: "screenshot settings.png" },
      { criterion: "saving a setting persists it", result: "passed", detail: "reloaded and saw it", evidence: "screenshot saved.png" },
    ];

    // +1h: the poll that opens the watch hands over its first check-in, with evidence.
    clock.now = T0 + HOUR;
    expect(await verifierPoll(gate)).toEqual({ work: true, why: caseOf(1) });
    expect(watch()).toMatchObject({ pr: 12, ticket: 184, deployId: "dpl_1", verdict: null });
    expect(readVerifierStore(storePath).leases["12@1"]).toMatchObject({ run: "run-1", loop: "sent" });
    expect(watch().checkIns[0]!.result!.evidence).toMatchObject({
      health: { reachable: true, issues: [] },
      traffic: { reachable: true, hits: 42 },
      pr: { number: 12, routes: ["/settings"] },
    });
    const first = await decide(1, acceptanceFile(criteria));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("PR #12 +1h → pending");
    // Decided, so its lease is gone: nothing left for the heartbeat to renew.
    expect(readVerifierStore(storePath).leases).toEqual({});

    // +6h: handed over and decided by the acceptance check already recorded; a second one is refused.
    clock.now = T0 + 6 * HOUR;
    expect(await verifierPoll(gate)).toEqual({ work: true, why: caseOf(6) });
    const again = await decide(6, acceptanceFile(criteria));
    expect(again.code).toBe(4);
    expect(again.stderr).toContain("acceptance check was already recorded at +1h");
    const sixth = await decide(6);
    expect(sixth.code, sixth.stderr).toBe(0);
    expect(sixth.stdout).toContain("PR #12 +6h → pending");

    // +24h: the last check-in ends the watch.
    clock.now = T0 + 24 * HOUR;
    expect(await verifierPoll(gate)).toEqual({ work: true, why: caseOf(24) });
    const last = await decide(24);
    expect(last.code, last.stderr).toBe(0);
    expect(last.stdout).toContain("watch ended verified");
    expect(watch().verdict?.verdict).toBe("verified");
    expect(watch().checkIns[0]!.result!.acceptance).toEqual(criteria);
    expect(watch().checkIns.slice(1).map((c) => c.result!.acceptance)).toEqual([undefined, undefined]);
  });

  it("ends inconclusive, never ticket, when the acceptance check could not run", async () => {
    const { clock, gate, decide, acceptanceFile, watch } = watched();
    const why = "inconclusive: this host has no screenshot credential for the test account";
    for (const offset of [1, 6, 24]) {
      clock.now = T0 + offset * HOUR;
      expect(await verifierPoll(gate)).toEqual({ work: true, why: caseOf(offset) });
      const ran = await decide(offset, offset === 1 ? acceptanceFile({ inconclusive: why }) : []);
      expect(ran.code, ran.stderr).toBe(0);
    }
    expect(watch().checkIns[0]!.result!.acceptanceInconclusive).toBe(why);
    expect(watch().verdict?.verdict).toBe("inconclusive");
  });
});

/*
 * One sentinel issue, reporter to drafted ticket (#681): a new Sentry issue
 * over the threshold, read through the real Sentry adapter over the emulated
 * API, the gate recording it and handing it over with its evidence, and the
 * session's `sentinel/issue.ts show` and `draft` reading and recording it in
 * observe mode. As for the verifier, the gate and the session meet only at the
 * issue store, so both are driven in-process against one temp store on the
 * contract's fixed clock. The session's journal entry then goes through the
 * real publisher to a bare origin, as every iteration's does.
 */
describe("a sentinel issue, from the reporter to a drafted ticket", () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, "fixtures", "loggd", ".ralph", "config.json"), "utf8"));
  const rules = sentinelRules(parseProjectConfig(JSON.stringify({
    ...config,
    // loggd rosters senti itself since loggd#2909; add it only to a mirror
    // from before that, so the roster never names the loop twice.
    loops: config.loops.some((loop: { name?: string }) => loop.name === "senti")
      ? config.loops
      : [...config.loops, { name: "senti", role: "sentinel" }],
    // Mode left out: the default, observe, is what a new sentinel runs in.
    sentinel: { reporter: { kind: "sentry", org: "acme", project: "web", environment: "production" } },
  })))!;

  it("hands the issue over with its evidence, records the draft in observe mode and journals it", async () => {
    const root = mkdtempSync(join(tmpdir(), "ralph-e2e-sentinel-"));
    scratchRoots.push(root);
    const storePath = join(root, "sentinel-issues.json");
    const now = () => NOW;
    const frames = [seedFrame(1), seedFrame(2), seedFrame(4)];
    const inApp = frames.find((frame) => frame.inApp)!;
    const issue = seedIssue("7001", 2, {
      title: "TypeError: cart is undefined",
      firstSeen: hoursAgo(3),
      environment: "production",
      // Over the ten-event bar, inside the day's lookback.
      events: seedEvents(12, 2, ["u1", "u2", "u3"]),
      frames,
      breadcrumbs: [seedBreadcrumb(1, "opened the cart"), seedBreadcrumb(2, "clicked pay")],
    });
    const reporter = createSentryReporter({
      org: "acme",
      project: "web",
      environment: "production",
      token: "tok",
      fetcher: sentryEmulator(seedOf([issue])),
    });
    const gate: SentinelPollDeps = {
      rules,
      reporter: { read: reporter },
      storePath,
      now,
      holder: { run: "run-1", loop: "senti", pid: 4242, host: "test-host" },
    };
    const key = "sentry:7001";

    const handed = await sentinelPoll(gate);
    expect(handed).toEqual({ work: true, why: `sentinel issue ${key} — TypeError: cart is undefined` });
    expect(readSentinelStore(storePath).leases[key]).toMatchObject({ run: "run-1", loop: "senti" });

    // The session: what ralph.sh hands it in RALPH_INTAKE_CASE is the gate's work line.
    const session = (argv: string[]) => runSentinelIssue(argv, { storePath, rules, env: { RALPH_INTAKE_CASE: handed.why }, now });
    const shown = await session(["show"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(inApp.file);
    expect(shown.stdout).toContain(issue.permalink);
    expect(shown.stdout).toContain("clicked pay");

    const bodyFile = join(root, "draft-body.md");
    writeFileSync(bodyFile, "## What breaks\n\nThe checkout throws when the cart is undefined.\n");
    const title = "Checkout throws when the cart is undefined";
    const drafted = await session(["draft", "--title", title, "--body-file", bodyFile]);
    expect(drafted.code, drafted.stderr).toBe(0);
    expect(drafted.stdout).toContain(`drafted ${key} (observe mode: recorded what would have been filed; nothing written to the tracker)`);
    const store = readSentinelStore(storePath);
    expect(store.issues[key]).toMatchObject({ state: "drafted", mode: "observe", ticket: null, draft: { title, body: readFileSync(bodyFile, "utf8") } });
    // Drafted, so its lease is gone: nothing left for the heartbeat to renew.
    expect(store.leases).toEqual({});

    // The next poll leaves it alone: drafted is handled.
    const idle = await sentinelPoll(gate);
    expect(idle.work).toBe(false);
    expect(idle.why).toContain("already drafted");

    // The session's journal entry, through the real publisher.
    const home = join(root, "home");
    const project = join(root, "project");
    const remote = join(root, "origin.git");
    mkdirSync(home); mkdirSync(project);
    // The publisher checks RALPH_LOOP_NAME against the roster, and a sentinel on a roster needs its block.
    for (const dir of [home, project]) {
      writeProjectConfig(dir, ["ralph", { name: "senti", role: "sentinel" }]);
      const file = join(dir, ".ralph", "config.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), sentinel: { reporter: { kind: "sentry", org: "acme", project: "web" } } }));
    }
    const env = fixtureGitEnv({
      GIT_AUTHOR_NAME: "Sentinel Test", GIT_AUTHOR_EMAIL: "sentinel@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test", GIT_COMMITTER_EMAIL: "sentinel@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      RALPH_PROJECT: project, RALPH_LOOP_NAME: "senti",
      RALPH_JOURNAL_HOME: home, RALPH_JOURNAL_WORKTREE: join(root, "publisher"),
      RALPH_JOURNAL_LOCK: join(root, "publisher.lock"),
    });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    git(home, "init", "--quiet", "--initial-branch=main");
    git(home, "add", "."); git(home, "commit", "--quiet", "-m", "init");
    git(home, "remote", "add", "origin", remote); git(home, "push", "--quiet", "-u", "origin", "main");
    const logs = join(project, ".ralph", "logs");
    mkdirSync(logs, { recursive: true });
    const name = "20261104T120000Z-none-a1b2c3d4e5f6.md";
    const draft = join(logs, `journal-draft-${name}`);
    writeFileSync(draft, `# 2026-11-04 — sentinel ${key} TypeError: cart is undefined\n\n**Outcome: drafted ${key}** in observe mode; nothing filed.\n`);
    const published = spawnSync(BUN, [join(REPO_ROOT, "publish-journal.ts"), "--draft", draft, "--issue", "none"], {
      cwd: project, env, encoding: "utf8", timeout: 60_000,
    });
    expect(published.status, published.stdout + published.stderr).toBe(0);
    expect(git(remote, "ls-tree", "--name-only", "main", "journal/fixture/").trim()).toBe(`journal/fixture/${name}`);
    expect(git(remote, "show", `main:journal/fixture/${name}`)).toContain(`**Outcome: drafted ${key}**`);
  }, 60_000);
});

/*
 * One real, unmodified `ralph.sh` coder iteration inside a trial sandbox
 * (#530): the supervisor, the real frontier, `delegate.sh` and the PR wait all
 * run, against a local bare origin, the fake gh and a file tracker. Only the
 * two models are fakes — one `claude` script that plays the orchestrator by
 * driving the real harness tools, and the executor by writing the change. It
 * proves the sandbox carries a whole iteration and that nothing it did left
 * the scratch dir: no operator log, no live lease or claim, no real gh, Orca
 * or Doppler, no plugin.
 */
describe("a real ralph.sh iteration inside a trial sandbox", () => {
  /** A git common dir: where the leases and claim locks live. */
  const commonDir = (repo: string): string =>
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, env: fixtureGitEnv(), encoding: "utf8" }).trim();
  /** Every `ralph-*` file in a common dir, by name and size: exact, for a repo nothing else writes. */
  const leaseFacts = (repo: string): string =>
    execFileSync("bash", ["-c", 'for f in "$1"/ralph-*; do [ -e "$f" ] && stat -c "%n %s" "$f"; done; true', "_", commonDir(repo)], { encoding: "utf8" });
  /**
   * The `ralph-*` files in a common dir that name the trial. Not a before/after
   * comparison: live loops' heartbeats rewrite this checkout's lease stores
   * every 30 s. A trial's lease or claim would carry its scratch path, its
   * run id, or its loop as `claim-lease.ts` spells one (`"loop": "trial"`,
   * the `trial-wip` claim label).
   */
  const leasesNaming = (repo: string, marks: string[]): string[] => {
    const common = commonDir(repo);
    return readdirSync(common).filter((name) => {
      if (!name.startsWith("ralph-")) return false;
      try {
        const text = readFileSync(join(common, name), "utf8");
        return marks.some((mark) => text.includes(mark)) || /"loop":\s*"trial"/.test(text) || text.includes("trial-wip");
      } catch {
        return false;
      }
    });
  };
  /**
   * This checkout's `.ralph/logs` files written since `since` that name the
   * trial. Not a before/after listing: when a loop runs this suite as its
   * gate, that loop's own supervisor appends to its logs meanwhile, and that
   * is no leak. Anything the trial wrote would carry its scratch path or run id.
   */
  const operatorLogsNaming = (since: number, marks: string[]): string[] => {
    const out = execFileSync("bash", ["-c", 'cd "$1" 2>/dev/null && find . -type f -newermt "@$2" -print; true', "_", join(REPO_ROOT, ".ralph", "logs"), String(Math.floor(since / 1000) - 1)], { encoding: "utf8" });
    return out.split("\n").filter((name) => {
      if (name === "") return false;
      try {
        const text = readFileSync(join(REPO_ROOT, ".ralph", "logs", name), "utf8");
        return marks.some((mark) => text.includes(mark));
      } catch {
        return false;
      }
    });
  };

  const writeExecutable = (path: string, lines: string[]): void => {
    writeFileSync(path, `${lines.join("\n")}\n`);
    chmodSync(path, 0o755);
  };

  /** One trial's scratch dir: the project, a HOME, the fake `claude`, the verifiers and the claude's notes. */
  interface SandboxFixture {
    scratch: string;
    source: string;
    home: string;
    bin: string;
    verifierBin: string;
    verifier: string;
    argvLog: string;
    state: string;
    git: (cwd: string, ...args: string[]) => string;
  }

  const sandboxFixture = (): SandboxFixture => {
    const scratch = mkdtempSync(join(tmpdir(), "ralph-e2e-trial-"));
    scratchRoots.push(scratch);
    const source = join(scratch, "app");
    const home = join(scratch, "home");
    const bin = join(scratch, "bin");
    const verifierBin = join(scratch, "verifier-bin");
    const verifier = join(scratch, "leaked.log");
    const argvLog = join(scratch, "claude-argv.log");
    const state = join(scratch, "claude-state");
    for (const dir of [join(source, ".ralph"), home, bin, verifierBin, state]) mkdirSync(dir, { recursive: true });
    writeFileSync(verifier, "");
    writeFileSync(argvLog, "");
    const env = fixtureGitEnv({ HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, encoding: "utf8" }).trim();

    writeFileSync(join(source, ".ralph", "config.json"), JSON.stringify({
      repo: "trial/app",
      owner: "ralph-trial",
      baseBranch: "main",
      displayName: "Trial app",
      secrets: { runner: "none", withhold: [] },
      refuseFiles: [],
      envCheck: [],
      // A real project's CI name, which nothing in a trial reports: the sandbox
      // maps it to the gates' `trial/<gate>` checks, or the PR wait never ends.
      requiredChecks: ["buildkite/app"],
      // A real gate, cheap and observable: green only on a head carrying the change.
      gates: { added: "test -f added.txt" },
      promptFragment: ".ralph/prompt.md",
      coderFragment: ".ralph/coder.md",
      plan: ".ralph/plan.md",
      journal: { dir: "journal/app" },
      loops: ["ralph"],
    }, null, 2));
    // Fragments in the sectioned shape `models.ts` places: `delegate.sh`
    // renders the executor's rails from the coder one and refuses a bare file.
    writeFileSync(join(source, ".ralph", "prompt.md"), "prompt\n");
    writeFileSync(join(source, ".ralph", "coder.md"), "<!-- ralph:section RAILS -->\n- Touch only what the brief names.\n");
    writeFileSync(join(source, ".ralph", "plan.md"), "plan\n");
    writeFileSync(join(source, "README.md"), "app\n");
    git(scratch, "init", "--quiet", "--initial-branch=main", source);
    git(source, "add", ".");
    git(source, "commit", "--quiet", "-m", "initial");

    // Behind only the fake gh, which shadows `gh`: each must never run.
    for (const tool of ["gh", "orca", "doppler"]) {
      writeExecutable(join(verifierBin, tool), ["#!/bin/sh", `printf '${tool} %s\\n' "$*" >> ${JSON.stringify(verifier)}`, "exit 1"]);
    }
    return { scratch, source, home, bin, verifierBin, verifier, argvLog, state, git };
  };

  /**
   * The orchestrator and the executor, both `claude`. Each turn is one result
   * line in the stream-json shape `ralph.sh` reads; the orchestrator drives
   * the REAL harness tools, so the only fake thing is the model. `orchestrator`
   * is its body, with `emit` and `$st` (the notes dir) in scope.
   */
  const writeClaude = (fx: SandboxFixture, orchestrator: string[]): void => {
    writeExecutable(join(fx.bin, "claude"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$(printf '%s ' "$@" | tr -d '\\n')" >> ${JSON.stringify(fx.argvLog)}`,
      "emit() { printf '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"%s\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0},\"permission_denials\":[]}\\n' \"$1\"; }",
      'if [ "$1 $2" = "auth status" ]; then echo \'{"loggedIn":true}\'; exit 0; fi',
      'case " $* " in *claude-executor-settings.json*) echo trial > added.txt; emit "wrote added.txt"; exit 0;; esac',
      `st=${JSON.stringify(fx.state)}`,
      ...orchestrator,
    ]);
  };

  /** Session 1: claim through the real frontier, commit added.txt (through `delegate.sh` when asked), push, open the PR, wait on it. */
  const claimAndOpenPr = (delegate: boolean): string[] => [
    'selection="$(bun "$RALPH_HOME/frontier/next.ts" --take-one 2>> "$st/frontier.err")"',
    'printf \'%s\\n\' "$selection" > "$st/selection.json"',
    "ticket=\"$(printf '%s' \"$selection\" | bun -e 'const pick = JSON.parse(await Bun.stdin.text()); if (pick.claimed && pick.ticket !== null) process.stdout.write(String(pick.ticket));')\"",
    '[ -n "$ticket" ] || { emit "<ralph>NEEDS_TRIAGE</ralph>"; exit 0; }',
    'printf \'%s\' "$ticket" > "$st/ticket"',
    'branch="$RALPH_LOOP_NAME/$ticket-trial"',
    'git checkout --quiet -b "$branch"',
    ...(delegate
      ? [
          'printf "Add added.txt\\n" > "$st/brief.md"',
          '"$RALPH_HOME/delegate.sh" "$st/brief.md" > "$st/delegate.out" 2>&1; echo "$?" > "$st/delegate.exit"',
        ]
      : ["echo trial > added.txt"]),
    "git add added.txt && git -c user.name=trial -c user.email=trial@example.invalid commit --quiet -m \"trial: add added.txt (#$ticket)\"",
    'git push --quiet origin "$branch" 2>> "$st/push.err"',
    'gh pr create --base main --head "$branch" --title "trial: add added.txt" --body "Closes #$ticket" >> "$st/pr-create.out" 2>&1',
    "pr=\"$(gh pr list --head \"$branch\" --json number --jq '.[0].number')\"",
    'printf \'%s\' "$pr" > "$st/pr"',
    'emit "<ralph>AWAIT_PR $pr ci</ralph>"',
  ];

  const LINEUP = {
    orchestrator: { model: "fake-orchestrator-model", runner: "claude" },
    executor: { model: "fake-executor-model", runner: "claude" },
  } as const;

  const TICKET = { number: 7, title: "Add added.txt", body: "## Acceptance criteria\n\n- [ ] added.txt exists\n" };

  type SandboxTrial = Awaited<ReturnType<typeof buildTrial>>;
  type SandboxResult = Awaited<ReturnType<typeof runTrial>>;

  /** Runs the trial, and reads back its run id and a transcript for a failure to read. */
  const runSandbox = async (fx: SandboxFixture, trial: SandboxTrial, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ result: SandboxResult; transcript: string; runId: string | null }> => {
    const result = await runTrial(trial, {
      timeoutMs: 150_000,
      env: {
        // The verifiers ahead of the host's own tools: a real Doppler or Orca
        // installed here would otherwise answer first and the leak go unseen.
        PATH: `${FAKE_GH_BIN}:${fx.bin}:${fx.verifierBin}:${process.env.PATH ?? ""}`,
        RALPH_PR_WAIT_ARGS: "--interval 1 --grace 0",
        ...extraEnv,
      },
    });
    // What the fake claude saw of the tools it drove, beside the trial's own logs.
    const notes = readdirSync(fx.state).map((name) => `--- claude-state/${name}\n${readFileSync(join(fx.state, name), "utf8")}`);
    const transcript = [...result.logs.map((log) => `--- ${log.path}\n${log.text}`), ...notes].join("\n");
    const runId = /run (\S+-run-\S+) —/.exec(result.logs.find((log) => log.path === "trial.log")?.text ?? "")?.[1] ?? null;
    return { result, transcript, runId };
  };

  /** Nothing the trial did is left outside its scratch dir: no operator log, lease or claim, no verifier run. */
  const expectNoLeaks = (fx: SandboxFixture, trial: SandboxTrial, started: number, sourceLeasesBefore: string, runId: string | null): void => {
    // Both unique to this run: a fixed string would match the live loop's own
    // transcript of whoever last read this suite's output.
    expect(operatorLogsNaming(started, [trial.root, ...(runId ? [runId] : [])])).toEqual([]);
    expect(leasesNaming(REPO_ROOT, [trial.root, ...(runId ? [runId] : [])])).toEqual([]);
    expect(leasesNaming(fx.source, [trial.root])).toEqual([]);
    expect(leaseFacts(fx.source)).toBe(sourceLeasesBefore);
    expect(readFileSync(fx.verifier, "utf8")).toBe("");
  };

  type SandboxGithub = {
    prs: { number: number; head: string; headRefOid: string; heads: { sha: string; checks?: { name: string; conclusion: string }[] | null }[] }[];
    mergeAttempts: { pr: number | null; argv: string[] }[];
  };

  it("claims, delegates, pushes, opens a PR, reads the gates as checks, and has its merge refused", async () => {
    const fx = sandboxFixture();
    const { state, argvLog, source, home, scratch, git } = fx;
    writeClaude(fx, [
      'if [ -s "$st/pr" ]; then',
      '  gh pr merge "$(cat "$st/pr")" --squash >> "$st/merge.out" 2>&1; echo "$?" > "$st/merge.status"',
      '  emit "<ralph>DONE</ralph>"; exit 0',
      "fi",
      ...claimAndOpenPr(true),
    ]);

    const started = Date.now();
    const before = { source: leaseFacts(source) };
    const trial = await buildTrial({
      source,
      base: "main",
      home,
      // No `harness`: the shipped default, this checkout, staged as a non-git copy.
      scratchParent: scratch,
      ticket: TICKET,
      lineup: LINEUP,
    });
    let runId: string | null = null;
    try {
      const run = await runSandbox(fx, trial);
      const { result, transcript } = run;
      runId = run.runId;
      expect(result.outcome, transcript).toMatchObject({ kind: "finished", sigil: "<ralph>DONE</ralph>" });
      expect(runId).not.toBeNull();

      // The executor ran through the real delegate.sh, on the lineup's model.
      expect(readFileSync(join(state, "delegate.exit"), "utf8").trim(), transcript).toBe("0");
      const argv = readFileSync(argvLog, "utf8");
      expect(argv).toContain("--model fake-orchestrator-model");
      expect(argv).toMatch(/--model fake-executor-model .*claude-executor-settings\.json/);
      expect(result.models).toEqual(expect.arrayContaining([
        { stage: "orchestrator", model: "fake-orchestrator-model", runner: "claude" },
        { stage: "executor", model: "fake-executor-model", runner: "claude" },
      ]));

      // Pushed to the local bare origin, and opened as the fake's one PR at that head.
      const github = result.github as SandboxGithub;
      expect(github.prs).toHaveLength(1);
      const [pr] = github.prs;
      expect(pr!.head).toBe("trial/7-trial");
      expect(result.finalHead).toBe(pr!.headRefOid);
      expect(git(trial.origin, "rev-parse", "refs/heads/trial/7-trial")).toBe(result.finalHead);
      expect(result.patch).toMatch(/^\+\+\+ b\/added\.txt$/m);
      // Its checks are the gates, run on that head, and green.
      expect(pr!.heads.find((head) => head.sha === pr!.headRefOid)?.checks).toEqual([{ name: "trial/added", conclusion: "SUCCESS" }]);
      expect(readFileSync(trial.log, "utf8")).toMatch(/PR #1 wait ended: green\./);
      // The default review is the local Revisión Claude, and this project has
      // no revision-claude.yml: the head is unreviewed, never a clean round.
      expect(result.review, transcript).toMatchObject({ roundCount: 0, unreviewedHeads: [pr!.headRefOid] });
      expect(result.review?.heads.find((head) => head.sha === pr!.headRefOid)?.status).toBe("unavailable");
      // The merge was attempted, recorded and refused.
      expect(github.mergeAttempts).toEqual([expect.objectContaining({ pr: 1 })]);
      expect(readFileSync(join(state, "merge.status"), "utf8").trim()).toBe("1");

      // The real frontier claimed the ticket in the local tracker for the trial loop.
      const tracker = result.tracker as { issues: { number: number; labels: string[]; status?: string }[] };
      expect(tracker.issues.find((issue) => issue.number === 7)?.labels).toContain("trial-wip");

      // No plugin ran: the host records every plugin it offers an event to.
      expect(result.logs.map((log) => log.path)).not.toContain("work/.ralph/logs/plugins.json");
      // The staged harness is not where the iteration kept its state.
      expect(existsSync(join(trial.harness, ".ralph"))).toBe(false);
    } finally {
      disposeTrial(trial);
    }
    expectNoLeaks(fx, trial, started, before.source, runId);
  }, 180_000);

  /**
   * The real `--take-one` hands a coder a drained `## Parent closure
   * exceptions` parent when its frontier is empty (#810): label-only, leased,
   * marked `closure: true`, and fenced off a second loop's `--take-one`. Two
   * loops once closed #132 eleven seconds apart because nothing claimed it.
   */
  it("claims a drained closure parent through the real --take-one, label-only, and fences it off a second loop", async () => {
    const fx = sandboxFixture();
    const { state, source, home, scratch, git } = fx;
    // This case's plan only: #7 is the closure parent, and has no children.
    // The trial's tracker is keyed, so its references read `TRIAL-7`, never `#7`.
    writeFileSync(join(source, ".ralph", "plan.md"), "plan\n\n## Parent closure exceptions\n\n- TRIAL-7\n");
    git(source, "commit", "--quiet", "-am", "plan: TRIAL-7 is a closure parent");
    writeClaude(fx, [
      // Off the queue, so the ordinary frontier is empty and the closure is the only offer.
      'bun "$RALPH_HOME/tracker.ts" label remove 7 ready-for-agent > "$st/unready.out" 2>&1',
      'bun "$RALPH_HOME/frontier/next.ts" --take-one > "$st/selection.json" 2>> "$st/frontier.err"',
      // The lease store as the claim left it, before anything at iteration end can release it.
      'cp "$(git rev-parse --path-format=absolute --git-common-dir)/ralph-claim-leases.json" "$st/leases.json" 2>> "$st/frontier.err"',
      // A second loop, on the roster for this one call only: the sandbox's roster is the trial loop alone.
      "cp .ralph/config.json \"$st/config.json\"",
      "bun -e 'const f = \".ralph/config.json\"; const c = JSON.parse(await Bun.file(f).text()); c.loops = [...c.loops, \"rival\"]; await Bun.write(f, JSON.stringify(c, null, 2) + \"\\n\");'",
      'RALPH_LOOP_NAME=rival RALPH_RUN_ID="$RALPH_RUN_ID-rival" bun "$RALPH_HOME/frontier/next.ts" --take-one > "$st/second.json" 2>> "$st/frontier.err"',
      "cp \"$st/config.json\" .ralph/config.json",
      'emit "<ralph>DONE</ralph>"',
    ]);

    const started = Date.now();
    const before = { source: leaseFacts(source) };
    const trial = await buildTrial({ source, base: "main", home, scratchParent: scratch, ticket: TICKET, lineup: LINEUP });
    let runId: string | null = null;
    try {
      const run = await runSandbox(fx, trial);
      const { result, transcript } = run;
      runId = run.runId;
      expect(result.outcome, transcript).toMatchObject({ kind: "finished", sigil: "<ralph>DONE</ralph>" });

      const selection = JSON.parse(readFileSync(join(state, "selection.json"), "utf8")) as Record<string, unknown>;
      expect(selection, transcript).toMatchObject({ ticket: 7, closure: true, claimed: true });

      // Claimed by label only: the trial loop's -wip, and no move to in progress.
      const tracker = result.tracker as { issues: { number: number; labels: string[]; status?: string }[] };
      const parent = tracker.issues.find((issue) => issue.number === 7);
      expect(parent?.labels, transcript).toContain(`${trial.loopName}-wip`);
      expect(parent?.status).not.toBe("In Progress");

      // Leased in the trial work tree's own common dir.
      const store = JSON.parse(readFileSync(join(state, "leases.json"), "utf8")) as { leases: Record<string, { issue: number; loop: string }> };
      expect(Object.values(store.leases), transcript).toEqual(expect.arrayContaining([expect.objectContaining({ issue: 7, loop: trial.loopName })]));

      // The second loop meets the claim: no closure, and never #7.
      const second = JSON.parse(readFileSync(join(state, "second.json"), "utf8")) as Record<string, unknown>;
      expect(second, transcript).not.toHaveProperty("closure");
      expect(second.ticket).not.toBe(7);
      // Refused by the fence, not by a roster or tracker error that would pass the two lines above too.
      expect(second).toMatchObject({ loop: "rival", error: null });
    } finally {
      disposeTrial(trial);
    }
    expectNoLeaks(fx, trial, started, before.source, runId);
  }, 180_000);

  it("keeps the trial's speed ledger under its root: claimed, the iteration, and the hand-off with its PR", async () => {
    const fx = sandboxFixture();
    const { state, source, home, scratch } = fx;
    writeClaude(fx, [
      // Session 2: the PR is green; hand the ticket off the way a merge: "human" project does.
      'if [ -s "$st/pr" ]; then',
      "  url=\"$(gh pr view \"$(cat \"$st/pr\")\" --json url --jq .url)\"",
      '  printf \'%s\' "$url" > "$st/pr-url"',
      '  bun "$RALPH_HOME/tracker.ts" handoff "$(cat "$st/ticket")" --pr "$url" > "$st/handoff.out" 2>&1; echo "$?" > "$st/handoff.exit"',
      '  emit "<ralph>DONE</ralph>"; exit 0',
      "fi",
      ...claimAndOpenPr(false),
    ]);

    const started = Date.now();
    const before = { source: leaseFacts(source) };
    const trial = await buildTrial({ source, base: "main", home, scratchParent: scratch, ticket: TICKET, lineup: LINEUP });
    let runId: string | null = null;
    try {
      const run = await runSandbox(fx, trial);
      const { result, transcript } = run;
      runId = run.runId;
      expect(result.outcome, transcript).toMatchObject({ kind: "finished", sigil: "<ralph>DONE</ralph>" });
      expect(readFileSync(join(state, "handoff.exit"), "utf8").trim(), transcript).toBe("0");
      const url = readFileSync(join(state, "pr-url"), "utf8").trim();
      expect(url).toMatch(/^https:\/\/github\.com\/.+\/pull\/1$/);

      const speed = result.speed ?? [];
      const kinds = speed.filter((event) => event.ticket === "7").map((event) => event.kind);
      // The iteration starts before the claim, so its start carries no ticket.
      expect(kinds, JSON.stringify(speed)).toEqual(["claimed", "handed-off", "iteration-end"]);
      const order = (kind: string): number => speed.findIndex((event) => event.kind === kind);
      expect(order("iteration-start")).toBeGreaterThanOrEqual(0);
      expect(order("iteration-start")).toBeLessThan(order("claimed"));
      expect(order("claimed")).toBeLessThan(order("handed-off"));
      expect(order("handed-off")).toBeLessThan(order("iteration-end"));
      expect(speed.find((event) => event.kind === "handed-off")).toMatchObject({ ticket: "7", pr: url, loop: "trial" });
      expect(speed.find((event) => event.kind === "iteration-end")).toMatchObject({ ticket: "7", outcome: "DONE" });
      // The ledger is the trial's own: under its root, never a git common dir.
      expect(existsSync(join(trial.root, "speed"))).toBe(true);
    } finally {
      disposeTrial(trial);
    }
    expectNoLeaks(fx, trial, started, before.source, runId);
  }, 180_000);

  /**
   * A loop started while the secrets manager is down recovers in the same run
   * (#759 AC7). The reconciler starts loops at boot, before the login keyring
   * unlocks (2026-10-29), and nobody is there to restart them: the startup
   * read of the coder's Buildkite token fails and the preflight's scope check
   * fails, and the run still records no failure stop, waits instead, and
   * hands the token to its iteration once Doppler answers.
   */
  it("starts with the secrets manager down, then reads the unread token on retry and hands it to the iteration, with no restart", async () => {
    const fx = sandboxFixture();
    const { state, source, home, scratch, git } = fx;
    const token = "bkua_e2e-reread-0123456789abcdef0123";
    // The project now runs under Doppler. The scope names are the fake's only.
    const config = JSON.parse(readFileSync(join(source, ".ralph", "config.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(source, ".ralph", "config.json"), JSON.stringify({
      ...config,
      secrets: { runner: "doppler", project: "trial-app", config: "dev", withhold: [] },
    }, null, 2));
    git(source, "commit", "--quiet", "-am", "run under doppler");

    // The manager, down at start: its first two calls — the startup read of
    // the token and the preflight's first scope check — fail the way a login
    // keyring still locked at boot does, and every later call answers. One
    // outage across every kind of call, counted in a file, so "later" is an
    // order of calls rather than a clock. `run` is a pass-through, so the
    // iteration's environment is the supervisor's filter.
    const locked = "Doppler Error: failed to unlock correct collection '/org/freedesktop/secrets/collection/login'";
    writeExecutable(join(fx.bin, "doppler"), [
      "#!/usr/bin/env bash",
      `st=${JSON.stringify(state)}`,
      // Names and flags only: a value is never an argument.
      'printf \'%s\\n\' "$*" >> "$st/doppler-argv.log"',
      // Each call takes its own ordinal by creating the first free file under
      // noclobber, an exclusive create: the iteration starts several `doppler
      // run`s at once, a read-then-rewrite counter let one read the file
      // mid-rewrite (PR #54's CI), and append-then-count gives a call the
      // file's length at its read, not its own position.
      'n=1; until ( set -C; : > "$st/doppler-call.$n" ) 2>/dev/null; do n=$((n + 1)); done',
      `[ "$n" -le 2 ] && { echo ${JSON.stringify(locked)} >&2; exit 1; }`,
      'case "$1 $2" in',
      '  "secrets get")',
      `    [ "$3" = RALPH_BUILDKITE_READ_TOKEN ] && { printf '%s' ${JSON.stringify(token)}; exit 0; }`,
      '    echo "Doppler Error: Could not find requested secret: $3" >&2; exit 1 ;;',
      '  "secrets --only-names")',
      "    echo '{}'; exit 0 ;;",
      "  run\\ *)",
      '    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      '    shift; exec "$@" ;;',
      "esac",
      "exit 1",
    ]);
    // Whether the iteration got the token, as a word: never the value itself.
    writeClaude(fx, [
      `if [ "\${RALPH_BUILDKITE_READ_TOKEN:-}" = ${JSON.stringify(token)} ]; then echo match > "$st/bk-token"; else echo "missing" > "$st/bk-token"; fi`,
      'emit "<ralph>DONE</ralph>"',
    ]);

    const started = Date.now();
    const before = { source: leaseFacts(source) };
    const trial = await buildTrial({ source, base: "main", home, scratchParent: scratch, ticket: TICKET, lineup: LINEUP });
    // The token's check is a live Buildkite call (`bk-log.ts --check-token`);
    // the staged harness's copy answers it here, for this token alone.
    writeFileSync(join(trial.harness, "bk-log.ts"), [
      `if (process.argv[2] === "--check-token" && process.env.RALPH_BUILDKITE_READ_TOKEN === ${JSON.stringify(token)}) {`,
      '  console.log("bk-log: Buildkite token ok, read-only (read_builds)");',
      "  process.exit(0);",
      "}",
      'console.log("bk-log: the Buildkite token is not read-only; refusing to use it");',
      "process.exit(3);",
      "",
    ].join("\n"));
    let runId: string | null = null;
    try {
      const run = await runSandbox(fx, trial, { RALPH_PREFLIGHT_RETRY_SECONDS: "1" });
      const { result, transcript } = run;
      runId = run.runId;
      expect(result.outcome, transcript).toMatchObject({ kind: "finished", exit: 0, sigil: "<ralph>DONE</ralph>" });
      const log = readFileSync(trial.log, "utf8");
      // One supervisor, start to finish: nothing restarted it.
      expect(log.match(/run \S+-run-\S+ —/g) ?? [], transcript).toHaveLength(1);
      // Unread at start, not taken as absent, and read on retry.
      expect(log, transcript).toContain(`RALPH_BUILDKITE_READ_TOKEN could not be read from Doppler (${locked}`);
      expect(log).not.toContain("RALPH_BUILDKITE_READ_TOKEN is not in the secrets scope");
      expect(log.split("RALPH_BUILDKITE_READ_TOKEN read on retry — available to the iteration.")).toHaveLength(2);
      const reads = readFileSync(join(state, "doppler-argv.log"), "utf8").split("\n").filter((line) => line.startsWith("secrets get RALPH_BUILDKITE_READ_TOKEN "));
      expect(reads).toHaveLength(2);
      // The scope's outage held the start, without a failure or a claim.
      expect(log).toContain("an external dependency is unavailable (doppler-scope)");
      expect(log).not.toContain("preflight refused startup");
      expect(log).not.toContain("nothing was claimed.");
      expect(log).not.toMatch(/; stopping\./);
      // The one iteration ran, and with the token.
      expect(readFileSync(join(state, "bk-token"), "utf8").trim(), transcript).toBe("match");
      // The value reached the iteration and nothing that prints.
      expect(transcript).not.toContain(token);
    } finally {
      disposeTrial(trial);
    }
    expectNoLeaks(fx, trial, started, before.source, runId);
  }, 180_000);

  it("answers a review round: reads the thread, pushes a fix, replies Fixed in <sha>, and ends DONE on a clean round", async () => {
    const fx = sandboxFixture();
    const { state, source, home, scratch } = fx;
    // The review: one P2 finding on the first head it sees, none on any later one.
    const reviewed = join(scratch, "reviewed-heads");
    const review = join(scratch, "review-stub");
    writeExecutable(review, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$FAKE_GH_HEAD_SHA" >> ${JSON.stringify(reviewed)}`,
      `if [ "$(wc -l < ${JSON.stringify(reviewed)})" -eq 1 ]; then`,
      `  echo '[{"path":"added.txt","line":1,"priority":"P2","title":"added.txt says trial","body":"It should say fixed."}]'`,
      "else",
      "  echo '[]'",
      "fi",
    ]);
    writeClaude(fx, [
      // Session 3: the fix answered the thread, and the new head's round is clean.
      'if [ -s "$st/answered" ]; then',
      '  bun "$RALPH_HOME/review-threads.ts" "$(cat "$st/pr")" > "$st/threads-3.out" 2>&1; echo "$?" > "$st/threads-3.exit"',
      '  [ "$(cat "$st/threads-3.exit")" = 0 ] && emit "<ralph>DONE</ralph>" || emit "<ralph>FAILED threads still open</ralph>"',
      "  exit 0",
      "fi",
      // Session 2: the PR is open and unanswered; read its one thread, fix, reply.
      'if [ -s "$st/pr" ]; then',
      '  pr="$(cat "$st/pr")"',
      '  bun "$RALPH_HOME/review-threads.ts" "$pr" --json > "$st/threads-2.json" 2> "$st/threads-2.err"; echo "$?" > "$st/threads-2.exit"',
      "  read -r repo id <<< \"$(bun -e 'const t = JSON.parse(await Bun.stdin.text()); process.stdout.write(`${t.repo} ${t.open.length === 1 ? t.open[0].id : \"\"}`);' < \"$st/threads-2.json\")\"",
      '  [ -n "$id" ] || { emit "<ralph>FAILED no single open thread</ralph>"; exit 0; }',
      "  echo fixed > added.txt",
      '  git add added.txt && git -c user.name=trial -c user.email=trial@example.invalid commit --quiet -m "trial: fix added.txt"',
      '  git push --quiet origin HEAD 2>> "$st/push.err"',
      '  printf "Fixed in %s.\\n" "$(git rev-parse --short HEAD)" > "$st/reply.md"',
      '  gh api "repos/$repo/pulls/$pr/comments/$id/replies" -F body=@"$st/reply.md" > "$st/reply.out" 2>&1; echo "$?" > "$st/reply.exit"',
      '  printf "%s" "$id" > "$st/answered"',
      '  emit "<ralph>AWAIT_PR $pr ci</ralph>"; exit 0',
      "fi",
      ...claimAndOpenPr(false),
    ]);

    const started = Date.now();
    const before = { source: leaseFacts(source) };
    const trial = await buildTrial({ source, base: "main", home, scratchParent: scratch, ticket: TICKET, lineup: LINEUP, findingsCommand: review });
    let runId: string | null = null;
    try {
      const run = await runSandbox(fx, trial);
      const { result, transcript } = run;
      runId = run.runId;
      expect(result.outcome, transcript).toMatchObject({ kind: "finished", sigil: "<ralph>DONE</ralph>" });

      // The real review-threads.ts saw the one thread, then none once answered.
      expect(readFileSync(join(state, "threads-2.exit"), "utf8").trim(), transcript).toBe("1");
      expect(readFileSync(join(state, "reply.exit"), "utf8").trim(), transcript).toBe("0");
      expect(readFileSync(join(state, "threads-3.exit"), "utf8").trim(), transcript).toBe("0");

      // Two heads: the change, and the fix the thread asked for.
      const github = result.github as SandboxGithub;
      expect(github.prs).toHaveLength(1);
      expect(github.prs[0]!.heads, transcript).toHaveLength(2);
      expect(result.finalHead).toBe(github.prs[0]!.headRefOid);

      // Round 1 found one P2, round 2 found nothing; the thread was answered with the fix.
      const summary = result.review;
      expect(summary, transcript).not.toBeNull();
      expect(summary!.roundCount, transcript).toBe(2);
      expect(summary!.rounds.map((round) => [round.findings, round.priorities.P2])).toEqual([[1, 1], [0, 0]]);
      expect(summary!.threads).toHaveLength(1);
      expect(summary!.threads[0]).toMatchObject({ round: 1, priority: "P2", path: "added.txt", answer: "fix" });
      expect(summary!.answered).toEqual({ fix: 1, rebuttal: 0, unanswered: 0 });
      expect(summary!.capReached).toBe(false);
    } finally {
      disposeTrial(trial);
    }
    expectNoLeaks(fx, trial, started, before.source, runId);
  }, 240_000);

  /**
   * #771: a gated coder whose iteration refuted the gate's ticket holds at the
   * gate on that verdict instead of halting on a disagreement, and spawns on
   * the first poll that names something else.
   *
   * The REAL `frontier-gate.ts` and the REAL `gate-verdict-store.ts`, run by a
   * real `ralph.sh` from the trial's staged harness. Only the frontier's own
   * answer is scripted: the staged copy of `frontier/next.ts` (a non-git copy,
   * so nothing else reads it) prints the pick the gate's `--take-one
   * --dry-run` probe parses, from a file this test rewrites. Every other probe
   * the gate runs — open PRs, this loop's claims, the checkout — answers from
   * the trial's fake gh, its local tracker and its clone. That is the whole
   * hold decision on the real path; a scripted gate would only test the script.
   *
   * Spawned here rather than through `runTrial`, which runs `ralph.sh 1`: a
   * hold spends no iteration, so the session after it is iteration 2, and a
   * cap of 2 is what ends the run deterministically once that session is DONE.
   */
  describe("a gated coder that holds at the gate on a refuted verdict", () => {
    it("holds on the gate's ticket with no second session, then spawns once the verdict changes, with the record cleared first", async () => {
      const fx = sandboxFixture();
      const { state, source, home, scratch } = fx;
      // Session 1 refutes the gate's ticket; session 2 notes whether the
      // record was still on disk when it started, and ends the run.
      writeClaude(fx, [
        'n=$(( $(cat "$st/sessions" 2>/dev/null || echo 0) + 1 )); printf \'%s\' "$n" > "$st/sessions"',
        'if [ "$n" -eq 1 ]; then emit "<ralph>ALL_BLOCKED</ralph>"; exit 0; fi',
        'if [ -e .ralph/logs/gate-verdict.json ]; then echo held > "$st/record-at-session-2"; else echo none > "$st/record-at-session-2"; fi',
        'emit "<ralph>DONE</ralph>"',
      ]);

      const started = Date.now();
      const before = { source: leaseFacts(source) };
      const trial = await buildTrial({ source, base: "main", home, scratchParent: scratch, ticket: TICKET, lineup: LINEUP });
      const answer = join(scratch, "frontier-answer");
      const frontierCalls = join(scratch, "frontier-calls.log");
      writeFileSync(answer, "7\n");
      writeFileSync(frontierCalls, "");
      writeFileSync(join(trial.harness, "frontier", "next.ts"), [
        'import { appendFileSync, readFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(frontierCalls)}, process.argv.slice(2).join(" ") + "\\n");`,
        `const ticket = Number(readFileSync(${JSON.stringify(answer)}, "utf8").trim());`,
        'console.log(JSON.stringify({ ticket, title: `Ticket ${ticket}`, claimed: false, obstructed: [] }));',
        "",
      ].join("\n"));

      const env: NodeJS.ProcessEnv = {
        ...trialEnv(trial),
        PATH: `${FAKE_GH_BIN}:${fx.bin}:${fx.verifierBin}:${process.env.PATH ?? ""}`,
        RALPH_WAIT_FOR_WORK: "1",
        RALPH_CONTROL_POLL_SECONDS: "1",
      };
      expect(trialPreflight(trial, env)).toMatchObject({ ok: true });

      const out = join(scratch, "supervisor.out");
      const record = join(trial.work, ".ralph", "logs", "gate-verdict.json");
      const said = (): string => (existsSync(out) ? readFileSync(out, "utf8") : "");
      const sessions = (): number => readFileSync(fx.argvLog, "utf8").split("\n").filter((line) => line.includes("--model fake-orchestrator-model")).length;
      const holdingPolls = (): number => said().split("\n").filter((line) => line.includes("holding on an unchanged verdict (frontier ticket #7")).length;

      let runId: string | null = null;
      const fd = openSync(out, "a");
      const child = spawn("bash", [join(trial.harness, "ralph.sh"), "2"], { cwd: trial.work, env, detached: true, stdio: ["ignore", fd, fd] });
      closeSync(fd);
      supervisors.push(child);
      if (child.pid !== undefined) rememberSupervisor(child.pid);
      const exited = new Promise<number | null>((settle) => child.on("close", (code) => settle(code)));
      try {
        // The refusal became a hold on #7, on disk, and the gate polls on it.
        expect(await until(() => holdingPolls() >= 2, 60_000), said()).toBe(true);
        expect(said()).toContain("holding at the gate until its verdict changes (frontier ticket #7");
        expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ kind: "frontier-ticket", ticket: 7 });
        // No second session on the unchanged verdict, and no halt.
        expect(sessions(), said()).toBe(1);
        expect(said()).not.toContain("disagree persistently");
        expect(said()).not.toContain("iterations in a row found nothing");

        // The verdict changes: the next poll reports #8, and the loop spawns on it.
        writeFileSync(answer, "8\n");
        const code = await Promise.race([exited, new Promise<"timeout">((settle) => setTimeout(() => settle("timeout"), 60_000))]);
        expect(code, said()).toBe(0);
        expect(sessions(), said()).toBe(2);
        // Cleared before that session started, not merely by the end.
        expect(readFileSync(join(state, "record-at-session-2"), "utf8").trim(), said()).toBe("none");
        expect(existsSync(record)).toBe(false);
        expect(said()).toContain("frontier ticket #8");
        // Every frontier read was the gate's read-only probe.
        const calls = readFileSync(frontierCalls, "utf8").split("\n").filter((line) => line !== "");
        expect(calls.length).toBeGreaterThanOrEqual(4);
        expect(calls.every((line) => line.startsWith("--take-one --dry-run"))).toBe(true);
        runId = /run (\S+-run-\S+) —/.exec(said())?.[1] ?? null;
      } finally {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
          await exited;
        }
        disposeTrial(trial);
      }
      expectNoLeaks(fx, trial, started, before.source, runId);
    }, 180_000);
  });
});
