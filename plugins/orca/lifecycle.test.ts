// @vitest-environment node
/**
 * What the Orca mirror is allowed to tell Orca, and what it must never do to
 * the loop it is mirroring.
 *
 * Three properties carry most of these cases:
 *
 * 1. *It mirrors; it never places.* The end-to-end cases drive the real CLI as
 *    a subprocess against a fake `orca` that records every argument it is
 *    handed, and then assert on that log — because the guarantee under test is
 *    about the commands NOT run (`worker-start`, `dispatch --inject`,
 *    `terminal send`), and only a recording of the real invocations can prove
 *    a negative like that.
 * 2. *A replaced attempt cannot report.* The fence is checked before any Orca
 *    call, so the assertion is that the fake was never invoked at all.
 * 3. *An absent Orca costs the loop nothing.* No CLI, no terminal, and a
 *    refused mutation all have to end in a recorded reason and exit 0.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "../../dashboard/fixtures";

import {
  ALLOWED_VERBS,
  ORCA_STATE_RELATIVE_PATH,
  callOrca,
  fenceVerdict,
  issueFromBranch,
  lineFor,
  parseAdapterState,
  phaseFor,
  settlementFor,
  taskStatusFor,
  type AdapterState,
  type LifecycleEvent,
} from "./lifecycle";
import { ORCA_BINDING_RELATIVE_PATH } from "./binding";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs the Orca lifecycle hooks through bash and bun");

const REPO_ROOT = join(__dirname, "..", "..");

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const scratch = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `ralph-orca-lifecycle-${label}-`));
  scratchRoots.push(dir);
  return dir;
};

/** The bun running this suite, by absolute path — the fixtures replace PATH. */
const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const event = (over: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
  name: "iteration-start",
  run: "ralph-run-1",
  session: "session-a",
  ...over,
});

const state = (over: Partial<AdapterState> = {}): AdapterState => ({
  version: 1,
  ralphRun: "ralph-run-1",
  loop: "ralph",
  worktree: "/tmp/wt",
  terminal: "term_1",
  orcaRun: "run_1",
  task: null,
  attempt: null,
  degraded: null,
  displacedBinding: null,
  lastRejected: null,
  lastEvent: null,
  ...over,
});

describe("reading the ticket off the branch", () => {
  it("takes the issue from this loop's own branch, with or without a slug", () => {
    expect(issueFromBranch("ralph/702", "ralph")).toBe(702);
    expect(issueFromBranch("ralph/702-lifecycle-adapter", "ralph")).toBe(702);
    expect(issueFromBranch("rafa/660", "rafa")).toBe(660);
  });

  it("reads no ticket rather than a guessed one", () => {
    // Every one of these is a real state the supervisor sits in between
    // iterations, and a mirror that guessed would file an attempt against a
    // ticket this loop never claimed.
    expect(issueFromBranch("main", "ralph")).toBeNull();
    expect(issueFromBranch(null, "ralph")).toBeNull();
    expect(issueFromBranch("ralph/not-a-number", "ralph")).toBeNull();
    expect(issueFromBranch("feature/ralph/702", "ralph")).toBeNull();
  });

  it("does not read the other loop's branch as its own ticket", () => {
    expect(issueFromBranch("rafa/660", "ralph")).toBeNull();
  });
});

describe("the fence on late events", () => {
  it("lets a new supervisor replace the record", () => {
    const verdict = fenceVerdict(state({ ralphRun: "ralph-run-0" }), event({ name: "supervisor-start" }));
    expect(verdict).toEqual({ accept: true, restart: true });
  });

  it("refuses an event from a run this one replaced", () => {
    const verdict = fenceVerdict(state(), event({ name: "iteration-end", run: "ralph-run-0" }));
    expect(verdict.accept).toBe(false);
  });

  it("refuses an iteration older than the one now running", () => {
    const previous = state({ attempt: { index: 3, session: "session-c", dispatch: "ctx_3", ended: false } });
    expect(fenceVerdict(previous, event({ name: "iteration-end", iteration: 2 })).accept).toBe(false);
  });

  it("refuses a stale session on the iteration it was replaced within", () => {
    const previous = state({ attempt: { index: 3, session: "session-c", dispatch: "ctx_3", ended: false } });
    const late = event({ name: "iteration-end", iteration: 3, session: "session-b" });
    expect(fenceVerdict(previous, late).accept).toBe(false);
  });

  it("accepts the attempt that is actually running", () => {
    const previous = state({ attempt: { index: 3, session: "session-c", dispatch: "ctx_3", ended: false } });
    const live = event({ name: "iteration-end", iteration: 3, session: "session-c" });
    expect(fenceVerdict(previous, live)).toEqual({ accept: true, restart: false });
  });

  it("adopts a run it has no record of rather than blanking the board", () => {
    // The mirror enabled mid-run, or its file removed. Refusing here would
    // leave a working loop invisible for the rest of its run.
    expect(fenceVerdict(null, event({ name: "iteration-end" }))).toEqual({
      accept: true,
      restart: true,
    });
  });
});

describe("how an attempt ends", () => {
  it("reads a failure stop as a failed attempt and everything else as a finished one", () => {
    expect(settlementFor(event({ name: "no-sigil", stop: "failed" }))).toBe("failed");
    expect(settlementFor(event({ name: "stop", stop: "completed" }))).toBe("succeeded");
    // The loop stopping for want of work is not the attempt failing: the
    // iteration before it reached a sigil, which is why the loop got here.
    expect(settlementFor(event({ name: "stop", stop: "blocked" }))).toBe("succeeded");
    expect(settlementFor(event({ name: "frontier-wait" }))).toBe("succeeded");
  });

  it("calls a ticket the loop stopped on top of blocked, whichever way it stopped", () => {
    // Held and unfinished is a third ending `worker_done` has no word for: the
    // loop ran out of iterations, or found the frontier blocked, while still
    // standing on the ticket. Neither is done and neither is broken.
    expect(taskStatusFor("blocked", true)).toBe("blocked");
    expect(taskStatusFor("completed", true)).toBe("blocked");
    // A failure says so through the attempt's own report, which settles both.
    expect(taskStatusFor("failed", true)).toBeNull();
    // And a loop that had already left the ticket says nothing: the report
    // that released it settled it.
    expect(taskStatusFor("completed", false)).toBeNull();
    expect(taskStatusFor(undefined, true)).toBeNull();
  });

  it("names the phase after the supervisor's stage, and after the event when there is none", () => {
    expect(phaseFor(event({ stage: "iteration" }))).toBe("iteration");
    expect(phaseFor(event({ name: "cap-reached" }))).toBe("cap-reached");
  });
});

describe("the record", () => {
  it("treats every unusable file as no record at all", () => {
    expect(parseAdapterState("")).toBeNull();
    expect(parseAdapterState("{ half")).toBeNull();
    expect(parseAdapterState(JSON.stringify({ version: 2, ralphRun: "r" }))).toBeNull();
    expect(parseAdapterState(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it("drops fields it cannot use rather than the whole record", () => {
    const parsed = parseAdapterState(
      JSON.stringify({ version: 1, ralphRun: "r", attempt: { index: "two" }, task: { issue: 7 } }),
    );
    expect(parsed?.ralphRun).toBe("r");
    expect(parsed?.attempt).toBeNull();
    expect(parsed?.task).toBeNull();
  });
});

describe("the command guard", () => {
  it("allows notification delivery without widening into placement", () => {
    expect(ALLOWED_VERBS).toContain("orchestration send");
  });

  it("refuses a verb that would place a process rather than record one", () => {
    // The point of the allowlist: `worker-start` and `dispatch --inject` both
    // launch an Orca-managed agent where the loop's own fenced runner belongs.
    expect(() => callOrca("orchestration worker-start" as never, [])).toThrow(/may not run/);
    expect(() => callOrca("orchestration dispatch", ["--inject"])).toThrow(/may not pass/);
  });

  it("has no placement verb in its allowlist at all", () => {
    for (const verb of ALLOWED_VERBS) {
      expect(verb).not.toMatch(/worker-start|terminal/);
    }
  });

  it("refuses the forbidden flag in the form that carries a value", () => {
    // An exact-token match would have waved `--inject=true` straight through,
    // and the guard exists precisely for a flag added without meaning to.
    expect(() => callOrca("orchestration dispatch", ["--inject=true"])).toThrow(/may not pass/);
  });
});

describe("the one-line panel", () => {
  it("says degraded, and why, before it says anything else", () => {
    const line = lineFor(
      state({ degraded: { why: "no Orca CLI on PATH", at: "T", retryAt: "T+60" } }),
      true,
    );
    expect(line).toContain("degraded");
    expect(line).toContain("no Orca CLI on PATH");
  });

  it("names the run, ticket, attempt and terminal when there is a lifecycle to name", () => {
    const line = lineFor(
      state({
        task: { issue: 702, id: "task_1" },
        attempt: { index: 2, session: "s", dispatch: "ctx_2", ended: false },
      }),
      true,
    );
    expect(line).toContain("run run_1");
    expect(line).toContain("#702");
    expect(line).toContain("attempt 2 ctx_2");
    expect(line).toContain("term_1");
  });

  it("says so when the mirror is switched off", () => {
    expect(lineFor(null, false)).toContain("off");
  });
});

/* --------------------------------------------------------------------------
 * End to end, against a fake `orca` that records what it was asked to do.
 * ----------------------------------------------------------------------- */

interface Fixture {
  root: string;
  /** Every `orca` invocation, one line of arguments each. */
  calls: () => string[];
  branch: (name: string) => void;
  /** Write the claim lease the iteration would have written when it claimed. */
  claimed: (issue: number, run?: string) => void;
  state: () => AdapterState | null;
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
}

function fixture(label: string): Fixture {
  const root = scratch(label);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callLog = join(root, "orca-calls.log");
  const branchFile = join(root, "branch.txt");
  writeFileSync(branchFile, "main");

  // The fake Orca. Two things about it are deliberate.
  //
  // It answers with the envelope shape the real CLI uses — `{ok, result}` —
  // because the mirror reads that envelope rather than the exit status, and a
  // fake that answered with an exit status would test the wrong seam entirely.
  //
  // And it enforces the one task-lifecycle rule the real runtime enforces:
  // only a `ready` task can be dispatched, fencing a dispatch leaves its task
  // `blocked`, and a `worker_done` settles it. That rule is what makes a
  // second attempt on one ticket a different call sequence from the first, and
  // a fake that said yes to everything hid the bug twice.
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
      '  "orchestration run-current")',
      '    if [ -n "${FAKE_BOUND_OBJECTIVE:-}" ]; then',
      // The objective the mirror would have used for THIS run, echoed back as
      // if a previous create had committed and then timed out.
      '      printf \'{"ok":true,"result":{"run":{"id":"%s","objective":"ralph loop %s — Loggd backlog in %s"}}}\\n\' "$FAKE_BOUND_RUN" "$RALPH_RUN_ID" "$RALPH_STATE_ROOT"',
      "    elif [ -n \"${FAKE_BOUND_RUN:-}\" ]; then",
      '      printf \'{"ok":true,"result":{"run":{"id":"%s","objective":"somebody else"}}}\\n\' "$FAKE_BOUND_RUN"',
      "    else",
      '      printf \'{"ok":true,"result":{}}\\n\'',
      "    fi ;;",
      '  "orchestration run-create") printf \'{"ok":true,"result":{"run":{"id":"run_fake"}}}\\n\' ;;',
      '  "orchestration task-create")',
      "    set_status ready",
      '    printf \'{"ok":true,"result":{"task":{"id":"task_fake"}}}\\n\' ;;',
      '  "orchestration dispatch")',
      '    if [ "$status" != "ready" ]; then',
      '      printf \'{"ok":false,"error":{"code":"runtime_error","message":"Task task_fake is %s; only ready tasks can be dispatched"}}\\n\' "$status"',
      "      exit 0",
      "    fi",
      "    set_status dispatched",
      '    printf \'{"ok":true,"result":{"dispatch":{"id":"ctx_fake"}}}\\n\' ;;',
      '  "orchestration worker-stop")',
      "    set_status blocked",
      '    printf \'{"ok":true,"result":{"state":"stopped","processAction":"none"}}\\n\' ;;',
      '  "orchestration task-update")',
      // `--status <value>` is the fourth argument the mirror passes after the
      // run and the id; found by scanning rather than by position.
      '    prev=""; for a in "$@"; do [ "$prev" = "--status" ] && set_status "$a"; prev="$a"; done',
      '    printf \'{"ok":true,"result":{}}\\n\' ;;',
      '  "orchestration send")',
      '    case "$*" in *"--type worker_done"*)',
      '      if [ -n "${FAKE_PROSE_ALREADY:-}" ]; then',
      '        printf \'{"ok":false,"error":{"code":"runtime_error","message":"the run has already moved on"}}\\n\'',
      "        exit 0",
      "      fi",
      '      if [ -n "${FAKE_INACTIVE_DISPATCH:-}" ]; then',
      '        printf \'{"ok":false,"error":{"code":"inactive_dispatch","message":"inactive dispatch: it or its task is already settled."}}\\n\'',
      "        exit 0",
      "      fi",
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

  // Git is a subprocess seam too, and the branch is the only thing the mirror
  // asks it for.
  const git = join(bin, "git");
  writeFileSync(
    git,
    [
      "#!/bin/sh",
      'if [ "$2" = "--path-format=absolute" ]; then',
      `  printf '%s\\n' ${JSON.stringify(join(root, "gitcommon"))}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "symbolic-ref" ]; then',
      `  branch=$(cat ${JSON.stringify(branchFile)})`,
      '  [ "$branch" = "detached" ] && exit 1',
      "  printf '%s\\n' \"$branch\"",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(git, 0o755);

  return {
    root,
    calls: (): string[] =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
    branch: (name: string): void => writeFileSync(branchFile, name),
    claimed: (issue: number, run = "ralph-run-1"): void => {
      const dir = join(root, "gitcommon");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "ralph-claim-leases.json"),
        JSON.stringify({
          version: 1,
          leases: {
            [String(issue)]: {
              version: 1,
              issue,
              run,
              loop: "ralph",
              owner: "ralph@test",
              pid: 1,
              host: "test",
              worktree: root,
              branch: `ralph/${issue}`,
              claim: "ralph-wip",
              logs: ".ralph/logs",
              usageLedger: ".ralph/logs/usage-ledger.tsv",
              claimedAt: "2026-08-27T00:00:00.000Z",
              heartbeatAt: "2026-08-27T00:00:00.000Z",
              expiresAt: "2126-08-27T00:00:00.000Z",
              attempt: 1,
              history: [],
            },
          },
        }),
      );
    },
    state: (): AdapterState | null => {
      const path = join(root, ORCA_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseAdapterState(readFileSync(path, "utf8")) : null;
    },
    run: (args, env = {}): SpawnSyncReturns<string> =>
      spawnSync(BUN, [join(REPO_ROOT, "plugins", "orca", "lifecycle.ts"), ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RALPH_STATE_ROOT: root,
          RALPH_ORCA_CLI: orca,
          RALPH_LOOP_NAME: "ralph",
          RALPH_RUN_ID: "ralph-run-1",
          ORCA_TERMINAL_HANDLE: "term_loop",
          ORCA_WORKTREE_ID: "repo::/tmp/wt",
          ...env,
        },
      }),
  };
}

describe("mirroring a run", () => {
  it("dispatches new attempts to the durable replacement consumer", () => {
    const f = fixture("replacement-consumer");
    f.run(["record", "--event", "supervisor-start", "--stage", "starting"]);
    writeFileSync(
      join(f.root, ORCA_BINDING_RELATIVE_PATH),
      JSON.stringify({
        version: 1,
        ralphRun: "ralph-run-1",
        orcaRun: "run_fake",
        worktree: f.root,
        consumer: "term_observer",
        boundAt: "2026-09-13T00:00:00.000Z",
      }),
    );
    f.claimed(702);
    f.branch("ralph/702-lifecycle");
    f.run(
      ["record", "--event", "iteration-start", "--stage", "iteration", "--iteration", "1"],
      { RALPH_SESSION_ID: "session-1", ORCA_TERMINAL_HANDLE: "term_disconnected" },
    );
    expect(f.calls().find((line) => line.startsWith("orchestration dispatch"))).toContain(
      "--to term_observer",
    );
  });

  it("gives the loop a run, a ticket, an attempt and a settlement in Orca", () => {
    const f = fixture("happy");

    f.run(["record", "--event", "supervisor-start", "--stage", "starting"]);
    expect(f.state()?.orcaRun).toBe("run_fake");

    // The frontier gate runs before a ticket exists, so there is nothing to
    // attribute an attempt to yet — and the mirror must not invent one.
    f.run(["record", "--event", "frontier-wait", "--stage", "gate"]);
    expect(f.state()?.task).toBeNull();

    f.run(["record", "--event", "iteration-start", "--stage", "iteration", "--iteration", "1", "--max", "15"], {
      RALPH_SESSION_ID: "session-1",
    });
    expect(f.state()?.attempt).toMatchObject({ index: 1, session: "session-1" });

    // The iteration claims #702 and branches. Only now is there a task for the
    // attempt to be a dispatch onto.
    f.branch("ralph/702-lifecycle");
    f.run(["record", "--event", "iteration-end", "--stage", "iteration", "--iteration", "1"], {
      RALPH_SESSION_ID: "session-1",
    });
    const mid = f.state();
    expect(mid?.task).toEqual({ issue: 702, id: "task_fake" });
    expect(mid?.attempt).toMatchObject({ dispatch: "ctx_fake", ended: true });

    // The ticket is finished, so the loop detaches before it finds the backlog
    // drained — which is what releases the ticket, and what lets the attempt
    // be reported as done rather than left held.
    f.branch("main");
    f.run(["record", "--event", "stop", "--stop", "completed", "--why", "backlog drained"], {
      RALPH_SESSION_ID: "session-1",
    });
    expect(f.state()?.attempt).toBeNull();

    const calls = f.calls().join("\n");
    expect(calls).toContain("orchestration run-create");
    expect(calls).toContain("orchestration task-create");
    expect(calls).toContain("orchestration dispatch");
    expect(calls).toContain("--type heartbeat");
    expect(calls).toContain("--type worker_done");
    expect(calls).toContain("--outcome succeeded");
  });

  it("reports the Run binding it displaced, with the command that restores it", () => {
    // `run-create` binds the calling terminal, and that effect cannot be
    // undone: handing the terminal back with `run-use` fences the Run just
    // created, and every later mutation returns `consumer_fenced`. Binding is
    // lifecycle authority in Orca, so a supervisor that owns a Run holds it.
    // What the mirror owes an operator is therefore a statement and a remedy,
    // not a silent change.
    const f = fixture("binding");
    f.run(["record", "--event", "supervisor-start"], { FAKE_BOUND_RUN: "run_operator" });
    expect(f.state()?.displacedBinding).toBe("run_operator");
    expect(f.state()?.orcaRun).toBe("run_fake");
    const line = f.run(["status", "--line"]).stdout;
    expect(line).toContain("orca orchestration run-use --id run_operator");
    // And it never silently rebinds the terminal behind the operator's back.
    expect(f.calls().join("\n")).not.toContain("run-use");
  });

  it("adopts a Run its own timed-out create already committed", () => {
    // `run-create` has no idempotency key, so a call that commits in Orca and
    // then times out before its receipt arrives leaves a Run this record knows
    // nothing about. Retried blindly, one supervisor ends up with two Runs,
    // the first orphaned — and the panel then tells the operator to "restore"
    // a binding to the orphan.
    const f = fixture("adopt");
    f.run(["record", "--event", "supervisor-start"], {
      FAKE_BOUND_RUN: "run_fake",
      FAKE_BOUND_OBJECTIVE: "match",
    });
    expect(f.state()?.orcaRun).toBe("run_fake");
    expect(f.state()?.displacedBinding).toBeNull();
    expect(f.calls().join("\n")).not.toContain("run-create");
  });

  it("says nothing about a binding when there was none to displace", () => {
    const f = fixture("no-binding");
    f.run(["record", "--event", "supervisor-start"]);
    expect(f.state()?.displacedBinding).toBeNull();
    expect(f.run(["status", "--line"]).stdout).not.toContain("run-use");
  });

  it("captures a ticket taken and finished inside one iteration", () => {
    // The loop's most common path, and the one the branch cannot see at all:
    // `prompt.md` §7 ends a finished ticket with `git switch --detach
    // origin/main` BEFORE the iteration returns. So the ticket is on
    // `ralph/<issue>` at no instant the supervisor looks — `iteration-start`
    // is too early, `iteration-end` too late — and sampling the branch alone
    // produced no Task and no Dispatch for the ordinary success.
    const f = fixture("one-iteration-ticket");
    f.run(["record", "--event", "supervisor-start"]);
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    // Inside the turn: the iteration claims #702, works it, merges, and
    // detaches. The branch never stops reading `main` from out here.
    f.claimed(702);
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    expect(f.state()?.task).toEqual({ issue: 702, id: "task_fake" });
    expect(f.state()?.attempt).toMatchObject({ dispatch: "ctx_fake" });

    f.run(["record", "--event", "stop", "--stop", "completed", "--why", "drained"], {
      RALPH_SESSION_ID: "s1",
    });
    const calls = f.calls().join("\n");
    expect(calls).toContain("--task-title #702");
    expect(calls).toContain("orchestration dispatch");
    // And detached IS the release, so the finished ticket is reported done.
    expect(calls).toContain("--outcome succeeded");
  });

  it("does not adopt another run's claim as its own ticket", () => {
    const f = fixture("other-run-lease");
    f.run(["record", "--event", "supervisor-start"]);
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.claimed(660, "rafa-run-9");
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    expect(f.state()?.task).toBeNull();
  });

  it("is one task per ticket and one dispatch per attempt, not a task per iteration", () => {
    // A loop routinely spends several iterations on one ticket — a review
    // round, a CI fix — and those are attempts on one task. Filing each as its
    // own task would make the board say the loop took the same ticket three
    // times, and would leave two of them permanently unsettled.
    const f = fixture("attempts");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    for (const [index, session] of [
      [1, "s1"],
      [2, "s2"],
    ] as const) {
      f.run(["record", "--event", "iteration-start", "--iteration", String(index)], {
        RALPH_SESSION_ID: session,
      });
      f.run(["record", "--event", "iteration-end", "--iteration", String(index)], {
        RALPH_SESSION_ID: session,
      });
    }
    const calls = f.calls();
    expect(calls.filter((c) => c.includes("task-create"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("orchestration dispatch"))).toHaveLength(2);
    // Both dispatches have to have been ACCEPTED, not merely attempted:
    // fencing an attempt leaves its task blocked, and Orca dispatches only
    // `ready` tasks, so a mirror that did not hand the ticket back would open
    // the second attempt straight into `runtime_error` and degrade there.
    expect(f.state()?.degraded).toBeNull();
    expect(f.state()?.attempt).toMatchObject({ index: 2, dispatch: "ctx_fake" });
  });

  it("drops the ticket when the branch stops naming it", () => {
    // The other half of the same rule: an iteration that detached back to main
    // has selected nothing, and its attempt must not be dispatched onto the
    // previous iteration's ticket.
    const f = fixture("ticket-dropped");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.branch("main");
    f.run(["record", "--event", "iteration-start", "--iteration", "2"], { RALPH_SESSION_ID: "s2" });
    expect(f.state()?.task).toBeNull();
    expect(f.state()?.attempt).toMatchObject({ index: 2, dispatch: null });
  });

  it("refuses a stage or stop the durable record would have thrown away", () => {
    // Both mirrors are fed by one `record()` call site. `loop-state.ts` writes
    // NOTHING for a value outside its roster, so a mirror that accepted one
    // would put an event on the board the durable record does not have — and a
    // bad `--stop` in particular would be mirrored as a *success*, since
    // everything that is not `failed` settles as `succeeded`.
    const f = fixture("bad-roster");
    f.run(["record", "--event", "supervisor-start"]);
    const before = f.calls().length;
    f.run(["record", "--event", "stop", "--stop", "notakind", "--why", "typo"]);
    expect(f.calls().length).toBe(before);
    // Refused, and recorded as refused: a mistyped flag that leaves no
    // evidence anywhere is exactly the bug that hides.
    expect(f.state()?.lastRejected?.why).toContain("--stop must be one of");
    f.run(["record", "--event", "frontier-wait", "--stage", "notastage"]);
    expect(f.calls().length).toBe(before);
    expect(f.state()?.lastRejected?.why).toContain("--stage must be one of");
  });

  it("never asks Orca to place, inject into, or type at the loop's runner", () => {
    // The whole safety argument for mirroring a loop that runs its own fenced
    // runners: Orca is told, and never asked to start anything.
    const f = fixture("no-placement");
    f.run(["record", "--event", "supervisor-start", "--stage", "starting"]);
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "no-sigil", "--stop", "failed", "--why", "died"], {
      RALPH_SESSION_ID: "s1",
    });

    const calls = f.calls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toContain("worker-start");
      expect(call).not.toContain("--inject");
      expect(call).not.toContain("terminal send");
      expect(call).not.toContain("terminal create");
    }
  });

  it("reports a failed iteration as a failed attempt", () => {
    const f = fixture("failed");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "needs-triage", "--stop", "failed", "--why", "could not reach the backlog"], {
      RALPH_SESSION_ID: "s1",
    });
    const calls = f.calls().join("\n");
    expect(calls).toContain("--outcome failed");
    // Orca fails the task from that report; a manual `task-update` on top of a
    // valid `worker_done` is exactly what the guide says not to send.
    expect(calls).not.toContain("--status failed");
    // And nothing is left dangling behind the stopped loop.
    expect(f.calls().filter((c) => c.includes("task-create"))).toHaveLength(1);
  });

  it("does not report a ticket the loop is still standing on as done", () => {
    // The iteration cap running out mid-ticket is not the ticket finishing.
    // Reported as `succeeded`, Orca would complete a Task for work the loop
    // demonstrably had not finished — it never left the branch.
    const f = fixture("cap-mid-ticket");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "cap-reached", "--stop", "completed", "--why", "iteration cap (1) reached"], {
      RALPH_SESSION_ID: "s1",
    });
    const calls = f.calls().join("\n");
    expect(calls).not.toContain("--outcome succeeded");
    expect(calls).toContain("--status blocked");
  });

  it("treats a dispatch Orca has already settled as the fence working, not an outage", () => {
    // Both sides refuse late lifecycle calls and can reach one dispatch from
    // different directions. `inactive_dispatch` coming back is the agreement,
    // and degrading on it would report an outage that is not happening.
    const f = fixture("inactive");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.branch("main");
    f.run(["record", "--event", "stop", "--stop", "completed", "--why", "drained"], {
      RALPH_SESSION_ID: "s1",
      FAKE_INACTIVE_DISPATCH: "1",
    });
    expect(f.state()?.degraded).toBeNull();
    expect(f.state()?.attempt).toBeNull();
  });

  it("does not read an unrelated refusal as the fence, however its prose reads", () => {
    // The narrowing that matters: a refusal is the fence because of its CODE,
    // never because its message happens to contain "already". Matched on
    // prose, this outage would have been swallowed as agreement.
    const f = fixture("prose-already");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.branch("main");
    f.run(["record", "--event", "stop", "--stop", "completed", "--why", "drained"], {
      RALPH_SESSION_ID: "s1",
      FAKE_PROSE_ALREADY: "1",
    });
    expect(f.state()?.degraded?.why).toContain("runtime_error");
  });

  it("mirrors the loop's ending even while it is backed off", () => {
    // A stop swallowed by the back-off is never mirrored at all — there is no
    // later event to recover into — so the board keeps an open Run and a live
    // dispatch for a loop that has exited.
    const f = fixture("stop-while-dark");
    f.run(["record", "--event", "supervisor-start"], { ORCA_TERMINAL_HANDLE: "" });
    const before = f.calls().length;
    f.run(["record", "--event", "frontier-wait", "--stage", "gate"], { ORCA_TERMINAL_HANDLE: "" });
    expect(f.calls().length).toBe(before);
    f.run(["record", "--event", "stop", "--stop", "completed", "--why", "drained"]);
    expect(f.calls().length).toBeGreaterThan(before);
    expect(f.state()?.degraded).toBeNull();
  });

  it("names the supervisor, not only the loop, on everything it sends", () => {
    const f = fixture("owner");
    f.run(["record", "--event", "supervisor-start"]);
    const payload = f.calls().find((c) => c.includes("--payload"))!;
    expect(payload).toMatch(/"pid":\d+/);
    expect(payload).toContain('"host":');
    expect(payload).toContain('"branch":');
    expect(payload).toContain('"worktree":');
  });

  it("marks a ticket the loop could not take blocked, since no outcome means that", () => {
    const f = fixture("blocked");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-end", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "stop", "--stop", "blocked", "--why", "needs human triage"], {
      RALPH_SESSION_ID: "s1",
    });
    const calls = f.calls().join("\n");
    expect(calls).toContain("--status blocked");
    expect(calls).not.toContain("--type worker_done");
  });

  it("reports a failure that lands before the attempt reached its end", () => {
    // The one case where this process can speak for a runner it did not see
    // finish: the supervisor is exiting ON that failure, so the attempt died
    // with it. Fenced silently instead, the ticket would be left blocked with
    // nothing on the Run saying why the loop stopped.
    const f = fixture("failed-mid-attempt");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    // No iteration-end: the gate broke under a running attempt.
    f.run(["record", "--event", "gate-broken", "--stop", "failed", "--why", "the frontier gate failed to start"], {
      RALPH_SESSION_ID: "s1",
    });
    const calls = f.calls().join("\n");
    expect(calls).toContain("--type worker_done");
    expect(calls).toContain("--outcome failed");
  });

  it("fences an attempt that is replaced before its runner returned", () => {
    // Iteration 1 never ends — the runner is replaced. `worker-stop` is the
    // fence, and on an unsupervised dispatch it touches no process.
    const f = fixture("fenced");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    f.run(["record", "--event", "iteration-start", "--iteration", "2"], { RALPH_SESSION_ID: "s2" });
    const calls = f.calls().join("\n");
    expect(calls).toContain("orchestration worker-stop --dispatch ctx_fake");
    expect(calls).not.toContain("--type worker_done");
  });

  it("refuses a late event from a replaced attempt without telling Orca anything", () => {
    const f = fixture("late");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "2"], { RALPH_SESSION_ID: "s2" });
    const before = f.calls().length;

    // The straggler: iteration 1's supervisor child, flushing after it was
    // replaced. It reaches no Orca call at all.
    const late = f.run(["record", "--event", "iteration-end", "--iteration", "1"], {
      RALPH_SESSION_ID: "s1",
    });
    expect(late.status).toBe(0);
    expect(f.calls().length).toBe(before);
    expect(f.state()?.lastRejected?.why).toContain("replaced");
    // And the live attempt is untouched by it.
    expect(f.state()?.attempt).toMatchObject({ index: 2, session: "s2" });
  });

  it("refuses an event from a supervisor this run replaced", () => {
    const f = fixture("late-run");
    f.run(["record", "--event", "supervisor-start"]);
    const before = f.calls().length;
    const late = f.run(["record", "--event", "iteration-end", "--iteration", "1"], {
      RALPH_RUN_ID: "ralph-run-0",
    });
    expect(late.status).toBe(0);
    expect(f.calls().length).toBe(before);
    expect(f.state()?.lastRejected?.event).toBe("iteration-end");
  });

  it("abandons rather than settles an attempt left open by a supervisor that died", () => {
    const f = fixture("abandon");
    f.run(["record", "--event", "supervisor-start"]);
    f.branch("ralph/702");
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    // A new supervisor, mid-iteration, with no idea what became of the last
    // one's runner. Claiming it stopped would be a claim nobody can make.
    f.run(["record", "--event", "supervisor-start"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(f.calls().join("\n")).toContain("orchestration worker-abandon --dispatch ctx_fake");
  });
});

describe("the heartbeat that runs while the runner does", () => {
  it("pulses the live attempt between the boundaries record fires at", () => {
    // `record` fires before and after `claude -p`, and that turn holds for tens
    // of minutes. Without this the Run hears nothing in between, and a healthy
    // long iteration is indistinguishable from a supervisor that died after
    // its first event.
    const f = fixture("pulse");
    f.run(["record", "--event", "supervisor-start"]);
    f.claimed(702);
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    const before = f.calls().length;
    f.run(["heartbeat"], { RALPH_SUPERVISOR_PID: String(process.pid) });
    const beat = f.calls().slice(before).join("\n");
    expect(beat).toContain("--type heartbeat");
    expect(beat).toContain('"dispatchId":"ctx_fake"');
    expect(beat).toContain('"actors":');
  });

  it("creates nothing, so a pulse before there is an attempt is silent", () => {
    const f = fixture("pulse-empty");
    f.run(["record", "--event", "supervisor-start"]);
    const before = f.calls().length;
    f.run(["heartbeat"], { RALPH_SUPERVISOR_PID: String(process.pid) });
    expect(f.calls().length).toBe(before);
  });

  it("will not report liveness for a run it does not belong to", () => {
    // A watcher outliving its supervisor, or belonging to the run this one
    // replaced, would report a dead loop as working — worse than no heartbeat.
    const f = fixture("pulse-fenced");
    f.run(["record", "--event", "supervisor-start"]);
    f.claimed(702);
    f.run(["record", "--event", "iteration-start", "--iteration", "1"], { RALPH_SESSION_ID: "s1" });
    const before = f.calls().length;
    f.run(["heartbeat"], { RALPH_RUN_ID: "ralph-run-0", RALPH_SUPERVISOR_PID: String(process.pid) });
    expect(f.calls().length).toBe(before);
  });
});

describe("when Orca is not there", () => {
  it("records a reason and leaves the loop alone", () => {
    const f = fixture("no-cli");
    const ran = f.run(["record", "--event", "supervisor-start"], {
      RALPH_ORCA_CLI: join(f.root, "bin", "no-such-orca"),
    });
    expect(ran.status).toBe(0);
    expect(f.state()?.degraded?.why).toContain("no Orca CLI");
  });

  it("does not pay a timeout on every event while it is degraded", () => {
    const f = fixture("backoff");
    f.run(["record", "--event", "supervisor-start"], { ORCA_TERMINAL_HANDLE: "" });
    expect(f.state()?.degraded?.why).toContain("Orca-managed terminal");
    const before = f.calls().length;
    // A frontier-gated loop records a wait on every poll; each of those must
    // not cost a subprocess while Orca is known to be absent.
    f.run(["record", "--event", "frontier-wait", "--stage", "gate"], { ORCA_TERMINAL_HANDLE: "" });
    expect(f.calls().length).toBe(before);
  });

  it("retries once the back-off has passed", () => {
    const f = fixture("recover");
    f.run(["record", "--event", "supervisor-start"], {
      ORCA_TERMINAL_HANDLE: "",
      RALPH_ORCA_RETRY_SECONDS: "1",
    });
    expect(f.state()?.degraded).not.toBeNull();
    // Same worktree, Orca back: the run it never created is created now.
    const later = new Date(Date.now() - 5_000).toISOString();
    const stale = f.state()!;
    writeFileSync(
      join(f.root, ORCA_STATE_RELATIVE_PATH),
      JSON.stringify({ ...stale, degraded: { ...stale.degraded!, retryAt: later } }),
    );
    f.run(["record", "--event", "frontier-wait", "--stage", "gate"]);
    expect(f.state()?.degraded).toBeNull();
    expect(f.state()?.orcaRun).toBe("run_fake");
  });

  it("reads a refused mutation as a refusal, however the process exited", () => {
    // `orca` reports a refused mutation as exit 0 with `ok:false`, so a mirror
    // that trusted the exit status would record every rejection as a success.
    const f = fixture("refused");
    const refusing = join(f.root, "bin", "orca-refuses");
    writeFileSync(
      refusing,
      ["#!/bin/sh", 'printf \'{"ok":false,"error":{"code":"run_required"}}\\n\'', "exit 0", ""].join("\n"),
    );
    chmodSync(refusing, 0o755);
    const ran = f.run(["record", "--event", "supervisor-start"], { RALPH_ORCA_CLI: refusing });
    expect(ran.status).toBe(0);
    expect(f.state()?.orcaRun).toBeNull();
    expect(f.state()?.degraded?.why).toContain("run_required");
  });

  it("does not hand a new supervisor the dead one's back-off", () => {
    // A degraded window belongs to the run that hit it. Inherited, a fresh
    // supervisor started inside the window skipped Orca entirely and printed a
    // reason produced by a process that no longer exists.
    const f = fixture("fresh-probe");
    f.run(["record", "--event", "supervisor-start"], { ORCA_TERMINAL_HANDLE: "" });
    expect(f.state()?.degraded).not.toBeNull();
    const before = f.calls().length;
    f.run(["record", "--event", "supervisor-start"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(f.state()?.degraded).toBeNull();
    expect(f.calls().length).toBeGreaterThan(before);
    // And the gap the DEAD supervisor left is still named: a Run that simply
    // stops receiving heartbeats looks the same whether the loop died or the
    // mirror did.
    expect(f.calls().join("\n")).toContain("mirror recovered");
  });

  it("says on the board that it was dark, once, on the way back", () => {
    // Degraded is only half reported if the local panel knows and Orca does
    // not: a Run that stops receiving heartbeats looks exactly like a loop
    // that died.
    const f = fixture("recovered");
    f.run(["record", "--event", "supervisor-start"], {
      ORCA_TERMINAL_HANDLE: "",
      RALPH_ORCA_RETRY_SECONDS: "1",
    });
    const stale = f.state()!;
    writeFileSync(
      join(f.root, ORCA_STATE_RELATIVE_PATH),
      JSON.stringify({
        ...stale,
        degraded: { ...stale.degraded!, retryAt: new Date(Date.now() - 5_000).toISOString() },
      }),
    );
    f.run(["record", "--event", "frontier-wait", "--stage", "gate"]);
    const calls = f.calls().join("\n");
    expect(calls).toContain("mirror recovered");
    expect(calls).toContain("not mirrored since");
  });

  it("mirrors nothing at all when it is switched off", () => {
    const f = fixture("disabled");
    f.run(["record", "--event", "supervisor-start"], { RALPH_ORCA_LIFECYCLE: "0" });
    expect(f.calls()).toEqual([]);
    expect(f.state()).toBeNull();
  });
});

describe("the status command", () => {
  it("reports the lifecycle as one line, and never fails a panel that has no record", () => {
    const f = fixture("status");
    const empty = f.run(["status", "--line"]);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("nothing mirrored yet");

    f.run(["record", "--event", "supervisor-start"]);
    const line = f.run(["status", "--line"]);
    expect(line.stdout).toContain("run run_fake");
    expect(line.stdout).toContain("term_loop");
  });

  it("prints the record as JSON for a reader that wants the whole shape", () => {
    const f = fixture("status-json");
    f.run(["record", "--event", "supervisor-start"]);
    const json = f.run(["status", "--json"]);
    expect(JSON.parse(json.stdout).orcaRun).toBe("run_fake");
  });
});
