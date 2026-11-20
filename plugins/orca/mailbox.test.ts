// @vitest-environment node
/**
 * The Orca route into a loop, end to end: an Orca mailbox and gate list, the
 * plugin host, this plugin's `inbox` and `on-event` hooks, and the core
 * control channel — all real, with only `orca` and `git` faked on PATH.
 *
 * Every poll here is the core's `controls.ts poll` with `RALPH_PLUGINS=orca`,
 * so a case passes only if a command sent through Orca reaches the loop
 * through the inbox and obeys the core's fences, and the answer reaches Orca
 * through the `control` events the core emits. The properties are the ones the
 * channel had when it was Orca's alone:
 *
 * 1. *Every control transition is visible* — verdict, exit status and record.
 * 2. *A replayed command is applied once*, whichever route it came by.
 * 3. *An unexpired lease survives recovery.*
 * 4. *An absent Orca costs the loop nothing*: a degraded route, a `continue`
 *    verdict and exit 0.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeProjectConfig } from "../../dashboard/fixtures";

import {
  CONTROL_STATE_RELATIVE_PATH,
  DEFERRAL_LIMIT,
  parseControlState,
  type ControlState,
} from "../../controls";
import { STATE_RELATIVE_PATH } from "../../loop-state";
import { claimLease, type ClaimLease, type LeaseStore } from "../../claim-lease";
import { CONTROL_INBOX_RELATIVE_PATH, CONTROL_PROCESSED_RELATIVE_PATH } from "../../control-inbox";
import { ORCA_BINDING_RELATIVE_PATH } from "./binding";
import { ORCA_STATE_RELATIVE_PATH } from "./lifecycle";
import {
  CONTROL_VERBS,
  MAILBOX_STATE_RELATIVE_PATH,
  commandFrom,
  deliveryFrom,
  gatesFrom,
  inboxKey,
  isDenial,
  parseMailboxState,
  type MailboxState,
} from "./mailbox";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs the Orca mailbox through bash and bun");

const REPO_ROOT = join(__dirname, "..", "..");

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

describe("reading a command off a message", () => {
  it("takes a control envelope out of the payload Orca returns as a string", () => {
    const parsed = commandFrom({
      id: "msg_abc",
      sequence: 7,
      payload: JSON.stringify({ control: { command: "stop", run: "ralph-run-1", stop: "failed" } }),
    });
    expect(parsed).toMatchObject({
      key: "msg_abc",
      envelope: { command: "stop", run: "ralph-run-1", stop: "failed" },
      message: "msg_abc",
      sequence: 7,
    });
  });

  it("accepts the short form an operator types first", () => {
    expect(commandFrom({ id: "msg_1", payload: { command: "pause" } })?.envelope.command).toBe("pause");
  });

  it("prefers the operator's own id, so a re-send is the same command", () => {
    const row = { id: "msg_2", payload: { control: { command: "pause", id: "hold-the-loop" } } };
    expect(commandFrom(row)?.key).toBe("hold-the-loop");
  });

  it("reads no command rather than a guessed one", () => {
    // Every one of these is ordinary mail on the loop's own Run: the mirror's
    // heartbeats and statuses land in the same mailbox this reads.
    expect(commandFrom({ id: "msg_3", payload: JSON.stringify({ phase: "iteration" }) })).toBeNull();
    expect(commandFrom({ id: "msg_4", payload: "not json at all" })).toBeNull();
    expect(commandFrom({ id: "msg_5", payload: { control: { command: "self-destruct" } } })).toBeNull();
    expect(commandFrom({ payload: { command: "pause" } })).toBeNull();
  });

  it("names the file after a key the inbox accepts, stably", () => {
    // Orca's ids and an operator's own are not promised to be file-safe; the
    // key is hashed rather than dropped, so a replay is still one command.
    expect(inboxKey("msg_ok-1")).toBe("msg_ok-1");
    expect(inboxKey("a/b c")).toMatch(/^orca-[0-9a-f]{32}$/);
    expect(inboxKey("a/b c")).toBe(inboxKey("a/b c"));
  });
});

describe("reading Orca's receipts", () => {
  it("takes the messages and the acknowledgement token out of a check", () => {
    expect(deliveryFrom({ messages: [{ id: "m1" }], deliveryId: "d1" })).toEqual({
      messages: [{ id: "m1" }],
      ack: "d1",
    });
  });

  it("reads a batch it cannot acknowledge rather than reading nothing", () => {
    // A missing ack costs a replay, and a replay is already safe.
    expect(deliveryFrom({ messages: [{ id: "m1" }] })).toEqual({ messages: [{ id: "m1" }], ack: null });
    expect(deliveryFrom(null)).toEqual({ messages: [], ack: null });
  });

  it("takes gates out of whichever key holds them", () => {
    expect(gatesFrom({ gates: [{ id: "g1", task_id: "task_1", status: "pending", question: "?" }] })).toEqual([
      { id: "g1", task: "task_1", status: "pending", question: "?", resolution: null },
    ]);
    expect(gatesFrom({})).toEqual([]);
  });

  it("reads a denial as a denial and everything else as an answer", () => {
    expect(isDenial("deny — not this ticket")).toBe(true);
    expect(isDenial("rejected")).toBe(true);
    expect(isDenial("go ahead")).toBe(false);
    // A resolution exists because a human wrote one; holding forever on words
    // this regex does not know is worse than proceeding on an answer given.
    expect(isDenial("sure, but rebase first")).toBe(false);
    expect(isDenial(null)).toBe(false);
  });
});

describe("the command guard", () => {
  it("names only verbs that read, answer, or fence without claiming a stop", () => {
    // `worker-stop` is the absence that matters: a stop applied here is
    // applied for an operator who cannot see the process.
    expect([...CONTROL_VERBS]).toEqual([
      "orchestration check",
      "orchestration run-current",
      "orchestration run-use",
      "orchestration reply",
      "orchestration send",
      "orchestration gate-list",
      "orchestration worker-abandon",
      "orchestration worker-release",
    ]);
    expect(CONTROL_VERBS).not.toContain("orchestration worker-stop");
    expect(CONTROL_VERBS).not.toContain("orchestration worker-start");
    expect(CONTROL_VERBS).not.toContain("terminal send");
  });
});

/* --------------------------------------------------------------------------
 * End to end, against a fake Orca.
 * ----------------------------------------------------------------------- */

interface Fixture {
  root: string;
  calls: () => string[];
  /** Fill the mailbox the next `check` returns. */
  queue: (messages: Record<string, unknown>[], ack?: string | null) => void;
  gates: (gates: Record<string, unknown>[]) => void;
  claim: (issue: number, over?: Partial<ClaimLease>) => void;
  leases: () => Record<string, ClaimLease>;
  /** Hold the lease store's lock, as a claim writer or a heartbeat does. */
  lock: (held: boolean) => void;
  adapter: (over: Record<string, unknown>) => void;
  binding: (over?: Record<string, unknown>) => void;
  loopState: (over: Record<string, unknown>) => void;
  state: () => ControlState | null;
  /** This route's own record: what it delivered, and its degraded window. */
  mailbox: () => MailboxState | null;
  /** Command files still waiting in the inbox. */
  pending: () => string[];
  run: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
  /** The poll as a shell runs it — the seam `applierFor` used to get wrong. */
  shell: (script: string) => SpawnSyncReturns<string>;
}

function fixture(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `ralph-orca-mailbox-${label}-`));
  scratchRoots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(root);
  mkdirSync(join(root, "gitcommon"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);

  const callLog = join(root, "orca.calls");
  const mailbox = join(root, "mailbox.json");
  const gateFile = join(root, "gates.json");
  writeFileSync(mailbox, JSON.stringify({ ok: true, result: { messages: [] } }));
  writeFileSync(gateFile, JSON.stringify({ ok: true, result: { gates: [] } }));

  const orca = join(bin, "orca");
  writeFileSync(
    orca,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
      'case "$1 $2" in',
      '  "orchestration check")',
      // An acknowledging check drains the mailbox, exactly as the real one
      // does — which is what makes the replay case below a REPLAY rather than
      // a second delivery of a message the poller has already consumed.
      '    case "$*" in *--ack*)',
      `      printf '{"ok":true,"result":{"messages":[]}}\\n' > ${JSON.stringify(mailbox)}.next`,
      `      mv ${JSON.stringify(mailbox)}.next ${JSON.stringify(mailbox)}`,
      '      printf \'{"ok":true,"result":{"messages":[]}}\\n\'',
      "      exit 0 ;;",
      "    esac",
      `    cat ${JSON.stringify(mailbox)} ;;`,
      `  "orchestration gate-list") cat ${JSON.stringify(gateFile)} ;;`,
      '  *) printf \'{"ok":true,"result":{}}\\n\' ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
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

  // A tracker with no labels on anything: `release` and `abandon` look for the
  // claim label before taking it off, and must never reach the real `gh`.
  const gh = join(bin, "gh");
  writeFileSync(gh, ["#!/bin/sh", `[ "$2" = "view" ] && printf '{"labels":[]}\\n'`, "exit 0", ""].join("\n"));
  chmodSync(gh, 0o755);

  const environment: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: root,
    RALPH_ORCA_CLI: orca,
    RALPH_LOOP_NAME: "ralph",
    RALPH_RUN_ID: "ralph-run-1",
    ORCA_TERMINAL_HANDLE: "term_loop",
    RALPH_PLUGINS: "orca",
  };

  const leasePath = join(root, "gitcommon", "ralph-claim-leases.json");
  const readLeases = (): Record<string, ClaimLease> =>
    existsSync(leasePath) ? JSON.parse(readFileSync(leasePath, "utf8")).leases : {};

  return {
    root,
    calls: () =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf8").split("\n").filter((line) => line !== "")
        : [],
    queue: (messages, ack = "delivery-1") => {
      writeFileSync(
        mailbox,
        JSON.stringify({
          ok: true,
          result: { messages, ...(ack === null ? {} : { deliveryId: ack }) },
        }),
      );
    },
    gates: (gates) => writeFileSync(gateFile, JSON.stringify({ ok: true, result: { gates } })),
    claim: (issue, over = {}) => {
      // Through the real constructor rather than a literal, so a lease this
      // fixture writes is one `next-tasks.ts` could have written — the shape
      // recovery is asserted against is not a second opinion about it.
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
    adapter: (over) =>
      writeFileSync(
        join(root, ORCA_STATE_RELATIVE_PATH),
        JSON.stringify({
          version: 1,
          ralphRun: "ralph-run-1",
          loop: "ralph",
          worktree: root,
          terminal: "term_loop",
          orcaRun: "run_fake",
          task: { issue: 703, id: "task_fake" },
          attempt: null,
          degraded: null,
          displacedBinding: null,
          lastRejected: null,
          lastEvent: null,
          ...over,
        }),
      ),
    binding: (over = {}) =>
      writeFileSync(
        join(root, ORCA_BINDING_RELATIVE_PATH),
        JSON.stringify({
          version: 1,
          ralphRun: "ralph-run-1",
          orcaRun: "run_fake",
          worktree: root,
          consumer: "term_observer",
          boundAt: "2026-09-13T00:00:00.000Z",
          ...over,
        }),
      ),
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
    state: () => {
      const path = join(root, CONTROL_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseControlState(readFileSync(path, "utf8")) : null;
    },
    mailbox: () => {
      const path = join(root, MAILBOX_STATE_RELATIVE_PATH);
      return existsSync(path) ? parseMailboxState(readFileSync(path, "utf8")) : null;
    },
    pending: () => {
      const dir = join(root, CONTROL_INBOX_RELATIVE_PATH);
      return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
    },
    run: (args, env = {}) =>
      spawnSync(BUN, [join(REPO_ROOT, "controls.ts"), ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, ...environment, ...env },
      }),
    shell: (script) =>
      spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, ...environment },
      }),
  };
}

/** The message an operator's `orchestration send --payload` produces. */
const mail = (control: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: `msg_${String(control.command)}`,
  from_handle: "term_operator",
  sequence: 1,
  type: "status",
  payload: JSON.stringify({ control }),
  ...over,
});

/** The machine line `ralph.sh` reads: `<verdict>\t<detail>\t<why>`. */
const verdict = (run: SpawnSyncReturns<string>): string[] =>
  run.stdout.split("\n")[0]?.split("\t") ?? [];

describe("pausing and resuming a loop", () => {
  it("consumes and acknowledges a pause through the replacement observer terminal", () => {
    const f = fixture("pause-after-terminal-rotation");
    f.adapter({ terminal: "term_disconnected" });
    f.binding();
    f.queue([mail({ command: "pause", why: "hold after rotation" })]);

    const paused = f.run(["poll"], { ORCA_TERMINAL_HANDLE: "term_disconnected" });
    expect(paused.status, paused.stderr).toBe(10);
    expect(f.state()?.hold).toMatchObject({ kind: "pause", why: "hold after rotation" });
    const checks = f.calls().filter((line) => line.startsWith("orchestration check"));
    expect(checks).toEqual([
      "orchestration check --terminal term_observer --json",
      "orchestration check --terminal term_observer --ack delivery-1 --json",
    ]);
  });

  it("does not consume through a binding owned by a stale adapter run", () => {
    const f = fixture("stale-adapter-binding");
    f.adapter({ ralphRun: "ralph-run-replaced", terminal: "term_disconnected" });
    f.binding();
    f.queue([mail({ command: "pause", why: "use only the current consumer" })]);

    const paused = f.run(["poll"], { ORCA_TERMINAL_HANDLE: "term_current" });
    expect(paused.status, paused.stderr).toBe(10);
    const checks = f.calls().filter((line) => line.startsWith("orchestration check"));
    expect(checks).toEqual([
      "orchestration check --terminal term_current --json",
      "orchestration check --terminal term_current --ack delivery-1 --json",
    ]);
    expect(checks.join("\n")).not.toContain("term_observer");
  });

  it("degrades without checking or acknowledging a known-foreign fallback", () => {
    const f = fixture("foreign-fallback");
    f.adapter({ terminal: "term_foreign" });
    writeFileSync(
      join(f.root, ORCA_BINDING_RELATIVE_PATH),
      JSON.stringify({
        version: 1,
        invalidatedConsumer: "term_foreign",
        invalidatedAt: "2026-09-13T00:00:00.000Z",
        why: "consumer was reassigned to a different Orca Run",
      }),
    );
    f.queue([mail({ command: "pause", why: "must remain unread" })]);

    const polled = f.run(["poll"], { ORCA_TERMINAL_HANDLE: "term_foreign" });
    expect(polled.status, polled.stderr).toBe(0);
    expect(f.mailbox()?.degraded?.why).toContain("no safe Orca consumer is available");
    expect(f.calls().filter((line) => line.startsWith("orchestration check"))).toEqual([]);
  });

  it("holds the loop, keeps holding it, and lets it go again", () => {
    const f = fixture("pause");

    f.queue([mail({ command: "pause", why: "the frontier needs a human" })]);
    const paused = f.run(["poll"]);
    expect(paused.status).toBe(10);
    expect(verdict(paused)[0]).toBe("hold");
    expect(f.state()?.hold).toMatchObject({ kind: "pause", why: "the frontier needs a human" });

    // An empty mailbox does not release a hold: the record is what holds it.
    f.queue([]);
    const still = f.run(["poll"]);
    expect(still.status).toBe(10);

    f.queue([mail({ command: "resume", why: "widened it" })]);
    const resumed = f.run(["poll"]);
    expect(resumed.status).toBe(0);
    expect(verdict(resumed)[0]).toBe("continue");
    expect(f.state()?.hold).toBeNull();
  });

  it("survives the supervisor that was told to pause being replaced", () => {
    // A pause is an instruction about the WORK. A restart the operator did not
    // ask for, and may not know about, must not be a way to defeat it.
    const f = fixture("pause-restart");
    f.queue([mail({ command: "pause", why: "hold it" })]);
    expect(f.run(["poll"]).status).toBe(10);

    f.queue([]);
    const nextRun = f.run(["poll"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(nextRun.status).toBe(10);
    expect(f.state()?.ralphRun).toBe("ralph-run-2");
    expect(f.state()?.ownerChangedAt).not.toBeNull();
  });
});

describe("stopping a loop", () => {
  it("confirms a stop the supervisor itself read", () => {
    const f = fixture("stop-confirmed");
    f.queue([mail({ command: "stop", why: "that is enough for tonight", stop: "completed" })]);
    // `--supervised` is the supervisor saying it is about to act on the
    // answer. Nothing infers it: see `applierFor`.
    const stopped = f.run(["poll", "--supervised"]);
    expect(stopped.status).toBe(20);
    expect(verdict(stopped).slice(0, 2)).toEqual(["stop", "completed"]);
    expect(f.state()?.stop).toMatchObject({ kind: "completed", confirmation: "confirmed" });
  });

  it("confirms a stop even when invoked the way the supervisor actually invokes it", () => {
    // The regression this exists for: `ralph.sh` runs the poll as
    // `out="$(bun … poll --supervised 2>/dev/null)"`, and the redirection
    // inside a command substitution defeats bash's exec optimisation — so any
    // check that inferred the caller from `process.ppid` saw the subshell, not
    // the supervisor. It recorded every self-read stop as `pending` and fired
    // `worker-abandon` at the loop's own live dispatch. Driven through bash
    // here rather than spawned directly, because the shell IS the bug.
    const f = fixture("stop-through-bash");
    f.adapter({ attempt: { index: 2, session: "session-b", dispatch: "ctx_2", ended: false } });
    f.queue([mail({ command: "stop", why: "that is enough" })]);

    // Assignment, then `$?`, then the exit — the same three steps
    // `control_checkpoint` takes, so the status under test is the poll's.
    const script = [
      `out="$(${BUN} ${join(REPO_ROOT, "controls.ts")} poll --supervised 2>/dev/null)"`,
      "status=$?",
      `printf '%s' "$out"`,
      "exit $status",
    ].join("; ");
    const ran = f.shell(script);

    expect(ran.status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "confirmed" });
    // The live attempt is left to the mirror, which settles it with an outcome
    // at the boundary it is already recording.
    expect(f.calls().some((line) => line.includes("worker-abandon"))).toBe(false);
  });

  it("says a stop is unreachable when the owner is gone, and fences its attempt", () => {
    const f = fixture("stop-unreachable");
    // A pid that cannot be a supervisor: the record names it, `/proc` does not.
    f.loopState({ owner: { loop: "ralph", pid: 2 ** 22, host: "test" } });
    f.adapter({ attempt: { index: 2, session: "session-b", dispatch: "ctx_2", ended: false } });
    f.queue([mail({ command: "stop", why: "the box it ran on is gone" })]);

    const stopped = f.run(["poll"]);
    expect(stopped.status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "unreachable" });
    // Fenced with the verb that claims nothing about a process, never with the
    // one that claims it stopped.
    expect(f.calls().some((line) => line.includes("worker-abandon --dispatch ctx_2"))).toBe(true);
    expect(f.calls().some((line) => line.includes("worker-stop"))).toBe(false);
  });
});

describe("a command that arrives twice", () => {
  it("applies it once, however often the Delivery replays", () => {
    const f = fixture("replay");
    const stop = mail({ command: "stop", id: "stop-once", why: "first" });
    // The ack is what drains the fake mailbox, so withholding it is exactly
    // the partition this fence exists for: the same batch, delivered again.
    f.queue([stop], null);

    expect(f.run(["poll"]).status).toBe(20);
    const first = f.state();
    expect(first?.applied.filter((entry) => entry.key === "stop-once")).toHaveLength(1);

    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.applied.filter((entry) => entry.key === "stop-once")).toHaveLength(1);
    expect(f.state()?.stop?.at).toBe(first?.stop?.at);
  });

  it("does not stop the next supervisor with a stop that was already carried out", () => {
    // An operator who ran `ralph/start.sh` again meant it. A confirmed stop is
    // finished; carrying it out twice would exit at the first checkpoint on
    // last night's command, with no obvious way back.
    const f = fixture("stop-not-twice");
    f.queue([mail({ command: "stop", why: "that is enough for tonight" })]);
    expect(f.run(["poll", "--supervised"]).status).toBe(20);

    f.queue([]);
    const restarted = f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(restarted.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
  });

  it("makes the next supervisor carry out a stop nobody confirmed", () => {
    // The other half of the asymmetry: a stop recorded against an owner nobody
    // could find has not happened yet, and this is the first process able to
    // do it.
    const f = fixture("stop-unconfirmed-carries");
    f.loopState({ owner: { loop: "ralph", pid: 2 ** 22, host: "test" } });
    f.queue([mail({ command: "stop", why: "the box it ran on is gone" })]);
    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ confirmation: "unreachable" });

    f.queue([]);
    const restarted = f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(restarted.status).toBe(20);
    // And carrying it out is what confirms it. Without this the stop stayed
    // `unreachable` for ever and every later start.sh exited at its first
    // checkpoint on a command that had by then been obeyed several times.
    expect(f.state()?.stop).toMatchObject({ confirmation: "confirmed" });

    f.queue([]);
    expect(f.run(["poll", "--supervised"], { RALPH_RUN_ID: "ralph-run-3" }).status).toBe(0);
  });

  it("refuses a command naming a run that has been replaced, and says so on the message", () => {
    const f = fixture("reconfirm");
    f.queue([mail({ command: "stop", run: "ralph-run-0", why: "stop the run I was watching" })]);

    const polled = f.run(["poll"]);
    expect(polled.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "needs-reconfirmation" });
    expect(f.calls().some((line) => line.startsWith("orchestration reply"))).toBe(true);
  });

  it("obeys the same command once the operator reconfirms it", () => {
    const f = fixture("reconfirmed");
    f.queue([
      mail({ command: "stop", id: "stop-2", run: "ralph-run-0", reconfirm: true, why: "yes, this one" }),
    ]);
    expect(f.run(["poll"]).status).toBe(20);
    expect(f.state()?.stop?.why).toBe("yes, this one");
  });
});

describe("approving gated work", () => {
  it("holds on a pending gate and continues when it is approved", () => {
    const f = fixture("gate-approve");
    f.adapter({});
    f.gates([{ id: "gate_1", task_id: "task_fake", status: "pending", question: "ship it?" }]);

    const held = f.run(["poll"]);
    expect(held.status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ kind: "approval", gate: "gate_1" });

    f.gates([{ id: "gate_1", task_id: "task_fake", status: "resolved", resolution: "yes, go ahead" }]);
    const released = f.run(["poll"]);
    expect(released.status).toBe(0);
    expect(f.state()?.hold).toBeNull();
  });

  it("turns a denied gate into a blocked stop without a second command", () => {
    const f = fixture("gate-deny");
    f.adapter({});
    f.gates([{ id: "gate_2", task_id: "task_fake", status: "pending", question: "ship it?" }]);
    expect(f.run(["poll"]).status).toBe(10);

    f.gates([{ id: "gate_2", task_id: "task_fake", status: "resolved", resolution: "deny — not this one" }]);
    const denied = f.run(["poll"]);
    expect(denied.status).toBe(20);
    expect(f.state()?.stop).toMatchObject({ kind: "blocked" });
  });

  it("answers an approval hold by message too, and refuses to answer a pause", () => {
    const f = fixture("gate-message");
    f.adapter({});
    f.gates([{ id: "gate_3", task_id: "task_fake", status: "pending", question: "ship it?" }]);
    expect(f.run(["poll"]).status).toBe(10);

    // The gate is still pending in Orca; the operator answered on the message
    // channel instead. The hold is theirs to release either way.
    f.queue([mail({ command: "approve", why: "approved in the pane" })]);
    f.gates([]);
    expect(f.run(["poll"]).status).toBe(0);

    // `approve` is not a synonym for `resume`: answering a question nobody
    // asked must say so rather than release an unrelated pause.
    f.queue([mail({ command: "pause", id: "p1", why: "hold" })]);
    expect(f.run(["poll"]).status).toBe(10);
    f.queue([mail({ command: "approve", id: "a2" })]);
    expect(f.run(["poll"]).status).toBe(10);
    expect(f.state()?.applied.find((entry) => entry.key === "a2")).toMatchObject({
      outcome: "refused",
    });
  });
});

describe("retrying a failed attempt", () => {
  it("opens a linked attempt and keeps the predecessor's evidence", () => {
    const f = fixture("retry");
    f.loopState({
      stage: "stopped",
      stopReason: { kind: "failed", why: "iteration 2 ended without a sigil", at: "T" },
      session: "session-b",
    });
    f.adapter({ attempt: { index: 2, session: "session-b", dispatch: "ctx_2", ended: true } });
    f.queue([mail({ command: "retry", why: "the runner died, the ticket is fine" })]);

    const retried = f.run(["poll"]);
    expect(retried.status).toBe(0);
    const link = f.state()?.retries[0];
    expect(link?.attempt).toBe("ralph-run-1/attempt-3");
    expect(link?.predecessor).toBe("ralph-run-1/attempt-2");
    expect(link?.evidence).toMatchObject({
      iteration: 2,
      session: "session-b",
      log: ".ralph/logs/iter-x.log",
      outcome: "failed",
      why: "iteration 2 ended without a sigil",
    });
    // And both identities are legible on the board, not only in this
    // worktree's record: a link nobody can see from Orca is not a link an
    // operator working from Orca can follow.
    const said = f.calls().find((line) => line.includes("control: retry"));
    expect(said).toContain("--run run_fake");
    expect(said).toContain('"attempt":"ralph-run-1/attempt-3"');
    expect(said).toContain('"retryOf":"ralph-run-1/attempt-2"');
    // The Orca side of the evidence travels with the answer, not the record.
    expect(said).toContain('"dispatch":"ctx_2"');
  });

  it("clears the stop it is retrying past, and leaves a pause alone", () => {
    const f = fixture("retry-hold");
    f.queue([
      mail({ command: "pause", id: "p", why: "hold" }, { sequence: 1 }),
      mail({ command: "stop", id: "s", stop: "failed", why: "stop" }, { sequence: 2 }),
    ]);
    expect(f.run(["poll"]).status).toBe(20);

    f.queue([mail({ command: "retry", id: "r", why: "try again" })]);
    // Still held — "try again" has never meant "and unpause".
    const retried = f.run(["poll"]);
    expect(retried.status).toBe(10);
    expect(f.state()?.stop).toBeNull();
    expect(f.state()?.hold).toMatchObject({ kind: "pause" });
  });
});

describe("abandoning and releasing a claim", () => {
  it("refuses to take an unexpired lease, whatever the operator asks", () => {
    const f = fixture("abandon-live");
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    f.claim(703, { run: "ralph-run-0", expiresAt });
    f.queue([mail({ command: "abandon", issue: 703, why: "I think it is dead" })]);

    const refused = f.run(["poll"]);
    expect(refused.status).toBe(0);
    // The lease is untouched: this is the one command that would hand one
    // ticket to two loops.
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.state()?.abandoned).toHaveLength(0);
    expect(f.state()?.applied[0]).toMatchObject({ outcome: "refused" });
    expect(f.state()?.applied[0]?.why).toContain(expiresAt);
  });

  it("takes an expired lease back and keeps what it was", () => {
    const f = fixture("abandon-expired");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.queue([mail({ command: "abandon", issue: 703, why: "the host is gone" })]);

    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.state()?.abandoned[0]).toMatchObject({
      issue: 703,
      run: "ralph-run-0",
      expiredAt: "2020-01-01T00:00:00.000Z",
    });
  });

  it("lets a run release its own live claim and the attempt's terminal", () => {
    const f = fixture("release");
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.adapter({ attempt: { index: 2, session: "session-b", dispatch: "ctx_2", ended: true } });
    f.queue([mail({ command: "release", issue: 703, why: "handing this worktree back" })]);

    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.state()?.released).toEqual([703]);
    expect(f.calls().some((line) => line.includes("worker-release --dispatch ctx_2"))).toBe(true);
  });

  it("asks again for a command it could not apply because the store was locked", () => {
    // The fence that makes a replay safe is the applied set, and an entry
    // there of ANY outcome silences the next delivery. So a deferral must not
    // land in it: recording one dropped the command permanently, which is the
    // opposite of the retry a deferral is asking for.
    const f = fixture("abandon-busy");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.queue([mail({ command: "abandon", issue: 703, id: "take-703" })]);

    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual(["703"]);
    expect(f.state()?.applied.some((entry) => entry.key === "take-703")).toBe(false);
    // Acknowledged at once: the command is on disk in the inbox, which is
    // where the retry now comes from — the file stays until it settles.
    expect(f.calls().some((line) => line.includes("--ack"))).toBe(true);
    expect(f.pending()).toEqual(["take-703.json"]);

    f.lock(false);
    expect(f.run(["poll"]).status).toBe(0);
    expect(Object.keys(f.leases())).toEqual([]);
    expect(f.state()?.abandoned[0]).toMatchObject({ issue: 703 });
  });

  it("gives up on a lock that is never coming back, and says so on the Run", () => {
    // `claim-lease.ts` never breaks a lock, so a writer killed with SIGKILL
    // leaves one behind. Waiting on it for ever would leave a command pending
    // on the board for ever; and the mailbox is acknowledged as soon as the
    // command is in the inbox, so nothing issued after it is held up.
    const f = fixture("abandon-stuck");
    f.adapter({});
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.queue([mail({ command: "abandon", issue: 703, id: "stuck-703" })]);

    for (let poll = 1; poll < DEFERRAL_LIMIT; poll += 1) {
      f.run(["poll"]);
      // Still waiting, its file still in the inbox so it comes back.
      expect(f.state()?.deferrals[0]).toMatchObject({ command: "abandon", attempts: poll });
      expect(f.pending()).toEqual(["stuck-703.json"]);
    }
    expect(f.run(["poll"]).stdout).toContain("given up");

    // Given up: said on the board with the remedy, remembered as refused so it
    // is not re-evaluated, and its file settled.
    expect(f.state()?.deferrals).toEqual([]);
    expect(f.state()?.applied.find((entry) => entry.key === "stuck-703")).toMatchObject({
      outcome: "refused",
    });
    expect(f.calls().filter((line) => line.includes("given up"))).toHaveLength(1);
    expect(f.pending()).toEqual([]);
    expect(Object.keys(f.leases())).toEqual(["703"]);
  });

  it("stops reporting a deferred command as waiting once anything settles it", () => {
    // The realistic path that is not the applied one: a command deferred by a
    // held lock, then refused on the next poll because the run changed
    // underneath it. An entry left behind would have reported it as still
    // waiting on the board for the life of the record.
    const f = fixture("deferral-settled");
    f.claim(703, { run: "ralph-run-0", expiresAt: "2020-01-01T00:00:00.000Z" });
    f.lock(true);
    f.queue([mail({ command: "abandon", issue: 703, id: "moved-703", run: "ralph-run-1" })], null);
    f.run(["poll"]);
    expect(f.state()?.deferrals).toHaveLength(1);

    // A new supervisor takes the worktree; the replayed command names a run
    // that has been replaced, so it is refused rather than applied.
    f.run(["poll"], { RALPH_RUN_ID: "ralph-run-2" });
    expect(f.state()?.applied.find((entry) => entry.key === "moved-703")).toMatchObject({
      outcome: "needs-reconfirmation",
    });
    expect(f.state()?.deferrals).toEqual([]);
    expect(f.run(["status"]).stdout).not.toContain("waiting since");
  });

  it("is idempotent when the claim is already gone", () => {
    const f = fixture("release-twice");
    f.queue([mail({ command: "release", issue: 703, id: "rel-1" })]);
    expect(f.run(["poll"]).status).toBe(0);
    f.queue([mail({ command: "release", issue: 703, id: "rel-2" })]);
    expect(f.run(["poll"]).status).toBe(0);
    expect(f.state()?.released).toEqual([703]);
  });
});

describe("when Orca is not there", () => {
  it("continues, and records why it could not ask", () => {
    const f = fixture("no-terminal");
    const polled = f.run(["poll"], { ORCA_TERMINAL_HANDLE: "" });
    expect(polled.status).toBe(0);
    expect(f.mailbox()?.degraded?.why).toContain("no safe Orca consumer is available");
    // Not one subprocess was made: a held loop polls this branch every few
    // seconds and must not pay a timeout for each of them.
    expect(f.calls()).toEqual([]);
  });

  it("keeps holding a loop it was told to hold while the runtime is down", () => {
    const f = fixture("degraded-hold");
    f.queue([mail({ command: "pause", why: "hold it" })]);
    expect(f.run(["poll"]).status).toBe(10);

    const dark = f.run(["poll"], { RALPH_ORCA_CLI: join(f.root, "no-such-orca") });
    expect(dark.status).toBe(10);
    expect(f.state()?.hold).toMatchObject({ kind: "pause" });
    expect(f.mailbox()?.degraded?.why).toContain("no Orca CLI");
  });

  it("reads no Orca mail when the Orca route is switched off", () => {
    const f = fixture("off");
    f.queue([mail({ command: "stop", why: "should not be read" })]);
    const polled = f.run(["poll"], { RALPH_ORCA_CONTROLS: "0" });
    expect(polled.status).toBe(0);
    expect(f.state()?.stop).toBeNull();
    expect(f.calls()).toEqual([]);
  });
});

describe("the plugin's health", () => {
  it("is recorded against the plugin, never the loop, when Orca is not there", () => {
    const f = fixture("health");
    f.queue([mail({ command: "pause", why: "hold it" })]);
    expect(f.run(["poll"]).status).toBe(10);
    const dark = f.run(["poll"], { RALPH_ORCA_CLI: join(f.root, "no-such-orca") });
    expect(dark.status).toBe(10);
    const health = JSON.parse(readFileSync(join(f.root, ".ralph", "logs", "plugins.json"), "utf8"));
    expect(health.plugins.orca.degraded).toMatchObject({ hook: "inbox" });
    expect(health.plugins.orca.degraded.why).toContain("no Orca CLI");
    // Nothing of it in the loop's own records or output.
    expect(dark.stdout).not.toContain("Orca");
    expect(JSON.stringify(f.state())).not.toContain("no Orca CLI");
  });
});

describe("the local command inbox beside the Orca route", () => {
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
  /** No Orca CLI at all: the failure the inbox exists to survive. */
  const noOrca = (f: Fixture): Record<string, string> => ({ RALPH_ORCA_CLI: join(f.root, "no-such-orca") });

  it("reads the inbox even inside a degraded window, when no Orca subprocess is made", () => {
    const f = fixture("inbox-degraded");
    expect(f.run(["poll"], { ORCA_TERMINAL_HANDLE: "" }).status).toBe(0);
    expect(f.mailbox()?.degraded).not.toBeNull();

    drop(f, "p-1", { command: "pause" });
    expect(f.run(["poll"], { ORCA_TERMINAL_HANDLE: "" }).status).toBe(10);
    expect(f.calls()).toEqual([]);
  });

  it("applies approve and deny through the same fence, refusing a question nobody asked", () => {
    const f = fixture("inbox-approve");
    f.adapter({});
    // Orca reachable for the first two polls, so the gate below is read; the
    // deny is then applied with no Orca at all.
    drop(f, "a-1", { command: "approve" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(outcomeOf(f, "a-1")).toMatchObject({ outcome: "refused", why: "nothing is waiting for approval" });

    f.gates([{ id: "g1", status: "pending", question: "ship it?" }]);
    f.run(["poll"]);
    expect(f.state()?.hold).toMatchObject({ kind: "approval", gate: "g1" });
    drop(f, "d-1", { command: "deny", why: "not this one" });
    expect(f.run(["poll", "--supervised"], noOrca(f)).status).toBe(20);
    expect(outcomeOf(f, "d-1")).toMatchObject({ outcome: "applied" });
  });

  it("shares one applied-key set with the Orca mailbox", () => {
    const f = fixture("inbox-shared-fence");
    f.queue([mail({ command: "pause", id: "same-command" })]);
    expect(f.run(["poll"]).status).toBe(10);
    drop(f, "r-1", { command: "resume" });
    expect(f.run(["poll"]).status).toBe(0);

    // The pause the mailbox already applied, arriving through the inbox too.
    drop(f, "same-command", { command: "pause" });
    expect(f.run(["poll"]).status).toBe(0);
    expect(outcomeOf(f, "same-command")).toMatchObject({ outcome: "applied" });

    // And the other way round: a command the inbox applied, replayed by Orca.
    drop(f, "p-2", { command: "pause" });
    expect(f.run(["poll"]).status).toBe(10);
    drop(f, "r-2", { command: "resume" });
    expect(f.run(["poll"]).status).toBe(0);
    f.queue([mail({ command: "pause", id: "p-2" })]);
    expect(f.run(["poll"]).status).toBe(0);
  });

  it("applies the dashboard's recovery poll with every plugin off, and calls no orca at all", () => {
    // The page runs `--only retry,abandon,release` with `RALPH_PLUGINS=` for a
    // loop whose supervisor is gone. The attempt's dispatch is on record, so a
    // poll with the plugin on WOULD call worker-release.
    const f = fixture("inbox-recovery");
    f.adapter({ attempt: { index: 2, session: "session-b", dispatch: "ctx_2", ended: true } });
    f.loopState({ stage: "stopped", stopReason: { kind: "failed", why: "no sigil", at: "T" } });
    f.claim(703, { run: "ralph-run-1", expiresAt: new Date(Date.now() + 600_000).toISOString() });
    drop(f, "retry-1", { command: "retry" });
    drop(f, "release-703", { command: "release", issue: 703 });
    const polled = f.run(["poll", "--only", "retry,abandon,release"], { RALPH_PLUGINS: "" });
    expect(polled.status, polled.stderr).toBe(0);
    expect(outcomeOf(f, "retry-1")).toMatchObject({ outcome: "applied" });
    expect(outcomeOf(f, "release-703")).toMatchObject({ outcome: "applied" });
    expect(f.calls()).toEqual([]);
  });

  it("still applies the inbox when the Orca route is switched off", () => {
    const f = fixture("inbox-orca-off");
    drop(f, "p-1", { command: "pause" });
    expect(f.run(["poll"], { RALPH_ORCA_CONTROLS: "0" }).status).toBe(10);
    expect(f.calls()).toEqual([]);
  });

});
