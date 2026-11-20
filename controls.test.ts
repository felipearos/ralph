// @vitest-environment node
/**
 * What an operator may tell a loop, and what a loop must refuse to be told.
 *
 * Four properties carry most of these cases, and each one is a failure that
 * has to be impossible rather than unlikely:
 *
 * 1. *Every control transition is visible.* The end-to-end cases drive the
 *    real CLI as a subprocess against a real inbox the test fills, and then
 *    assert on the verdict, the exit status and the durable record — because
 *    that triple is exactly what `ralph.sh` acts on.
 * 2. *A replayed command is applied once*, however often its file arrives.
 * 3. *An unexpired lease survives recovery.* `abandon` on a live claim is the
 *    one command in this file that would corrupt the tracker rather than
 *    merely annoy somebody, so it is asserted against the store on disk.
 * 4. *The channel needs nothing but the disk.* No plugin is enabled here, and
 *    an `orca` on PATH that logs every call is never called. The one outside
 *    call is `gh`, for the claim label `release` and `abandon` take off, and
 *    a fake on PATH stands in for the tracker.
 *
 * The Orca route into the same channel is `plugins/orca/mailbox.test.ts`.
 */
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "./dashboard/fixtures";

import {
  APPLIED_LIMIT,
  BUSY_EXIT,
  CONTROL_STATE_RELATIVE_PATH,
  DEFERRAL_LIMIT,
  LEGACY_CONTROL_STATE_RELATIVE_PATH,
  atBoundary,
  attemptIdFor,
  blankControlState,
  commandFromInbox,
  commandVerdict,
  gateAt,
  gateName,
  gatePassFor,
  lineFor,
  parseControlState,
  remember,
  sleepingVerdict,
  stopConfirmationFor,
  verdictFor,
  waitsForIteration,
  type ControlCommand,
  type ControlState,
} from "./controls";
import { STATE_RELATIVE_PATH } from "./loop-state";
import { claimLease, type ClaimLease, type LeaseStore } from "./claim-lease";
import {
  CONTROL_INBOX_RELATIVE_PATH,
  CONTROL_PROCESSED_RELATIVE_PATH,
  hasPendingCommand,
  hasPendingControl,
  isSafeCommandId,
} from "./control-inbox";
import { SLEEP_FILE_NAME } from "./project-sleep";
import { CONTROL_SURFACE, isSafeCommandId as dashboardSafe } from "./dashboard/control-adapter";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("drives the controls CLI through bash and bun");

const REPO_ROOT = __dirname;

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The bun running this suite, by absolute path — the fixtures replace PATH. */
const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const command = (over: Partial<ControlCommand> = {}): ControlCommand => ({
  key: "cmd-1",
  command: "pause",
  loop: null,
  run: null,
  issue: null,
  why: null,
  stopKind: "blocked",
  reconfirm: false,
  scope: "iteration",
  gate: null,
  phase: null,
  via: null,
  ...over,
});

const state = (over: Partial<ControlState> = {}): ControlState => ({
  ...blankControlState("ralph-run-1", "ralph"),
  ...over,
});

describe("reading a command out of an inbox file", () => {
  const read = (value: Record<string, unknown>, stem = "file-1") => commandFromInbox({ stem, value });

  it("takes the command, its run and its stop kind", () => {
    expect(read({ id: "s-1", command: "stop", run: "ralph-run-1", stop: "failed" })).toMatchObject({
      key: "s-1",
      command: "stop",
      run: "ralph-run-1",
      stopKind: "failed",
      via: null,
    });
  });

  it("falls back to the file's name for the key, and accepts the nested form", () => {
    expect(read({ control: { command: "pause" } })?.key).toBe("file-1");
  });

  it("carries who wrote it and what an approval is about", () => {
    expect(read({ command: "request-approval", gate: "g1", via: "board" })).toMatchObject({
      command: "request-approval",
      gate: "g1",
      via: "board",
    });
  });

  it("reads no command rather than a guessed one", () => {
    expect(read({ command: "self-destruct" })).toBeNull();
    expect(read({ phase: "iteration" })).toBeNull();
  });

  it("defaults a stop to blocked rather than to a kind nobody asked for", () => {
    // `completed` would read as a drained backlog and `failed` as a broken
    // loop; an operator who stopped it said neither.
    expect(read({ command: "stop" })?.stopKind).toBe("blocked");
    expect(read({ command: "stop", stop: "nonsense" })?.stopKind).toBe("blocked");
  });
});

describe("the fence on commands", () => {
  const identity = { run: "ralph-run-1", loop: "ralph" };

  it("applies a command addressed to whoever holds the loop", () => {
    expect(commandVerdict(state(), command(), identity)).toEqual({ accept: true });
  });

  it("applies a replayed command exactly once", () => {
    const applied = remember(state(), {
      key: "cmd-1",
      command: "pause",
      at: "T",
      outcome: "applied",
      why: "",
    });
    expect(commandVerdict(applied, command(), identity)).toMatchObject({
      accept: false,
      outcome: "replayed",
    });
  });

  it("does not obey the other loop's command", () => {
    expect(commandVerdict(state(), command({ loop: "rafa" }), identity)).toMatchObject({
      accept: false,
      outcome: "not-for-this-loop",
    });
  });

  it("asks for reconfirmation once the run it named has been replaced", () => {
    const verdict = commandVerdict(state(), command({ run: "ralph-run-0" }), identity);
    expect(verdict).toMatchObject({ accept: false, outcome: "needs-reconfirmation" });
    expect(verdict.accept === false && verdict.why).toContain("ralph-run-1");
  });

  it("applies a reconfirmed command against the run that holds the loop now", () => {
    expect(
      commandVerdict(state(), command({ run: "ralph-run-0", reconfirm: true }), identity),
    ).toEqual({ accept: true });
  });

  it("keeps the applied set bounded", () => {
    let current = state();
    for (let index = 0; index < APPLIED_LIMIT + 20; index += 1) {
      current = remember(current, {
        key: `cmd-${index}`,
        command: "pause",
        at: "T",
        outcome: "applied",
        why: "",
      });
    }
    expect(current.applied).toHaveLength(APPLIED_LIMIT);
    expect(current.applied[current.applied.length - 1]?.key).toBe(`cmd-${APPLIED_LIMIT + 19}`);
  });
});

describe("what the supervisor should do now", () => {
  it("continues when nothing is holding the loop", () => {
    expect(verdictFor(state()).action).toBe("continue");
  });

  it("holds on a pause and on an unanswered approval alike", () => {
    const paused = state({ hold: { kind: "pause", why: "hold it", since: "T", key: "k", gate: null } });
    expect(verdictFor(paused)).toMatchObject({ action: "hold", detail: "pause" });
    const gated = state({ hold: { kind: "approval", why: "gate", since: "T", key: null, gate: "g1" } });
    expect(verdictFor(gated)).toMatchObject({ action: "hold", detail: "approval" });
  });

  it("lets a stop outrank a hold", () => {
    // An operator who paused a loop and then stopped it means the second
    // thing; a supervisor parked in the hold would sit there until somebody
    // resumed it just to let it exit.
    const both = state({
      hold: { kind: "pause", why: "hold it", since: "T", key: "k", gate: null },
      stop: { kind: "blocked", why: "enough", at: "T", key: "s", confirmation: "confirmed" },
    });
    expect(verdictFor(both)).toMatchObject({ action: "stop", detail: "blocked" });
  });
});

describe("a stop's confirmation", () => {
  it("is confirmed only by the supervisor that is about to exit on it", () => {
    expect(stopConfirmationFor("supervisor", "dead")).toBe("confirmed");
  });

  it("is unreachable when an operator cannot find the owner", () => {
    expect(stopConfirmationFor("operator", "dead")).toBe("unreachable");
  });

  it("is pending — never unreachable — when liveness cannot be read", () => {
    // A machine with no readable `/proc` must not report a loop as stopped on
    // the strength of a question it could not ask.
    expect(stopConfirmationFor("operator", "unknown")).toBe("pending");
    expect(stopConfirmationFor("operator", "alive")).toBe("pending");
  });
});

describe("the record", () => {
  it("treats a truncated or foreign file as no record at all", () => {
    expect(parseControlState("{ this is not")).toBeNull();
    expect(parseControlState(JSON.stringify({ version: 2, ralphRun: "r" }))).toBeNull();
    expect(parseControlState(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it("round-trips a held, retried, recovering loop", () => {
    const written = state({
      hold: { kind: "approval", why: "gate g1", since: "T", key: null, gate: "g1" },
      retries: [
        {
          attempt: attemptIdFor("ralph-run-1", 3),
          predecessor: attemptIdFor("ralph-run-1", 2),
          evidence: {
            iteration: 2,
            session: "session-b",
            log: ".ralph/logs/iter-x.log",
            outcome: "failed",
            why: "no sigil",
            at: "T",
          },
          requestedAt: "T",
          key: "cmd-9",
        },
      ],
    });
    expect(parseControlState(JSON.stringify(written))).toEqual(written);
  });

  it("drops the degraded window a record from before the split still carries", () => {
    const old = { ...state(), degraded: { why: "orca down", at: "T", retryAt: "T" } };
    expect(parseControlState(JSON.stringify(old))).toEqual(state());
  });
});

describe("the one-line panel", () => {
  it("says which kind of stop, and whether anybody confirmed it", () => {
    const line = lineFor(
      state({ stop: { kind: "blocked", why: "operator", at: "T", key: null, confirmation: "unreachable" } }),
    );
    expect(line).toContain("unreachable");
  });

  it("says nothing has been issued rather than saying nothing", () => {
    expect(lineFor(null)).toBe("Controls: listening — nothing issued yet");
  });
});

/* --------------------------------------------------------------------------
 * End to end, through the inbox, with no plugin enabled.
 * ----------------------------------------------------------------------- */

interface Fixture {
  root: string;
  /** Every `orca` invocation. There must never be one. */
  calls: () => string[];
  /** Drop one command file, as the dashboard does. */
  drop: (id: string, body: Record<string, unknown>) => void;
  claim: (issue: number, over?: Partial<ClaimLease>) => void;
  leases: () => Record<string, ClaimLease>;
  /** Hold the lease store's lock, as a claim writer or a heartbeat does. */
  lock: (held: boolean) => void;
  loopState: (over: Record<string, unknown>) => void;
  /** Put labels on an issue, as the tracker the fake `gh` answers for. */
  label: (issue: number, labels: string[]) => void;
  labels: (issue: number) => string[];
  /** Every `gh issue edit` invocation, in order. */
  edits: () => string[];
  /** Make every `gh issue edit` fail, as a lost token or an outage does. */
  ghFails: (failing: boolean) => void;
  state: () => ControlState | null;
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
  /** The poll as a shell runs it — the seam `applierFor` used to get wrong. */
  shell: (script: string) => SpawnSyncReturns<string>;
}

function fixture(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `ralph-controls-${label}-`));
  scratchRoots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(root);
  mkdirSync(join(root, "gitcommon"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);

  // An `orca` that answers everything and logs every call, so a call the core
  // should never make is one the test can see.
  const callLog = join(root, "orca.calls");
  const orca = join(bin, "orca");
  writeFileSync(
    orca,
    ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`, "printf '{\"ok\":true,\"result\":{}}\\n'", ""].join("\n"),
  );
  chmodSync(orca, 0o755);

  const git = join(bin, "git");
  writeFileSync(
    git,
    [
      "#!/bin/sh",
      'if [ "$2" = "--path-format=absolute" ]; then',
      `  printf '%s\\n' ${JSON.stringify(join(root, "gitcommon"))}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "symbolic-ref" ]; then printf \'%s\\n\' "ralph/703"; exit 0; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(git, 0o755);

  // A `gh` that keeps each issue's labels in one JSON file, so a test can
  // arrange the tracker and read it back. Only the two calls a release makes.
  const labelsPath = join(root, "gh.labels.json");
  const editLog = join(root, "gh.edits");
  const ghFailFlag = join(root, "gh.fail");
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      `#!${BUN}`,
      'const { existsSync, readFileSync, writeFileSync, appendFileSync } = require("node:fs");',
      "const [, , noun, verb, issue, flag, value] = process.argv;",
      `const path = ${JSON.stringify(labelsPath)};`,
      'const all = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};',
      'if (noun === "issue" && verb === "view") {',
      "  console.log(JSON.stringify({ labels: (all[issue] ?? []).map((name) => ({ name })) }));",
      "  process.exit(0);",
      "}",
      'if (noun === "issue" && verb === "edit" && flag === "--remove-label") {',
      `  appendFileSync(${JSON.stringify(editLog)}, process.argv.slice(2).join(" ") + "\\n");`,
      `  if (existsSync(${JSON.stringify(ghFailFlag)})) { console.error("HTTP 502: Bad Gateway"); process.exit(1); }`,
      "  all[issue] = (all[issue] ?? []).filter((name) => name !== value);",
      "  writeFileSync(path, JSON.stringify(all));",
      "  process.exit(0);",
      "}",
      'console.error("unexpected gh " + process.argv.slice(2).join(" "));',
      "process.exit(2);",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  const readLabels = (): Record<string, string[]> =>
    existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : {};

  // No `RALPH_PLUGINS` and no project config: plugins are off by default.
  const inherited = { ...process.env };
  delete inherited.RALPH_PLUGINS;
  const environment: Record<string, string | undefined> = {
    ...inherited,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: root,
    RALPH_ORCA_CLI: orca,
    RALPH_LOOP_NAME: "ralph",
    RALPH_RUN_ID: "ralph-run-1",
    ORCA_TERMINAL_HANDLE: "term_loop",
  };

  const leasePath = join(root, "gitcommon", "ralph-claim-leases.json");
  const readLeases = (): Record<string, ClaimLease> =>
    existsSync(leasePath) ? JSON.parse(readFileSync(leasePath, "utf8")).leases : {};
  const inbox = join(root, CONTROL_INBOX_RELATIVE_PATH);

  return {
    root,
    calls: () =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
    drop: (id, body) => {
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ version: 1, id, ...body }));
    },
    claim: (issue, over = {}) => {
      const store: LeaseStore = { version: 1, leases: readLeases() };
      claimLease(store, {
        issue,
        run: "ralph-run-0",
        loop: "ralph",
        pid: 1,
        host: "fedora",
        worktree: root,
        branch: `ralph/${issue}`,
        nowMs: Date.now(),
      });
      store.leases[String(issue)] = { ...store.leases[String(issue)]!, ...over };
      writeFileSync(leasePath, JSON.stringify(store));
    },
    leases: readLeases,
    lock: (held) => {
      const path = join(root, "gitcommon", "next-tasks-claim.lock");
      if (held) writeFileSync(path, "");
      else rmSync(path, { force: true });
    },
    loopState: (over) =>
      writeFileSync(
        join(root, STATE_RELATIVE_PATH),
        JSON.stringify({
          version: 1,
          run: "ralph-run-1",
          owner: { loop: "ralph", pid: 2 ** 22, host: "test" },
          worktree: root,
          branch: "ralph/703",
          stage: "iteration",
          iteration: { index: 2, max: 15 },
          heartbeat: "2026-08-27T00:00:00.000Z",
          lastEvent: { name: "iteration-end", at: "T", detail: ".ralph/logs/iter-x.log" },
          stopReason: null,
          ...over,
        }),
      ),
    label: (issue, labels) => writeFileSync(labelsPath, JSON.stringify({ ...readLabels(), [issue]: labels })),
    labels: (issue) => readLabels()[String(issue)] ?? [],
    edits: () =>
      existsSync(editLog) ? readFileSync(editLog, "utf8").split("\n").filter((line) => line !== "") : [],
    ghFails: (failing) => {
      if (failing) writeFileSync(ghFailFlag, "");
      else rmSync(ghFailFlag, { force: true });
    },
    state: () => {
      const path = join(root, CONTROL_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseControlState(readFileSync(path, "utf8")) : null;
    },
    run: (args, env = {}) =>
      spawnSync(BUN, [join(REPO_ROOT, "controls.ts"), ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...environment, ...env },
      }),
    shell: (script) =>
      spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        cwd: root,
        env: environment,
      }),
  };
}

/** The machine line `ralph.sh` reads: `<verdict>\t<detail>\t<why>`. */
const verdict = (run: SpawnSyncReturns<string>): string[] =>
  run.stdout.split("\n")[0]?.split("\t") ?? [];

describe("pausing and resuming a loop", () => {
  it("holds the loop, keeps holding it, and lets it go again", () => {
    const f = fixture("pause");
    f.drop("p-1", { command: "pause", why: "the frontier needs a human" });
    const paused = f.run(["poll"]);
    expect(paused.status).toBe(10);
    expect(verdict(paused)[0]).toBe("hold");

    // An empty inbox does not release a hold: the record is what holds it.
    expect(f.run(["poll"]).status).toBe(10);

    f.drop("r-1", { command: "resume", why: "widened it" });
    const resumed = f.run(["poll"]);
    expect(resumed.status).toBe(0);
    expect(verdict(resumed)[0]).toBe("continue");
    expect(f.state()?.hold).toBeNull();
    expect(f.calls()).toEqual([]);
  });

  it("survives the supervisor that was told to pause being replaced", () => {
    // A pause is an instruction about the WORK. A restart the operator did not
    // ask for, and may not know about, must not be a way to defeat it.
    const f = fixture("pause-restart");
    f.drop("p-1", { command: "pause", why: "hold it" });
    expect(f.run(["poll"]).status).toBe(10);

    const nextRun = f.run(["poll"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(nextRun.status).toBe(10);
    expect(f.state()?.ralphRun).toBe("ralph-run-2");
    expect(f.state()?.ownerChangedAt).not.toBeNull();
  });

  it("keeps a hold recorded under the record's old name", () => {
    const f = fixture("legacy-record");
    writeFileSync(
      join(f.root, LEGACY_CONTROL_STATE_RELATIVE_PATH),
      JSON.stringify(state({ hold: { kind: "pause", why: "held before the upgrade", since: "T", key: "p", gate: null } })),
    );
    expect(f.run(["poll"]).status).toBe(10);
    expect(f.state()?.hold?.why).toBe("held before the upgrade");
  });
});

describe("stopping a loop", () => {
  it("confirms a stop the supervisor itself read", () => {
    const f = fixture("stop-confirmed");
    f.drop("s-1", { command: "stop", why: "that is enough for tonight", stop: "completed" });
    // `--supervised` is the supervisor saying it is about to act on the
    // answer. Nothing infers it: see `applierFor`.
    const stopped = f.run(["poll", "--supervised"]);
    expect(stopped.status).toBe(20);
    expect(verdict(stopped).slice(0, 2)).toEqual(["stop", "completed"]);
    expect(f.state()?.stop).toMatchObject({ kind: "completed", confirmation: "confirmed" });
  });

  it("confirms a stop even when invoked the way the supervisor actually invokes it", () => {
    // `ralph.sh` runs the poll as `out="$(bun … poll --supervised 2>/dev/null)"`,
    // and the redirection inside a command substitution defeats bash's exec
    // optimisation — so any check that inferred the caller from `process.ppid`
    // saw the subshell, not the supervisor. Driven through bash here rather
    // than spawned directly, because the shell IS the bug.
    const f = fixture("stop-through-bash");
    f.drop("s-1", { command: "stop", why: "that is enough" });
    const script = [
      `out="$(${BUN} ${join(REPO_ROOT, "controls.ts")} poll --supervised 2>/dev/null)"`,
      "status=$?",
      `printf '%s' "$out"`,
      "exit $status",
    ].join("; ");
    const ran = f.shell(script);
    expect(ran.status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "confirmed" });
  });

  it("says a stop is unreachable when the owner is gone", () => {
    const f = fixture("stop-unreachable");
    // A pid that cannot be a supervisor: the record names it, `/proc` does not.
    f.loopState({ owner: { loop: "ralph", pid: 2 ** 22, host: "test" } });
    f.drop("s-1", { command: "stop", why: "the box it ran on is gone" });
    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "unreachable" });
  });

  it("does not stop the next supervisor with a stop that was already carried out", () => {
    // An operator who ran `ralph/start.sh` again meant it. A confirmed stop is
    // finished; carrying it out twice would exit at the first checkpoint on
    // last night's command, with no obvious way back.
    const f = fixture("stop-not-twice");
    f.drop("s-1", { command: "stop", why: "that is enough for tonight" });
    expect(f.run(["poll", "--supervised"]).status).toBe(20);
    const restarted = f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(restarted.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
  });

  it("makes the next supervisor carry out a stop nobody confirmed", () => {
    const f = fixture("stop-unconfirmed-carries");
    f.loopState({ owner: { loop: "ralph", pid: 2 ** 22, host: "test" } });
    f.drop("s-1", { command: "stop", why: "the box it ran on is gone" });
    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "unreachable" });

    const restarted = f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(restarted.status).toBe(20);
    expect(restarted.stdout).toContain("carrying out a unreachable stop");
    // Carrying it out is what confirms it; without this every later start.sh
    // exited at its first checkpoint on a command obeyed several times over.
    expect(f.state()?.stop).toMatchObject({ confirmation: "confirmed" });
    expect(f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-3" }).status).toBe(0);
  });
});

describe("approving held work", () => {
  it("holds on a request for approval, and continues when it is approved", () => {
    const f = fixture("approve");
    f.drop("q-1", { command: "request-approval", gate: "g1", why: "ship it?" });
    expect(f.run(["poll"]).status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ kind: "approval", gate: "g1", why: "ship it?" });

    f.drop("a-1", { command: "approve", gate: "g1", why: "yes" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.hold).toBeNull();
  });

  it("turns a denial into a blocked stop without a second command", () => {
    const f = fixture("deny");
    f.drop("q-1", { command: "request-approval", why: "ship it?" });
    expect(f.run(["poll"]).status).toBe(10);
    f.drop("d-1", { command: "deny", why: "not this one" });
    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ kind: "blocked", why: "approval denied — not this one" });
  });

  it("refuses an answer to another question, and a request over a pause", () => {
    const f = fixture("approval-mismatch");
    f.drop("q-1", { command: "request-approval", gate: "g1" });
    f.run(["poll"]);
    f.drop("a-2", { command: "approve", gate: "g2" });
    expect(f.run(["poll"]).status).toBe(10);
    expect(f.state()?.applied.find((row) => row.key === "a-2")).toMatchObject({
      outcome: "refused",
      why: "the approval waiting is g1, not g2",
    });

    // A pause an operator took outranks a request for approval.
    const g = fixture("approval-over-pause");
    g.drop("p-1", { command: "pause" });
    g.run(["poll"]);
    g.drop("q-1", { command: "request-approval", gate: "g1" });
    expect(g.run(["poll"]).status).toBe(10);
    expect(g.state()?.hold).toMatchObject({ kind: "pause" });
    expect(g.state()?.applied.find((row) => row.key === "q-1")).toMatchObject({ outcome: "refused" });

    // And `approve` is not a synonym for `resume`.
    g.drop("a-1", { command: "approve" });
    expect(g.run(["poll"]).status).toBe(10);
    expect(g.state()?.applied.find((row) => row.key === "a-1")).toMatchObject({ outcome: "refused" });
  });
});

describe("retrying a failed attempt", () => {
  it("refuses a retry when the last attempt did not fail, and says how it ended", () => {
    // "Try again" is an answer to a failure. A loop that completed, or that an
    // operator stopped as blocked, has nothing to retry.
    const f = fixture("retry-not-failed");
    f.loopState({ stage: "stopped", stopReason: { kind: "blocked", why: "frontier empty", at: "T" } });
    f.drop("r-blocked", { command: "retry" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.retries).toEqual([]);
    const refused = f.state()?.applied.find((entry) => entry.key === "r-blocked");
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused?.why).toContain("blocked");

    const g = fixture("retry-nothing");
    g.loopState({});
    g.drop("r-none", { command: "retry" });
    g.run(["poll"]);
    expect(g.state()?.applied.find((entry) => entry.key === "r-none")).toMatchObject({ outcome: "refused" });
  });

  it("opens one link per failure, however many retries are sent past it", () => {
    const f = fixture("retry-twice");
    f.loopState({ stage: "stopped", stopReason: { kind: "failed", why: "no sigil", at: "2026-09-22T10:00:00Z" } });
    f.drop("r-1", { command: "retry" });
    f.run(["poll"]);
    f.drop("r-2", { command: "retry" });
    f.run(["poll"]);
    expect(f.state()?.retries).toHaveLength(1);
    const second = f.state()?.applied.find((entry) => entry.key === "r-2");
    expect(second).toMatchObject({ outcome: "refused" });
    expect(second?.why).toContain("ralph-run-1/attempt-3");
  });

  it("opens a linked attempt and keeps the predecessor's evidence", () => {
    const f = fixture("retry");
    f.loopState({
      stage: "stopped",
      stopReason: { kind: "failed", why: "iteration 2 ended without a sigil", at: "T" },
      session: "session-b",
    });
    f.drop("r-1", { command: "retry", why: "the runner died, the ticket is fine" });
    expect(f.run(["poll"]).status).toBe(0);
    const link = f.state()?.retries[0];
    expect(link?.attempt).toBe("ralph-run-1/attempt-3");
    expect(link?.predecessor).toBe("ralph-run-1/attempt-2");
    expect(link?.evidence).toEqual({
      iteration: 2,
      session: "session-b",
      log: ".ralph/logs/iter-x.log",
      outcome: "failed",
      why: "iteration 2 ended without a sigil",
      at: "T",
    });
  });

  it("clears the stop it is retrying past, and leaves a pause alone", () => {
    const f = fixture("retry-hold");
    f.drop("p", { command: "pause", why: "hold" });
    f.run(["poll"]);
    f.drop("s", { command: "stop", stop: "failed", why: "stop" });
    expect(f.run(["poll"]).status).toBe(20);
    f.drop("r", { command: "retry", why: "try again" });
    // Still held — "try again" has never meant "and unpause".
    expect(f.run(["poll"]).status).toBe(10);
    expect(f.state()?.stop).toBeNull();
    expect(f.state()?.hold).toMatchObject({ kind: "pause" });
  });
});

describe("abandoning and releasing a claim", () => {
  it("refuses to take an unexpired lease, whatever the operator asks", () => {
    const f = fixture("abandon-live");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    f.claim(703, { run: "ralph-run-0", expiresAt });
    f.label(703, ["ralph-wip"]);
    f.drop("ab-1", { command: "abandon", issue: 703, why: "I think it is dead" });
    expect(f.run(["poll"]).status).toBe(0);
    // The lease is untouched: this is the one command that would hand one
    // ticket to two loops.
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.labels(703)).toEqual(["ralph-wip"]);
    expect(f.edits()).toEqual([]);
    expect(f.state()?.abandoned).toHaveLength(0);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "refused" });
    expect(f.state()?.applied[0]?.why).toContain(expiresAt);
  });

  it("takes an expired lease back and keeps what it was", () => {
    const f = fixture("abandon-expired");
    // Another loop's lapsed claim: the label that goes is the one its lease
    // named, and nothing else on the issue is touched.
    f.claim(703, { run: "rafa-run-0", loop: "rafa", claim: "rafa-wip", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.label(703, ["rafa-wip", "difficulty:hard"]);
    f.drop("ab-1", { command: "abandon", issue: 703, why: "the host is gone" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.labels(703)).toEqual(["difficulty:hard"]);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "applied" });
    expect(f.state()?.abandoned[0]).toMatchObject({
      issue: 703,
      run: "rafa-run-0",
      expiredAt: "2020-01-01T00:00:00.000Z",
    });
  });

  it("refuses to release a claim another run holds, even an expired one", () => {
    // Release is the owner leaving. Taking somebody else's lapsed claim is
    // recovery, which is `abandon`, and the refusal says so.
    const f = fixture("release-not-owner");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.label(703, ["ralph-wip"]);
    f.drop("rel-other", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.labels(703)).toEqual(["ralph-wip"]);
    expect(f.state()?.released).toEqual([]);
    const refused = f.state()?.applied.find((entry) => entry.key === "rel-other");
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused?.why).toContain("ralph-run-0");
    expect(refused?.why).toContain("abandon");
  });

  it("lets a run release its own live claim, once, label and all", () => {
    // A `<loop>-wip` label with no lease behind it is a ticket every loop
    // skips and nothing cleans up, so the label goes with the lease.
    const f = fixture("release");
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.label(703, ["ralph-wip", "prd"]);
    f.drop("rel-1", { command: "release", issue: 703, why: "handing this worktree back" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.labels(703)).toEqual(["prd"]);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "applied", why: "released #703" });
    f.drop("rel-2", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.released).toEqual([703]);
    expect(f.edits()).toHaveLength(1);
    expect(f.calls()).toEqual([]);
  });

  it("clears the ticket's phase ledger with a release, and only that ticket's", () => {
    const f = fixture("release-ledger");
    const phases = (root: string, issue: number) => {
      mkdirSync(join(root, ".ralph", "logs", "phases"), { recursive: true });
      writeFileSync(join(root, ".ralph", "logs", "phases", `${issue}.jsonl`), "{}\n");
      writeFileSync(join(root, ".ralph", "logs", `phase-${issue}-select.md`), "mapped\n");
    };
    phases(f.root, 703);
    phases(f.root, 704);
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.label(703, ["ralph-wip"]);
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "applied" });
    expect(existsSync(join(f.root, ".ralph", "logs", "phases", "703.jsonl"))).toBe(false);
    expect(existsSync(join(f.root, ".ralph", "logs", "phase-703-select.md"))).toBe(false);
    expect(existsSync(join(f.root, ".ralph", "logs", "phases", "704.jsonl"))).toBe(true);
    expect(existsSync(join(f.root, ".ralph", "logs", "phase-704-select.md"))).toBe(true);
  });

  it("clears an abandoned ticket's phase ledger in the worktree its owner held it from, and keeps a live one's", () => {
    const f = fixture("abandon-ledger");
    const owner = join(f.root, "rafa-worktree");
    const ledger = (issue: number) => join(owner, ".ralph", "logs", "phases", `${issue}.jsonl`);
    mkdirSync(join(owner, ".ralph", "logs", "phases"), { recursive: true });
    writeFileSync(ledger(703), "{}\n");
    writeFileSync(ledger(705), "{}\n");
    f.claim(703, { run: "rafa-run-0", loop: "rafa", claim: "rafa-wip", worktree: owner, expiresAt: "2020-01-01T00:00:00.000Z" });
    f.label(703, ["rafa-wip"]);
    f.claim(705, { run: "rafa-run-0", loop: "rafa", claim: "rafa-wip", worktree: owner, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.label(705, ["rafa-wip"]);
    f.drop("ab-1", { command: "abandon", issue: 703 });
    f.drop("ab-2", { command: "abandon", issue: 705 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.applied.find((entry) => entry.key === "ab-1")).toMatchObject({ outcome: "applied" });
    expect(f.state()?.applied.find((entry) => entry.key === "ab-2")).toMatchObject({ outcome: "refused" });
    expect(existsSync(ledger(703))).toBe(false);
    // Refused, so the owner may still be working it: its ledger stays.
    expect(existsSync(ledger(705))).toBe(true);
  });

  it("refuses a release whose label it could not remove, and keeps the claim for another try", () => {
    const f = fixture("release-label-fails");
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.label(703, ["ralph-wip"]);
    f.ghFails(true);
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    const refused = f.state()?.applied.find((entry) => entry.key === "rel-1");
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused?.why).toContain("ralph-wip");
    expect(refused?.why).toContain("502");
    // Nothing was given back, so nothing is recorded as given back.
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.labels(703)).toEqual(["ralph-wip"]);
    expect(f.state()?.released).toEqual([]);

    f.ghFails(false);
    f.drop("rel-2", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.applied.find((entry) => entry.key === "rel-2")).toMatchObject({ outcome: "applied" });
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.labels(703)).toEqual([]);
  });

  it("refuses an abandon whose label it could not remove, and leaves the lapsed lease in place", () => {
    const f = fixture("abandon-label-fails");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.label(703, ["ralph-wip"]);
    f.ghFails(true);
    f.drop("ab-1", { command: "abandon", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    const refused = f.state()?.applied.find((entry) => entry.key === "ab-1");
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused?.why).toContain("ralph-wip");
    // The expired lease stays: it is what lets the frontier clear the label
    // itself, and what a second abandon needs to know which label to take.
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.state()?.abandoned).toEqual([]);
  });

  it("still clears this loop's leftover label when the lease is already gone, and no other loop's", () => {
    const f = fixture("release-leftover");
    f.label(703, ["rafa-wip", "ralph-wip"]);
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.labels(703)).toEqual(["rafa-wip"]);
    const settled = f.state()?.applied.find((entry) => entry.key === "rel-1");
    expect(settled).toMatchObject({ outcome: "applied" });
    expect(settled?.why).toContain("ralph-wip");
  });

  it("clears a label left behind by a release this record already holds", () => {
    // The ticket that prompted this: released before the label went with the
    // lease, so it is already on the record. Sending release again is how an
    // operator gives it back, and must not stop at "already released".
    const f = fixture("release-again");
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    f.label(703, ["ralph-wip"]);
    f.drop("rel-2", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.labels(703)).toEqual([]);
    expect(f.state()?.released).toEqual([703]);
  });

  it("releases a claim a later run took on an issue it released before", () => {
    const f = fixture("release-reclaimed");
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.label(703, ["ralph-wip"]);
    f.drop("rel-2", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.labels(703)).toEqual([]);
  });

  it("makes no tracker edit for a release when there is nothing left to clear", () => {
    const f = fixture("release-clean");
    f.label(703, ["rafa-wip"]);
    f.drop("rel-1", { command: "release", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.edits()).toEqual([]);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "applied" });
  });

  it("asks again for a command it could not apply because the store was locked", () => {
    // A deferral must not land in the applied fence: an entry there of ANY
    // outcome silences the next delivery, which is the opposite of the retry
    // a deferral is asking for. The file stays in the inbox instead.
    const f = fixture("abandon-busy");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.drop("take-703", { command: "abandon", issue: 703 });
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.state()?.applied.some((entry) => entry.key === "take-703")).toBe(false);
    expect(existsSync(join(f.root, CONTROL_INBOX_RELATIVE_PATH, "take-703.json"))).toBe(true);

    f.lock(false);
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.state()?.abandoned[0]).toMatchObject({ issue: 703 });
  });

  it("gives up on a lock that is never coming back, and says how to unstick it", () => {
    const f = fixture("abandon-stuck");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.drop("stuck-703", { command: "abandon", issue: 703 });
    for (let poll = 1; poll < DEFERRAL_LIMIT; poll += 1) {
      f.run(["poll"]);
      expect(f.state()?.deferrals[0]).toMatchObject({ command: "abandon", attempts: poll });
    }
    const last = f.run(["poll"]);
    expect(last.stdout).toContain("given up");
    expect(last.stdout).toContain("next-tasks-claim.lock");
    expect(f.state()?.deferrals).toEqual([]);
    expect(f.state()?.applied.find((entry) => entry.key === "stuck-703")).toMatchObject({ outcome: "refused" });
    expect(existsSync(join(f.root, CONTROL_INBOX_RELATIVE_PATH, "stuck-703.json"))).toBe(false);
    expect(Object.keys(f.leases())).toEqual(["703"]);
  });

  it("stops reporting a deferred command as waiting once anything settles it", () => {
    const f = fixture("deferral-settled");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.drop("moved-703", { command: "abandon", issue: 703, run: "ralph-run-1" });
    f.run(["poll"]);
    expect(f.state()?.deferrals).toHaveLength(1);
    // A new supervisor takes the worktree; the command names a run that has
    // been replaced, so it is refused rather than applied.
    f.run(["poll"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(f.state()?.applied.find((entry) => entry.key === "moved-703")).toMatchObject({
      outcome: "needs-reconfirmation",
    });
    expect(f.state()?.deferrals).toEqual([]);
    expect(f.run(["status"]).stdout).not.toContain("waiting since");
  });
});

describe("the status command", () => {
  it("prints one line for a panel and the last few commands under it", () => {
    const f = fixture("status");
    f.drop("p-1", { command: "pause", why: "the frontier needs a human" });
    f.run(["poll"]);
    const shown = f.run(["status"]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain("Controls: pause");
    expect(shown.stdout).toContain("the frontier needs a human");
  });
});

/* --------------------------------------------------------------------------
 * The inbox itself: files, replays, crashes and garbage.
 * ----------------------------------------------------------------------- */

describe("the local command inbox", () => {
  const inboxDir = (f: Fixture): string => join(f.root, CONTROL_INBOX_RELATIVE_PATH);
  const processedDir = (f: Fixture): string => join(f.root, CONTROL_PROCESSED_RELATIVE_PATH);
  /** Drop one command file, as the dashboard does. */
  const drop = (f: Fixture, id: string, body: Record<string, unknown> | string): void => {
    mkdirSync(inboxDir(f), { recursive: true });
    writeFileSync(
      join(inboxDir(f), `${id}.json`),
      typeof body === "string" ? body : JSON.stringify({ version: 1, id, ...body }),
    );
  };
  const outcomeOf = (f: Fixture, stem: string): Record<string, unknown> | null => {
    const path = join(processedDir(f), `${stem}.outcome.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  };
  const pending = (f: Fixture): string[] =>
    existsSync(inboxDir(f)) ? readdirSync(inboxDir(f)).filter((name) => !name.startsWith(".")) : [];
  /** No Orca CLI at all: the failure the inbox exists to survive. */
  const noOrca = (f: Fixture): Record<string, string> => ({ RALPH_ORCA_CLI: join(f.root, "no-such-orca") });

  it("tells a long wait a command is waiting until a poll has answered it", () => {
    const f = fixture("inbox-pending");
    expect(hasPendingCommand(f.root)).toBe(false);
    drop(f, "s-9", { command: "stop", why: "stop the idle loop" });
    // A write in flight is not a command yet.
    writeFileSync(join(inboxDir(f), ".s-10.json.1.tmp"), "{");
    expect(hasPendingCommand(f.root)).toBe(true);
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(20);
    expect(hasPendingCommand(f.root)).toBe(false);
    // Answered but not yet moved — a poll that died between the two: the
    // outcome stands, so no wait may keep waking for it.
    drop(f, "s-9", { command: "stop", why: "stop the idle loop" });
    expect(hasPendingCommand(f.root)).toBe(false);
  });

  it("applies pause, resume and stop with no Orca CLI, and records each outcome beside the file", () => {
    const f = fixture("inbox-no-orca");
    drop(f, "p-1", { command: "pause", why: "triage the frontier" });
    const paused = f.run(["poll", "--supervised"], noOrca(f));
    expect(paused.status, paused.stderr).toBe(10);
    expect(f.state()?.hold).toMatchObject({ kind: "pause", why: "triage the frontier", key: "p-1" });
    expect(f.state()?.applied).toContainEqual(expect.objectContaining({ key: "p-1", outcome: "applied" }));
    expect(pending(f)).toEqual([]);
    expect(existsSync(join(processedDir(f), "p-1.json"))).toBe(true);
    expect(outcomeOf(f, "p-1")).toMatchObject({ key: "p-1", command: "pause", outcome: "applied" });

    drop(f, "r-1", { command: "resume" });
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(0);
    expect(f.state()?.hold).toBeNull();

    drop(f, "s-1", { command: "stop", stop: "failed", why: "review cannot log in" });
    const stopped = f.run(["poll", "--supervised"], noOrca(f));
    expect(stopped.status).toBe(20);
    expect(verdict(stopped)).toEqual(["stop", "failed", "review cannot log in"]);
    expect(f.state()?.stop).toMatchObject({ kind: "failed", confirmation: "confirmed", key: "s-1" });
    expect(f.calls()).toEqual([]);
  });

  it("applies a command file once, however many times it arrives", () => {
    const f = fixture("inbox-replay");
    drop(f, "p-1", { command: "pause" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(10);
    drop(f, "r-1", { command: "resume" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);

    // The same pause, delivered again: a replay, not a second pause.
    drop(f, "p-1", { command: "pause" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);
    expect(f.state()?.hold).toBeNull();
    expect(f.state()?.applied.filter((entry) => entry.key === "p-1")).toHaveLength(1);
    expect(pending(f)).toEqual([]);
  });

  it("does not re-apply a file whose move a crash interrupted after the record was written", () => {
    const f = fixture("inbox-crash");
    // The record already holds the pause, and a later resume released it; the
    // supervisor died before the pause's file left the inbox.
    mkdirSync(join(f.root, ".ralph", "logs"), { recursive: true });
    writeFileSync(
      join(f.root, CONTROL_STATE_RELATIVE_PATH),
      JSON.stringify(
        remember(state(), { key: "p-1", command: "pause", at: "T0", outcome: "applied", why: "paused" }),
      ),
    );
    drop(f, "p-1", { command: "pause" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);
    expect(f.state()?.hold).toBeNull();
    expect(pending(f)).toEqual([]);
    expect(outcomeOf(f, "p-1")).toMatchObject({ outcome: "applied", why: "paused" });
  });

  it("does not re-apply a file already settled, even once its key has left the fence", () => {
    const f = fixture("inbox-aged-out");
    mkdirSync(processedDir(f), { recursive: true });
    writeFileSync(
      join(processedDir(f), "s-1.outcome.json"),
      JSON.stringify({ key: "s-1", command: "stop", outcome: "applied", why: "stopping", at: "T0" }),
    );
    drop(f, "s-1", { command: "stop" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);
    expect(f.state()?.stop).toBeNull();
    expect(pending(f)).toEqual([]);
  });

  it("refuses a command naming a replaced run, and applies one naming no run", () => {
    const f = fixture("inbox-run-fence");
    drop(f, "s-old", { command: "stop", run: "ralph-run-0" });
    const refused = f.run(["poll"], noOrca(f));
    expect(refused.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
    expect(outcomeOf(f, "s-old")).toMatchObject({ outcome: "needs-reconfirmation" });
    expect(outcomeOf(f, "s-old")?.why).toContain("re-issue it against ralph-run-1");

    drop(f, "p-any", { command: "pause" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(10);
    drop(f, "p-mine", { command: "resume", run: "ralph-run-1" });
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);
  });

  it("records and skips a malformed, truncated or unknown command without holding the loop", () => {
    const f = fixture("inbox-malformed");
    drop(f, "truncated", '{"version":1,"id":"truncated","comm');
    drop(f, "array", "[1,2]");
    drop(f, "unknown", { command: "self-destruct" });
    // A write in flight: the writer has not renamed it into place yet.
    writeFileSync(join(inboxDir(f), ".p-9.json.123.tmp"), '{"command":"pa');
    drop(f, "p-1", { command: "pause" });

    const polled = f.run(["poll"], noOrca(f));
    expect(polled.status, polled.stderr).toBe(10);
    expect(f.state()?.hold).toMatchObject({ key: "p-1" });
    for (const stem of ["truncated", "array", "unknown"]) {
      expect(outcomeOf(f, stem)).toMatchObject({ outcome: "malformed" });
    }
    expect(polled.stdout).toContain("truncated.json");
    expect(readdirSync(inboxDir(f))).toEqual([".p-9.json.123.tmp"]);
  });

  it("says a malformed file once, even when it cannot be moved aside", () => {
    const f = fixture("inbox-stuck");
    drop(f, "bad", "{nope");
    // An outcome already written by an earlier poll whose move failed.
    mkdirSync(processedDir(f), { recursive: true });
    writeFileSync(
      join(processedDir(f), "bad.outcome.json"),
      JSON.stringify({ key: null, command: null, outcome: "malformed", why: "not valid JSON", at: "T0" }),
    );
    const polled = f.run(["poll"], noOrca(f));
    expect(polled.stdout).not.toContain("bad.json");
    expect(pending(f)).toEqual([]);
    expect(outcomeOf(f, "bad")).toMatchObject({ at: "T0" });
  });

  it("applies only the commands it is told to with --only, and leaves the rest waiting", () => {
    // The dashboard's recovery poll: a pause or stop waiting for the next
    // supervisor must not be applied by an operator on its way past.
    const f = fixture("inbox-only");
    f.loopState({ stage: "stopped", stopReason: { kind: "failed", why: "no sigil", at: "T" } });
    drop(f, "p-1", { command: "pause" });
    drop(f, "s-1", { command: "stop" });
    drop(f, "bad", "not json");
    drop(f, "retry-1", { command: "retry" });
    const polled = f.run(["poll", "--only", "retry,abandon,release"]);
    expect(polled.status, polled.stderr).toBe(0);
    expect(outcomeOf(f, "retry-1")).toMatchObject({ outcome: "applied" });
    expect(pending(f).sort()).toEqual(["bad.json", "p-1.json", "s-1.json"]);
    expect(f.state()?.hold).toBeNull();
    expect(f.state()?.stop).toBeNull();

    // A list naming no command is a mistake, not "nothing to do".
    const typo = f.run(["poll", "--only", "retyr"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain("--only needs");
  });

  it("refuses an --only poll while the loop's own supervisor is alive, applying nothing", async () => {
    // The dashboard judged the supervisor dead; one started since — by hand,
    // holding no lock — is the loop's to answer, and two pollers on one
    // record is how a command is applied twice.
    const f = fixture("inbox-only-live");
    writeFileSync(join(f.root, "ralph.sh"), "sleep 30\n");
    const live = spawn("bash", [join(f.root, "ralph.sh")], { cwd: f.root, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      f.loopState({
        owner: { loop: "ralph", pid: live.pid, host: "test" },
        stage: "stopped",
        stopReason: { kind: "failed", why: "no sigil", at: "T" },
      });
      drop(f, "retry-1", { command: "retry" });
      const polled = f.run(["poll", "--only", "retry"]);
      expect(polled.status).toBe(75);
      expect(polled.stderr).toContain("supervisor");
      expect(pending(f)).toEqual(["retry-1.json"]);
      expect(f.state()).toBeNull();
    } finally {
      live.kill("SIGKILL");
    }
  });

  it("agrees with the dashboard's writer on the path and the id rule", () => {
    expect(CONTROL_SURFACE.inbox.path).toBe(CONTROL_INBOX_RELATIVE_PATH);
    // The recovery poll's fence: start.sh's own lock, and this file's own busy status.
    expect(CONTROL_SURFACE.recoveryPoll.busy).toBe(BUSY_EXIT);
    expect(readFileSync(join(REPO_ROOT, "start.sh"), "utf8")).toContain(
      `LOCK="${CONTROL_SURFACE.recoveryPoll.lock.path}"`,
    );
    for (const id of ["k", "p-1", "a.b_c", "0f8e-uuid", "../x", ".hidden", "x.tmp", "a/b", "", "x".repeat(129)]) {
      expect(dashboardSafe(id), id).toBe(isSafeCommandId(id));
    }
  });

  it("ignores itself in a project that commits .ralph/", () => {
    const f = fixture("inbox-gitignore");
    drop(f, "p-1", { command: "pause" });
    f.run(["poll"], noOrca(f));
    expect(readFileSync(join(f.root, ".ralph", "control", ".gitignore"), "utf8")).toBe("*\n");
  });
});

describe("scoping a pause or a stop to the next phase", () => {
  const read = (value: Record<string, unknown>) => commandFromInbox({ stem: "file-1", value });
  const inboxFiles = (f: Fixture): string[] => {
    const dir = join(f.root, CONTROL_INBOX_RELATIVE_PATH);
    return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
  };
  /** The supervisor's poll at the boundary between `after` and `next`. */
  const atPhase = (f: Fixture, next: string, after = "verify") =>
    f.run(["poll", "--supervised", "--phase", next, "--after", after]);

  it("reads the scope, and anything but phase as the default iteration scope", () => {
    expect(read({ command: "pause", scope: "phase" })?.scope).toBe("phase");
    expect(read({ command: "stop" })?.scope).toBe("iteration");
    expect(read({ command: "stop", scope: "iteration" })?.scope).toBe("iteration");
    // A scope nobody can read is the behaviour there was before scopes.
    expect(read({ command: "pause", scope: "whenever" })?.scope).toBe("iteration");
    expect(read({ command: "pause", scope: 7 })?.scope).toBe("iteration");
  });

  it("leaves a default-scope command at a phase boundary only while nothing holds the loop", () => {
    const at = { next: "review" as const, after: "verify" as const };
    const pause = command({ command: "pause" });
    const stop = command({ command: "stop" });
    expect(waitsForIteration(pause, state(), at)).toBe(true);
    expect(waitsForIteration(stop, state(), at)).toBe(true);
    expect(waitsForIteration(command({ command: "request-approval" }), state(), at)).toBe(true);
    // Phase-scoped, unscoped, or not at a phase boundary at all: applied.
    expect(waitsForIteration(command({ command: "pause", scope: "phase" }), state(), at)).toBe(false);
    expect(waitsForIteration(command({ command: "resume" }), state(), at)).toBe(false);
    expect(waitsForIteration(pause, state(), null)).toBe(false);
    // A parked loop is at a boundary whatever the command meant.
    const held = state({ hold: { kind: "pause", why: "held", since: "T", key: "p", gate: null, phase: "review" } });
    expect(waitsForIteration(stop, held, at)).toBe(false);
  });

  it("stamps a hold and a stop with the phase they are before, once", () => {
    const at = { next: "review" as const, after: "verify" as const };
    const hold = { kind: "pause" as const, why: "held", since: "T", key: "p", gate: null };
    expect(atBoundary(state({ hold }), at).hold).toMatchObject({ phase: "review", after: "verify" });
    // Taken at an earlier boundary, it keeps the one it was taken at.
    const earlier = state({ hold: { ...hold, phase: "implement", after: "select" } });
    expect(atBoundary(earlier, at).hold).toMatchObject({ phase: "implement", after: "select" });
    const stop = { kind: "blocked" as const, why: "enough", at: "T", key: "s", confirmation: "confirmed" as const };
    expect(atBoundary(state({ stop }), at).stop?.phase).toBe("review");
    expect(atBoundary(state(), at)).toEqual(state());
  });

  it("round-trips the boundary in the record, and drops a phase nobody can read", () => {
    const written = state({
      hold: { kind: "pause", why: "after review", since: "T", key: "p", gate: null, phase: "finish", after: "review" },
      stop: { kind: "blocked", why: "enough", at: "T", key: "s", confirmation: "confirmed", phase: "finish" },
    });
    expect(parseControlState(JSON.stringify(written))).toEqual(written);
    const odd = { ...written, hold: { ...written.hold, phase: "daydream" }, stop: { ...written.stop, phase: 3 } };
    const parsed = parseControlState(JSON.stringify(odd));
    expect(parsed?.hold?.phase).toBeUndefined();
    expect(parsed?.stop?.phase).toBeUndefined();
  });

  it("says where a phase hold and a phase stop are on the one-line panel", () => {
    expect(
      lineFor(state({ hold: { kind: "pause", why: "after review", since: "T", key: "p", gate: null, phase: "finish" } })),
    ).toContain("pause held before finish");
    expect(
      lineFor(state({ stop: { kind: "blocked", why: "enough", at: "T", key: "s", confirmation: "confirmed", phase: "finish" } })),
    ).toContain("stop (blocked, confirmed) before finish");
  });

  it("holds a phase-scoped pause at the next phase boundary, keeps holding there, and resumes", () => {
    const f = fixture("phase-pause");
    f.drop("p-1", { command: "pause", scope: "phase", why: "pause after review" });
    const held = atPhase(f, "finish", "review");
    expect(held.status, held.stderr).toBe(10);
    expect(verdict(held)).toEqual(["hold", "pause", "pause after review"]);
    expect(f.state()?.hold).toMatchObject({ kind: "pause", key: "p-1", phase: "finish", after: "review" });

    // Parked: an empty inbox keeps it held, at the boundary it was taken at.
    expect(atPhase(f, "finish", "review").status).toBe(10);
    expect(f.state()?.hold?.phase).toBe("finish");

    f.drop("r-1", { command: "resume", why: "go on" });
    expect(atPhase(f, "finish", "review").status).toBe(0);
    expect(f.state()?.hold).toBeNull();
  });

  it("leaves a default-scope pause and stop in the inbox at a phase boundary, for the iteration's", () => {
    const f = fixture("phase-default-waits");
    f.drop("p-1", { command: "pause", why: "pause after this ticket" });
    const passed = atPhase(f, "review");
    expect(passed.status, passed.stderr).toBe(0);
    expect(verdict(passed)[0]).toBe("continue");
    expect(f.state()?.hold).toBeNull();
    // Unread, not refused: the iteration boundary applies it as it always did.
    expect(inboxFiles(f)).toEqual(["p-1.json"]);
    expect(f.state()?.applied.some((entry) => entry.key === "p-1")).toBe(false);
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ key: "p-1" });
    expect(f.state()?.hold?.phase).toBeUndefined();
    f.drop("r-1", { command: "resume" });
    expect(f.run(["poll", "--supervised"]).status).toBe(0);

    f.drop("s-1", { command: "stop", why: "enough for tonight" });
    expect(atPhase(f, "finish").status).toBe(0);
    expect(f.state()?.stop).toBeNull();
    expect(inboxFiles(f)).toEqual(["s-1.json"]);
    expect(f.run(["poll", "--supervised"]).status).toBe(20);
    expect(f.state()?.stop?.phase).toBeUndefined();
  });

  it("applies a phase-scoped pause at an iteration boundary too: it is the next boundary", () => {
    const f = fixture("phase-pause-at-iteration");
    f.drop("p-1", { command: "pause", scope: "phase" });
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
    expect(f.state()?.hold?.phase).toBeUndefined();
  });

  it("stops at the next phase boundary, confirmed, naming the phase it stopped before", () => {
    const f = fixture("phase-stop");
    f.drop("s-1", { command: "stop", scope: "phase", why: "stop before it opens a PR" });
    const stopped = atPhase(f, "finish", "review");
    expect(stopped.status, stopped.stderr).toBe(20);
    expect(verdict(stopped)).toEqual(["stop", "blocked", "stop before it opens a PR"]);
    expect(f.state()?.stop).toMatchObject({ kind: "blocked", confirmation: "confirmed", key: "s-1", phase: "finish" });
    // Read again at the iteration boundary that closes the iteration, it
    // still names the phase the iteration ended before.
    expect(f.run(["poll", "--supervised"]).status).toBe(20);
    expect(f.state()?.stop?.phase).toBe("finish");
  });

  it("lets a default-scope stop end a loop parked at a phase boundary without a resume first", () => {
    const f = fixture("phase-held-stop");
    f.drop("p-1", { command: "pause", scope: "phase" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("s-1", { command: "stop", why: "not tonight after all" });
    expect(atPhase(f, "finish").status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ key: "s-1", phase: "finish" });
  });

  it("holds a phase-scoped approval request at the boundary, and not a default-scope one", () => {
    const f = fixture("phase-approval");
    f.drop("q-1", { command: "request-approval", gate: "g1", why: "ship it?" });
    expect(atPhase(f, "finish").status).toBe(0);
    expect(inboxFiles(f)).toEqual(["q-1.json"]);

    const g = fixture("phase-approval-scoped");
    g.drop("q-1", { command: "request-approval", gate: "g1", scope: "phase", why: "ship it?" });
    expect(atPhase(g, "finish").status).toBe(10);
    expect(g.state()?.hold).toMatchObject({ kind: "approval", gate: "g1", phase: "finish" });
    g.drop("a-1", { command: "approve", gate: "g1" });
    expect(atPhase(g, "finish").status).toBe(0);
  });

  it("does not stamp a boundary for an operator's poll: only the supervisor is parked at one", () => {
    const f = fixture("phase-operator");
    f.drop("p-1", { command: "pause", scope: "phase" });
    expect(f.run(["poll", "--phase", "finish"]).status).toBe(10);
    expect(f.state()?.hold?.phase).toBeUndefined();
  });

  it("refuses a boundary it cannot read, applying nothing, so the supervisor carries on", () => {
    const f = fixture("phase-unreadable");
    f.drop("s-1", { command: "stop", scope: "phase" });
    const odd = f.run(["poll", "--supervised", "--phase", "daydream"]);
    // Neither 10 nor 20: `ralph.sh` reads it as continue and resumes.
    expect(odd.status).toBe(1);
    expect(odd.stderr).toContain("--phase must be one of");
    expect(f.state()).toBeNull();
    expect(inboxFiles(f)).toEqual(["s-1.json"]);
  });
});

describe("retrying the phase that just finished", () => {
  const inboxFiles = (f: Fixture): string[] => {
    const dir = join(f.root, CONTROL_INBOX_RELATIVE_PATH);
    return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
  };
  const atPhase = (f: Fixture, next: string, after = "review") =>
    f.run(["poll", "--supervised", "--phase", next, "--after", after]);
  const outcomeOf = (f: Fixture, key: string) => f.state()?.applied.find((entry) => entry.key === key);

  it("releases a hold at the boundary and answers retry with the phase just finished", () => {
    const f = fixture("retry-phase");
    f.drop("p-1", { command: "pause", scope: "phase", why: "pause after review" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("rp-1", { command: "retry-phase", why: "new reviewer model" });
    const retried = atPhase(f, "finish");
    expect(retried.status, retried.stderr).toBe(30);
    expect(verdict(retried)).toEqual(["retry", "review", "new reviewer model"]);
    expect(f.state()?.hold).toBeNull();
    expect(f.state()?.phaseRetries).toEqual([
      { phase: "review", next: "finish", at: expect.any(String), key: "rp-1", why: "new reviewer model" },
    ]);
    expect(outcomeOf(f, "rp-1")).toMatchObject({ command: "retry-phase", outcome: "applied" });
    expect(outcomeOf(f, "rp-1")?.why).toContain("retrying review in a fresh session, then on to finish");
    expect(inboxFiles(f)).toEqual([]);

    // The answer is that poll's alone: once the retried review finishes at
    // the very same boundary, nothing is left to retry, and the history stays.
    const after = atPhase(f, "finish");
    expect(after.status).toBe(0);
    expect(verdict(after)[0]).toBe("continue");
    expect(f.state()?.phaseRetries).toHaveLength(1);
  });

  it("takes a pause and a retry sent together as a retry at the boundary they reach", () => {
    const f = fixture("retry-phase-batch");
    f.drop("a-p", { command: "pause", scope: "phase" });
    f.drop("b-rp", { command: "retry-phase" });
    const retried = atPhase(f, "verify", "implement");
    expect(retried.status, retried.stderr).toBe(30);
    expect(verdict(retried).slice(0, 2)).toEqual(["retry", "implement"]);
  });

  it.each([
    ["not held", (f: Fixture) => atPhase(f, "finish"), "not held at the boundary before finish"],
    ["between iterations", (f: Fixture) => f.run(["poll", "--supervised"]), "not held at a phase boundary"],
    ["an operator's poll", (f: Fixture) => f.run(["poll", "--phase", "finish", "--after", "review"]), "not held at a phase boundary"],
  ])("refuses it, with the reason, when %s", (_label, poll, reason) => {
    const f = fixture("retry-phase-refused");
    f.drop("rp-1", { command: "retry-phase" });
    const answered = poll(f);
    expect(answered.status).not.toBe(30);
    expect(outcomeOf(f, "rp-1")).toMatchObject({ outcome: "refused" });
    expect(outcomeOf(f, "rp-1")?.why).toContain(reason);
    expect(f.state()?.phaseRetries).toEqual([]);
    // Settled, not left for a later boundary it was never about.
    expect(inboxFiles(f)).toEqual([]);
  });

  it("refuses it while held between iterations, and keeps the hold", () => {
    const f = fixture("retry-phase-iteration-hold");
    f.drop("p-1", { command: "pause" });
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
    f.drop("rp-1", { command: "retry-phase" });
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
    expect(outcomeOf(f, "rp-1")?.outcome).toBe("refused");
    expect(f.state()?.hold).toMatchObject({ key: "p-1" });
  });

  it("refuses a hold taken at another boundary, and lets a stop outrank a retry", () => {
    const stale = state({ hold: { kind: "pause", why: "h", since: "T", key: "p", gate: null, phase: "verify", after: "implement" } });
    const f = fixture("retry-phase-stale");
    writeFileSync(join(f.root, CONTROL_STATE_RELATIVE_PATH), JSON.stringify({ ...stale, ralphRun: "ralph-run-1" }));
    f.drop("rp-1", { command: "retry-phase" });
    expect(atPhase(f, "finish").status).toBe(10);
    expect(outcomeOf(f, "rp-1")?.why).toContain("the hold was taken before verify");

    const retry = { phase: "review" as const, next: "finish" as const, at: "T", key: "rp", why: "again" };
    const stopped = state({ stop: { kind: "blocked", why: "enough", at: "T", key: "s", confirmation: "confirmed" } });
    expect(verdictFor(stopped, retry).action).toBe("stop");
    expect(verdictFor(state(), retry)).toEqual({ action: "retry", detail: "review", why: "again" });
  });

  it("round-trips the retry history, and drops a row naming no phase", () => {
    const written = state({ phaseRetries: [{ phase: "review", next: "finish", at: "T", key: "rp", why: "again" }] });
    expect(parseControlState(JSON.stringify(written))).toEqual(written);
    const odd = { ...written, phaseRetries: [{ phase: "daydream", next: "finish" }, "x"] };
    expect(parseControlState(JSON.stringify(odd))?.phaseRetries).toEqual([]);
    // A record written before retries existed reads as none.
    const { phaseRetries: _gone, ...older } = written;
    expect(parseControlState(JSON.stringify(older))?.phaseRetries).toEqual([]);
  });
});

describe("a gate before a named phase", () => {
  const read = (value: Record<string, unknown>) => commandFromInbox({ stem: "file-1", value });
  /** The supervisor's poll at the boundary between `after` and `next`. */
  const atPhase = (f: Fixture, next: string, after = "review", env: Record<string, string> = {}) =>
    f.run(["poll", "--supervised", "--phase", next, "--after", after], env);
  const gate = (phase: "select" | "finish", asked: string | null = null) => ({
    phase,
    why: null,
    since: "T",
    key: `arm-${phase}`,
    asked,
  });

  it("reads the phase a gate command names, and no phase rather than a guessed one", () => {
    expect(read({ command: "arm-gate", phase: "finish" })).toMatchObject({ command: "arm-gate", phase: "finish" });
    expect(read({ command: "disarm-gate", phase: "select" })?.phase).toBe("select");
    expect(read({ command: "arm-gate", phase: "lunch" })?.phase).toBeNull();
    expect(read({ command: "arm-gate" })?.phase).toBeNull();
  });

  it("asks once per pass, never over a hold or a stop, and not at all with no gate armed", () => {
    const at = { next: "finish" as const, after: "review" as const };
    expect(gateAt(state(), at, "run#2", "T1")).toEqual(state());
    const armed = state({ gates: [gate("finish")] });
    const asked = gateAt(armed, at, "run#2", "T1");
    expect(asked.hold).toEqual({
      kind: "approval",
      why: "decision gate before-finish: continue into finish?",
      since: "T1",
      key: "arm-finish",
      gate: gateName("finish"),
      phase: "finish",
      after: "review",
    });
    expect(asked.gates[0]?.asked).toBe("run#2");
    // Answered, the same pass does not ask again; the next one does.
    const answered = { ...asked, hold: null };
    expect(gateAt(answered, at, "run#2", "T2")).toBe(answered);
    expect(gateAt(answered, at, "run#3", "T2").hold?.gate).toBe("before-finish");
    // Another phase's boundary, a pause, or a stop: no question.
    expect(gateAt(armed, { next: "review", after: "verify" }, "run#2", "T1")).toBe(armed);
    const paused = state({ gates: [gate("finish")], hold: { kind: "pause", why: "p", since: "T", key: "p", gate: null } });
    expect(gateAt(paused, at, "run#2", "T1")).toBe(paused);
    const stopped = state({
      gates: [gate("finish")],
      stop: { kind: "blocked", why: "enough", at: "T", key: "s", confirmation: "confirmed" },
    });
    expect(gateAt(stopped, at, "run#2", "T1")).toBe(stopped);
    // The iteration boundary is the one before select.
    expect(gateAt(state({ gates: [gate("select")] }), null, "run#2", "T1").hold).toMatchObject({
      gate: "before-select",
      phase: "select",
    });
  });

  it("counts a pass by the run and the loop state's iteration", () => {
    const loop = { run: "run-a", iteration: { index: 4, max: 9 } } as Parameters<typeof gatePassFor>[1];
    expect(gatePassFor({ run: "run-a" }, loop)).toBe("run-a#4");
    // Another run's loop state says nothing about this run's iterations.
    expect(gatePassFor({ run: "run-b" }, loop)).toBe("run-b#-");
    expect(gatePassFor({ run: "run-b" }, null)).toBe("run-b#-");
  });

  it("round-trips armed gates, and drops a malformed or repeated one rather than holding on it", () => {
    const written = state({ gates: [gate("select"), gate("finish", "ralph-run-1#2")] });
    expect(parseControlState(JSON.stringify(written))).toEqual(written);
    const odd = { ...written, gates: [{ phase: "lunch" }, "finish", gate("finish"), { ...gate("finish"), key: "again" }] };
    expect(parseControlState(JSON.stringify(odd))?.gates).toEqual([gate("finish")]);
    // A record from before gates reads as none armed.
    const older: Record<string, unknown> = { ...written };
    delete older.gates;
    expect(parseControlState(JSON.stringify(older))?.gates).toEqual([]);
    expect(lineFor(written)).toContain("gated before select, finish");
  });

  it("arms and disarms over the inbox at any boundary, refusing a phase it cannot read", () => {
    const f = fixture("gate-arm");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish", why: "a person opens the PRs" });
    f.drop("a-2", { command: "arm-gate", phase: "lunch" });
    // Armed at a boundary that is not the gated one: nothing holds.
    const armed = atPhase(f, "verify", "implement");
    expect(armed.status, armed.stderr).toBe(0);
    expect(f.state()?.gates).toEqual([
      { phase: "finish", why: "a person opens the PRs", since: expect.any(String), key: "a-1", asked: null },
    ]);
    const refused = f.state()?.applied.find((entry) => entry.key === "a-2");
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused?.why).toContain("arm-gate needs a phase");

    f.drop("a-3", { command: "arm-gate", phase: "finish" });
    expect(f.run(["poll", "--supervised"]).status).toBe(0);
    expect(f.state()?.gates).toHaveLength(1);
    expect(f.state()?.applied.at(-1)?.why).toContain("already armed");

    f.drop("d-1", { command: "disarm-gate", phase: "finish" });
    expect(f.run(["poll", "--supervised"]).status).toBe(0);
    expect(f.state()?.gates).toEqual([]);
    // Disarmed, the boundary it gated is passed as before.
    expect(atPhase(f, "finish").status).toBe(0);
    expect(f.state()?.hold).toBeNull();
  });

  it("holds for approval at an armed boundary, keeps holding, and approve continues the same pass", () => {
    const f = fixture("gate-approve");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish" });
    const held = atPhase(f, "finish");
    expect(held.status, held.stderr).toBe(10);
    expect(verdict(held)).toEqual(["hold", "approval", "decision gate before-finish: continue into finish?"]);
    expect(f.state()?.hold).toMatchObject({ kind: "approval", gate: "before-finish", phase: "finish", after: "review" });

    expect(atPhase(f, "finish").status).toBe(10);
    // The existing approve answers it, named or not.
    f.drop("ok-1", { command: "approve", gate: "before-finish", why: "looks right" });
    const released = atPhase(f, "finish");
    expect(released.status, released.stdout).toBe(0);
    expect(f.state()?.hold).toBeNull();
    // Not asked again at the same boundary of the same iteration…
    expect(atPhase(f, "finish").status).toBe(0);
    // …and still armed for the next one.
    f.loopState({ iteration: { index: 3, max: 15 } });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("ok-2", { command: "approve" });
    expect(atPhase(f, "finish").status).toBe(0);
    expect(f.state()?.gates.map((row) => row.phase)).toEqual(["finish"]);
  });

  it("turns a denial into a stop before the gated phase, recorded, with the gate still armed", () => {
    const f = fixture("gate-deny");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("no-1", { command: "deny", why: "not this one" });
    const stopped = atPhase(f, "finish");
    expect(stopped.status, stopped.stdout).toBe(20);
    expect(verdict(stopped)).toEqual(["stop", "blocked", "approval denied — not this one"]);
    expect(f.state()?.stop).toMatchObject({ kind: "blocked", confirmation: "confirmed", key: "no-1", phase: "finish" });
    expect(f.state()?.applied.find((entry) => entry.key === "no-1")).toMatchObject({ outcome: "applied" });
    expect(f.state()?.gates.map((row) => row.phase)).toEqual(["finish"]);
  });

  it("leaves a question already asked standing when its gate is disarmed", () => {
    const f = fixture("gate-disarm-waiting");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("d-1", { command: "disarm-gate", phase: "finish" });
    expect(atPhase(f, "finish").status).toBe(10);
    expect(f.state()?.gates).toEqual([]);
    expect(f.state()?.applied.at(-1)?.why).toContain("still needs an answer");
    f.drop("ok-1", { command: "approve" });
    expect(atPhase(f, "finish").status).toBe(0);
  });

  it("stays armed across a supervisor restart, and asks the new run again", () => {
    const f = fixture("gate-restart");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("no-1", { command: "deny" });
    expect(atPhase(f, "finish").status).toBe(20);

    // A new supervisor: the confirmed stop is finished, the gate is not.
    const next = { RALPH_RUN_ID: "ralph-run-2" };
    f.loopState({ run: "ralph-run-2", iteration: { index: 1, max: 15 } });
    expect(f.run(["poll", "--supervised"], next).status).toBe(0);
    expect(f.state()).toMatchObject({ ralphRun: "ralph-run-2", stop: null });
    expect(f.state()?.gates.map((row) => row.phase)).toEqual(["finish"]);
    expect(atPhase(f, "finish", "review", next).status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ gate: "before-finish" });
  });

  it("lets retry-phase answer a gate's hold, and asks again once the retried phase is done", () => {
    const f = fixture("gate-retry-phase");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "finish" });
    expect(atPhase(f, "finish").status).toBe(10);
    f.drop("rp-1", { command: "retry-phase", why: "review it again" });
    const retried = atPhase(f, "finish");
    // Released to rerun review, with no new question in the same poll.
    expect(retried.status, retried.stdout).toBe(30);
    expect(verdict(retried)).toEqual(["retry", "review", "review it again"]);
    expect(f.state()?.hold).toBeNull();
    // The retried review reaches the same boundary: new work, asked again.
    expect(atPhase(f, "finish").status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ gate: "before-finish" });
    f.drop("ok-1", { command: "approve" });
    expect(atPhase(f, "finish").status).toBe(0);
    expect(gatePassFor({ run: "r" }, null, 2)).toBe("r#-+2");
  });

  it("gates select at the iteration boundary, once per iteration", () => {
    const f = fixture("gate-select");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "select" });
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ gate: "before-select", phase: "select" });
    f.drop("ok-1", { command: "approve" });
    expect(f.run(["poll", "--supervised"]).status).toBe(0);
    // A second checkpoint before the same iteration starts is the same pass.
    expect(f.run(["poll", "--supervised"]).status).toBe(0);
    f.loopState({ iteration: { index: 3, max: 15 } });
    expect(f.run(["poll", "--supervised"]).status).toBe(10);
  });

  it("never asks at an operator's poll or a recovery poll: only the supervisor is at a boundary", () => {
    const f = fixture("gate-operator");
    f.loopState({});
    f.drop("a-1", { command: "arm-gate", phase: "select" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.run(["poll", "--phase", "select"]).status).toBe(0);
    expect(f.run(["poll", "--supervised", "--only", "retry"]).status).toBe(0);
    expect(f.state()?.hold).toBeNull();
  });
});

describe("recording a stop an operator carried out with a signal", () => {
  const leaseFor = (f: Fixture, run: string): void =>
    f.claim(703, { run, worktree: f.root, expiresAt: new Date(Date.now() + 600_000).toISOString() });

  it("records a confirmed interrupted stop with the iteration and the ticket, and keeps the claim", () => {
    const f = fixture("interrupted");
    f.loopState({});
    leaseFor(f, "ralph-run-1");
    const ran = f.run(["interrupted", "--key", "now-1", "--why", "the model held a turn for an hour"]);
    expect(ran.status).toBe(0);
    expect(f.state()?.stop).toMatchObject({
      kind: "interrupted",
      confirmation: "confirmed",
      key: "now-1",
      why: "the model held a turn for an hour",
      iteration: 2,
      issue: 703,
    });
    expect(f.state()?.applied.at(-1)).toMatchObject({ key: "now-1", command: "stop", outcome: "applied" });
    expect(JSON.parse(ran.stdout)).toMatchObject({ stop: { kind: "interrupted", issue: 703 } });
    // The loop state says how it ended, under the run and owner it already names.
    const loop = JSON.parse(readFileSync(join(f.root, STATE_RELATIVE_PATH), "utf8"));
    expect(loop).toMatchObject({
      run: "ralph-run-1",
      stage: "stopped",
      owner: { pid: 2 ** 22 },
      stopReason: { kind: "interrupted", why: "the model held a turn for an hour" },
      lastEvent: { name: "interrupted" },
    });
    // A killed iteration leaves work behind; the claim stays until its lease lapses.
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.calls()).toEqual([]);
  });

  it("names no ticket when the run holds no claim, and answers a replay from the record", () => {
    const f = fixture("interrupted-no-claim");
    f.loopState({});
    leaseFor(f, "ralph-run-0");
    expect(f.run(["interrupted", "--key", "now-1", "--why", "w"]).status).toBe(0);
    expect(f.state()?.stop).toMatchObject({ issue: null, iteration: 2 });
    const again = f.run(["interrupted", "--key", "now-1", "--why", "a second click"]);
    expect(again.status).toBe(0);
    expect(f.state()?.stop?.why).toBe("w");
    expect(f.state()?.applied.filter((entry) => entry.key === "now-1")).toHaveLength(1);
  });

  it("refuses while the loop's own supervisor is alive, writing nothing", async () => {
    const f = fixture("interrupted-live");
    writeFileSync(join(f.root, "ralph.sh"), "sleep 30\n");
    const live = spawn("bash", [join(f.root, "ralph.sh")], { cwd: f.root, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      f.loopState({ owner: { loop: "ralph", pid: live.pid, host: "test" } });
      const ran = f.run(["interrupted", "--key", "now-1", "--why", "w"]);
      expect(ran.status).toBe(BUSY_EXIT);
      expect(ran.stderr).toContain("supervisor");
      expect(f.state()).toBeNull();
    } finally {
      live.kill("SIGKILL");
    }
  });

  it("adopts an earlier run's control record, as a poll would", () => {
    const f = fixture("interrupted-adopts");
    f.loopState({});
    writeFileSync(
      join(f.root, CONTROL_STATE_RELATIVE_PATH),
      JSON.stringify({ ...blankControlState("ralph-run-0", "ralph"), hold: { kind: "pause", why: "hold on", since: "T", key: "p", gate: null } }),
    );
    expect(f.run(["interrupted", "--key", "now-1", "--why", "w"]).status).toBe(0);
    expect(f.state()).toMatchObject({ ralphRun: "ralph-run-1", hold: { kind: "pause" }, stop: { kind: "interrupted" } });
  });

  it("refuses to write over another run's records", () => {
    const f = fixture("interrupted-other-run");
    f.loopState({});
    const other = f.run(["interrupted", "--key", "now-1", "--why", "w"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("ralph-run-1");
    expect(f.state()).toBeNull();
    const none = fixture("interrupted-no-state");
    const missing = none.run(["interrupted", "--key", "now-1", "--why", "w"]);
    expect(missing.status).toBe(1);
    expect(none.state()).toBeNull();
  });

  it("is not carried into the next run: Resume work starts clean", () => {
    const f = fixture("interrupted-then-resume");
    f.loopState({});
    expect(f.run(["interrupted", "--key", "now-1", "--why", "w"]).status).toBe(0);
    const resumed = f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(resumed.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
  });

  it("lets the supervisor record its own signal ending with --self, only as the owner on record", () => {
    const f = fixture("interrupted-self");
    f.loopState({});
    leaseFor(f, "ralph-run-1");
    const wrong = f.run(["interrupted", "--self", "12345", "--key", "signal-1", "--why", "stopped by SIGTERM"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("not 12345");
    expect(f.state()).toBeNull();
    const ran = f.run(["interrupted", "--self", String(2 ** 22), "--key", "signal-1", "--why", "stopped by SIGTERM"]);
    expect(ran.status).toBe(0);
    expect(f.state()?.stop).toMatchObject({ kind: "interrupted", confirmation: "confirmed", why: "stopped by SIGTERM", issue: 703 });
    const loop = JSON.parse(readFileSync(join(f.root, STATE_RELATIVE_PATH), "utf8"));
    expect(loop).toMatchObject({ stage: "stopped", stopReason: { kind: "interrupted", why: "stopped by SIGTERM" } });
    expect(Object.keys(f.leases())).toEqual(["703"]);
  });

  it("lets a Stop now that follows the trap's ending replace its reason in both records", () => {
    const f = fixture("interrupted-self-then-stop-now");
    f.loopState({});
    expect(f.run(["interrupted", "--self", String(2 ** 22), "--key", "signal-1", "--why", "stopped by SIGTERM"]).status).toBe(0);
    expect(f.run(["interrupted", "--key", "now-1", "--why", "stopped now from the dashboard"]).status).toBe(0);
    expect(f.state()?.stop).toMatchObject({ key: "now-1", why: "stopped now from the dashboard" });
    const loop = JSON.parse(readFileSync(join(f.root, STATE_RELATIVE_PATH), "utf8"));
    expect(loop.stopReason).toMatchObject({ kind: "interrupted", why: "stopped now from the dashboard" });
  });

  it("is never a kind an inbox stop can ask for", () => {
    // Only a signal the dashboard verified and sent may be recorded as one.
    expect(commandFromInbox({ stem: "s", value: { command: "stop", stop: "interrupted" } })?.stopKind).toBe("blocked");
  });
});

describe("a project put to sleep", () => {
  const marker = (f: Fixture): string => join(f.root, "gitcommon", SLEEP_FILE_NAME);
  const asleep = (f: Fixture, body: Record<string, unknown> | string = {}): void =>
    writeFileSync(
      marker(f),
      typeof body === "string"
        ? body
        : JSON.stringify({ version: 1, since: "2026-11-05T23:00:00.000Z", why: "bedtime", by: "dashboard", ...body }),
    );
  const noOrca = (f: Fixture): Record<string, string> => ({ RALPH_ORCA_CLI: join(f.root, "no-such-orca") });
  const sleeping = { since: "2026-11-05T23:00:00.000Z", why: "bedtime", by: "dashboard" };

  it("turns only a continue into a hold, and only between iterations", () => {
    const go = verdictFor(state());
    expect(sleepingVerdict(go, true, sleeping)).toMatchObject({ action: "hold", detail: "sleep" });
    expect(sleepingVerdict(go, true, sleeping).why).toContain("bedtime");
    // Soft: an iteration that has started is let finish.
    expect(sleepingVerdict(go, false, sleeping)).toBe(go);
    expect(sleepingVerdict(go, true, null)).toBe(go);
    // A stop says more than "asleep", and must still end the run.
    const stop = verdictFor(state({ stop: { kind: "blocked", why: "enough", at: "x", key: "k", confirmation: "pending" } }));
    expect(sleepingVerdict(stop, true, sleeping)).toBe(stop);
  });

  it("holds every loop of the project at the checkpoint between iterations, and lets it go on waking", () => {
    const f = fixture("sleep-hold");
    asleep(f);
    const held = f.run(["poll", "--supervised"], noOrca(f));
    expect(held.status).toBe(10);
    expect(verdict(held).slice(0, 2)).toEqual(["hold", "sleep"]);
    expect(verdict(held)[2]).toContain("bedtime");
    // Derived, never recorded: nothing in the loop's own record to clear.
    expect(f.state()?.hold ?? null).toBeNull();
    rmSync(marker(f));
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(0);
  });

  it("lets an iteration that has started finish: no hold at a phase boundary or between two turns", () => {
    const f = fixture("sleep-soft");
    asleep(f);
    expect(f.run(["poll", "--supervised", "--phase", "review", "--after", "implement"], noOrca(f)).status).toBe(0);
    expect(f.run(["poll", "--supervised", "--in-iteration"], noOrca(f)).status).toBe(0);
  });

  it("does not hold an operator's poll: the dashboard's recovery poll is about the inbox", () => {
    const f = fixture("sleep-operator");
    asleep(f);
    expect(f.run(["poll", "--only", "abandon,release"], noOrca(f)).status).toBe(0);
    expect(f.run(["poll"], noOrca(f)).status).toBe(0);
  });

  it("is outranked by a stop, and a resume does not wake one loop of a sleeping project", () => {
    const f = fixture("sleep-commands");
    asleep(f);
    f.drop("p-1", { command: "pause", why: "mine" });
    expect(verdict(f.run(["poll", "--supervised"], noOrca(f))).slice(0, 2)).toEqual(["hold", "pause"]);
    f.drop("r-1", { command: "resume" });
    expect(verdict(f.run(["poll", "--supervised"], noOrca(f))).slice(0, 2)).toEqual(["hold", "sleep"]);
    f.drop("s-1", { command: "stop", why: "done for good" });
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(20);
  });

  it("reads a marker nobody can parse as awake, never as a hold", () => {
    const f = fixture("sleep-garbled");
    asleep(f, "{ half a marker");
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(0);
    asleep(f, { version: 2 });
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(0);
    asleep(f, { since: "not a time" });
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(0);
  });

  it("wakes the waits between iterations, but not the host-lease wait inside one", () => {
    const f = fixture("sleep-waits");
    // `hasPendingControl` asks git for the common directory, so it runs where
    // the fixture's fake `git` answers: first on PATH.
    const path = process.env.PATH;
    process.env.PATH = `${join(f.root, "bin")}:${path ?? ""}`;
    try {
      expect(hasPendingControl(f.root)).toBe(false);
      asleep(f);
      expect(hasPendingControl(f.root)).toBe(true);
      expect(hasPendingCommand(f.root)).toBe(false);
    } finally {
      process.env.PATH = path;
    }
  });

  it("is named in the status a human reads, and kept off the one-line form", () => {
    const f = fixture("sleep-status");
    asleep(f);
    expect(f.run(["status"]).stdout).toContain("Project: asleep");
    expect(f.run(["status", "--line"]).stdout.trim().split("\n")).toHaveLength(1);
  });
});
