// @vitest-environment node
/**
 * Dispatch in front of the real control channel.
 *
 * The unit suite fakes the executor; this one does not. Dispatch writes into
 * the loop's local inbox and the real `controls.ts` is spawned to read
 * it, exactly as the supervisor does at an iteration boundary. So the
 * apply-at-most-once fence, the stop confirmation, and approve/deny releasing
 * only a pending approval hold are asserted through the implementation that
 * owns them, not through a re-telling of it. No plugin is enabled, so the fake
 * `orca` on PATH is never called; the last suite removes it altogether.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { writeInboxCommand } from "../control-inbox";
import { createProcessExecutor } from "./control-adapter";
import { createRalphControlAdapter } from "./control-adapter";
import { dispatch, type DispatchDeps } from "./dispatch";
import { bunPath, writeProjectConfig } from "./fixtures";
import { claimLease, type LeaseStore } from "../claim-lease";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("applies dispatch through bun CLIs and flock");

const REPO_ROOT = dirname(__dirname);
const BUN = process.env.RALPH_TEST_BUN ?? bunPath();
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Channel {
  root: string;
  deps: DispatchDeps;
  /** Run the real control channel the way the supervisor does. */
  poll: (args?: string[], env?: Record<string, string>) => SpawnSyncReturns<string>;
  /** Every command file dispatch has written, pending or already settled. */
  sends: () => string[];
  /** The outcome the poller recorded beside a settled command file. */
  outcome: (id: string) => Record<string, unknown> | null;
  record: () => Record<string, unknown> | null;
  /** Ask for approval, as a plugin's `inbox` hook would on a gate. */
  requestApproval: (gate: string, question: string) => void;
  /** Put a claim lease in the store the loop's git common directory holds. */
  claim: (issue: number, run: string, expiresAt: string) => void;
  leases: () => string[];
  /** Rewrite the durable loop state's ending. */
  endWith: (stopReason: Record<string, unknown> | null) => void;
}

function channel(label: string, over: { pid?: number | null; orca?: boolean } = {}): Channel {
  const root = mkdtempSync(join(tmpdir(), `ralph-dispatch-channel-${label}-`));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeProjectConfig(root);
  mkdirSync(join(root, "gitcommon"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callLog = join(root, "orca.calls");
  const mailbox = join(root, "mailbox.json");
  const gates = join(root, "gates.json");
  writeFileSync(mailbox, '{"ok":true,"result":{"messages":[]}}');
  writeFileSync(gates, '{"ok":true,"result":{"gates":[]}}');

  // Fake Orca: an empty mailbox and the gate list the tests set. Commands do
  // not travel through it; the inbox carries them.
  const orca = join(bin, "orca");
  writeFileSync(
    orca,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(callLog)}`,
      'case "$1 $2" in',
      '  "orchestration check")',
      '    case "$*" in',
      `      *--ack*) printf '{"ok":true,"result":{"messages":[]}}\\n' > ${JSON.stringify(mailbox)}; printf '{"ok":true,"result":{"messages":[]}}\\n' ;;`,
      `      *) cat ${JSON.stringify(mailbox)} ;;`,
      "    esac",
      "    ;;",
      `  "orchestration gate-list") cat ${JSON.stringify(gates)} ;;`,
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
      'if [ "$1" = "symbolic-ref" ]; then printf \'%s\\n\' "ralph/12"; exit 0; fi',
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

  const state: Record<string, unknown> = {
    version: 1,
    run: "run-1",
    owner: { loop: "ralph", pid: over.pid ?? null, host: "test" },
    worktree: root,
    branch: "ralph/12",
    stage: "iteration",
    iteration: { index: 2, max: 15 },
    heartbeat: "2026-09-14T00:00:00.000Z",
    lastEvent: null,
    stopReason: null,
  };
  writeFileSync(join(root, ".ralph", "logs", "state.json"), JSON.stringify(state));

  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: root,
    // No Orca at all, when asked: a path that does not exist.
    RALPH_ORCA_CLI: over.orca === false ? join(root, "no-such-orca") : orca,
    RALPH_LOOP_NAME: "ralph",
    RALPH_RUN_ID: "run-1",
    ORCA_TERMINAL_HANDLE: "term_loop",
  };

  const adapter = createRalphControlAdapter({
    cliDir: REPO_ROOT,
    root,
    bunPath: BUN,
    env,
    exec: createProcessExecutor(),
  });

  const recordPath = join(root, ".ralph", "logs", "controls.json");
  return {
    root,
    deps: { adapter, loop: "ralph" },
    poll: (args = [], extra = {}) =>
      spawnSync(BUN, [join(REPO_ROOT, "controls.ts"), "poll", ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, ...env, ...extra },
      }),
    sends: () =>
      ["inbox", "processed"].flatMap((dir) => {
        const path = join(root, ".ralph", "control", dir);
        return existsSync(path)
          ? readdirSync(path).filter((name) => name.endsWith(".json") && !name.endsWith(".outcome.json") && !name.startsWith("."))
          : [];
      }),
    outcome: (id) => {
      const path = join(root, ".ralph", "control", "processed", `${id}.outcome.json`);
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
    },
    record: () =>
      existsSync(recordPath)
        ? (JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>)
        : null,
    requestApproval: (gate, question) => {
      writeInboxCommand(root, { id: `ask-${gate}`, command: "request-approval", gate, why: question });
    },
    claim: (issue, run, expiresAt) => {
      const path = join(root, "gitcommon", "ralph-claim-leases.json");
      const store: LeaseStore = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as LeaseStore)
        : { version: 1, leases: {} };
      claimLease(store, {
        issue,
        run,
        loop: "ralph",
        pid: 1,
        host: "test",
        worktree: root,
        branch: `ralph/${issue}`,
        nowMs: Date.now(),
      });
      store.leases[String(issue)] = { ...store.leases[String(issue)]!, expiresAt };
      writeFileSync(path, JSON.stringify(store));
    },
    leases: () => {
      const path = join(root, "gitcommon", "ralph-claim-leases.json");
      return existsSync(path) ? Object.keys((JSON.parse(readFileSync(path, "utf8")) as LeaseStore).leases) : [];
    },
    endWith: (stopReason) =>
      writeFileSync(
        join(root, ".ralph", "logs", "state.json"),
        JSON.stringify({ ...state, stage: stopReason === null ? "iteration" : "stopped", stopReason }),
      ),
  };
}

const applied = (record: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
  const list = Array.isArray(record?.applied) ? (record!.applied as Record<string, unknown>[]) : [];
  return list.find((entry) => entry.key === key) ?? null;
};

describe("a command under replay", () => {
  it("applies a pause exactly once, however often dispatch is asked", async () => {
    const c = channel("replay");
    const first = await dispatch(c.deps, { loop: "ralph", action: "pause", why: "triage", id: "p-1" });
    expect(first.outcome).toBe("applied");
    expect(c.sends()).toHaveLength(1);

    // The channel's own poll applies it at the next iteration boundary.
    const polled = c.poll();
    expect(polled.status, polled.stderr).toBe(10);
    expect(c.record()?.hold).toMatchObject({ kind: "pause", why: "triage" });

    // The same command id now replays from the fence and sends nothing again.
    const second = await dispatch(c.deps, { loop: "ralph", action: "pause", id: "p-1" });
    expect(second.outcome).toBe("replayed");
    expect(second.recorded).toBe(true);
    expect(c.sends()).toHaveLength(1);
  });
});

describe("a stop's confirmation", () => {
  it("is never confirmed when the owner cannot be found", async () => {
    const c = channel("stop-unreachable", { pid: null });
    const sent = await dispatch(c.deps, { loop: "ralph", action: "stop", id: "s-1" });
    expect(sent.stop?.confirmation).toBe("pending");

    const polled = c.poll();
    expect(polled.status, polled.stderr).toBe(20);
    const stop = c.record()?.stop as Record<string, unknown>;
    expect(stop.kind).toBe("blocked");
    expect(stop.confirmation).not.toBe("confirmed");

    const replayed = await dispatch(c.deps, { loop: "ralph", action: "stop", id: "s-1" });
    expect(replayed.stop?.confirmation).not.toBe("confirmed");
  });
});

describe("approve and deny", () => {
  it("refuses a question nobody asked, and releases only a pending approval", async () => {
    const c = channel("approvals");

    // No hold at all: the channel records a refusal, and dispatch surfaces it.
    await dispatch(c.deps, { loop: "ralph", action: "approve", id: "a-none" });
    c.poll();
    expect(applied(c.record(), "a-none")).toMatchObject({ outcome: "refused" });
    const refused = await dispatch(c.deps, { loop: "ralph", action: "approve", id: "a-none" });
    expect(refused.outcome).toBe("refused");
    expect(refused.recorded).toBe(true);

    // A request for approval takes the hold; approving releases only it.
    c.requestApproval("g1", "ship it?");
    c.poll();
    expect(c.record()?.hold).toMatchObject({ kind: "approval", gate: "g1" });

    await dispatch(c.deps, { loop: "ralph", action: "approve", id: "a-1" });
    c.poll();
    expect(c.record()?.hold).toBeNull();
    expect(applied(c.record(), "a-1")).toMatchObject({ outcome: "applied" });
  });

  it("records a denial as a blocked stop rather than waiting forever", async () => {
    const c = channel("deny");
    c.requestApproval("g2", "ship it?");
    c.poll();
    expect(c.record()?.hold).toMatchObject({ kind: "approval", gate: "g2" });

    await dispatch(c.deps, { loop: "ralph", action: "deny", id: "d-1" });
    c.poll();
    expect(c.record()?.hold).toBeNull();
    expect(c.record()?.stop).toMatchObject({ kind: "blocked" });
    expect(applied(c.record(), "d-1")).toMatchObject({ outcome: "applied" });
  });
});

describe("with no Orca at all", () => {
  it("applies pause, resume, stop, approve and deny from dispatch at the next boundary, and shows each outcome", async () => {
    const c = channel("no-orca", { orca: false });

    const paused = await dispatch(c.deps, { loop: "ralph", action: "pause", why: "triage", id: "p-1" });
    expect(paused).toMatchObject({ outcome: "applied", recorded: false });
    expect(c.poll(["--supervised"]).status).toBe(10);
    expect(c.outcome("p-1")).toMatchObject({ outcome: "applied" });
    // The page asks again and reads the recorded outcome back.
    expect(await dispatch(c.deps, { loop: "ralph", action: "pause", id: "p-1" })).toMatchObject({
      outcome: "replayed",
      recorded: true,
    });

    await dispatch(c.deps, { loop: "ralph", action: "resume", id: "r-1" });
    expect(c.poll(["--supervised"]).status).toBe(0);
    expect(applied(c.record(), "r-1")).toMatchObject({ outcome: "applied" });

    // Nothing is waiting for approval, so both are refused — recorded, and shown.
    await dispatch(c.deps, { loop: "ralph", action: "approve", id: "a-1" });
    await dispatch(c.deps, { loop: "ralph", action: "deny", id: "d-1" });
    expect(c.poll(["--supervised"]).status).toBe(0);
    expect(await dispatch(c.deps, { loop: "ralph", action: "approve", id: "a-1" })).toMatchObject({
      outcome: "refused",
      recorded: true,
      why: "nothing is waiting for approval",
    });
    expect(c.outcome("d-1")).toMatchObject({ outcome: "refused" });

    const stop = await dispatch(c.deps, { loop: "ralph", action: "stop", why: "review cannot log in", id: "s-1" });
    expect(stop.stop?.confirmation).toBe("pending");
    const polled = c.poll(["--supervised"]);
    expect(polled.status, polled.stderr).toBe(20);
    const after = await dispatch(c.deps, { loop: "ralph", action: "stop", id: "s-1" });
    expect(after).toMatchObject({ outcome: "replayed", recorded: true });
    expect(after.stop).toEqual({ kind: "blocked", confirmation: "confirmed" });
  });

  it("refuses a command naming a replaced run at the loop, never applying it to the current one", async () => {
    const c = channel("no-orca-reconfirm", { orca: false });
    // Dispatch's own check passes (it still sees run-1); the loop has since
    // been replaced by run-2 and is the one that refuses.
    await dispatch(c.deps, { loop: "ralph", action: "stop", run: "run-1", id: "s-old" });
    const polled = c.poll(["--supervised"], { RALPH_RUN_ID: "run-2" });
    expect(polled.status).toBe(0);
    expect(c.record()?.stop).toBeNull();
    expect(c.outcome("s-old")).toMatchObject({ outcome: "needs-reconfirmation" });
  });
});

describe("recovering a loop whose supervisor is gone, with no Orca at all", () => {
  // The dashboard read the supervisor as dead, so dispatch applies each command
  // itself — as the run on record, with the Orca route off — and answers with
  // what the loop recorded rather than "queued".
  const recovery = (label: string): Channel & { send: typeof dispatch } => {
    const c = channel(label, { orca: false });
    return { ...c, send: (deps, request) => dispatch({ ...deps, supervisor: "dead" }, request) };
  };
  const future = (): string => new Date(Date.now() + 10 * 60_000).toISOString();
  const past = "2020-01-01T00:00:00.000Z";

  it("refuses to abandon an unexpired claim, naming the expiry, and leaves the claim alone", async () => {
    const c = recovery("abandon-live");
    const expiresAt = future();
    c.claim(703, "run-0", expiresAt);
    const result = await c.send(c.deps, { loop: "ralph", action: "abandon", issue: 703, id: "ab-1" });
    expect(result).toMatchObject({ outcome: "refused", recorded: true });
    expect(result.why).toContain(expiresAt);
    expect(c.leases()).toEqual(["703"]);
  });

  it("abandons an expired claim and records it", async () => {
    const c = recovery("abandon-expired");
    c.claim(703, "run-0", past);
    const result = await c.send(c.deps, { loop: "ralph", action: "abandon", issue: 703, id: "ab-2" });
    expect(result).toMatchObject({ outcome: "applied", recorded: true });
    expect(result.why).toContain("abandoned #703");
    expect(c.leases()).toEqual([]);
    expect(c.outcome("ab-2")).toMatchObject({ outcome: "applied" });
  });

  it("releases the run's own claim, and refuses one another run holds", async () => {
    const c = recovery("release");
    c.claim(703, "run-1", future());
    c.claim(704, "run-0", past);
    const own = await c.send(c.deps, { loop: "ralph", action: "release", run: "run-1", issue: 703, id: "rel-1" });
    expect(own).toMatchObject({ outcome: "applied", recorded: true, why: "released #703" });
    const other = await c.send(c.deps, { loop: "ralph", action: "release", run: "run-1", issue: 704, id: "rel-2" });
    expect(other).toMatchObject({ outcome: "refused", recorded: true });
    expect(other.why).toContain("run-0");
    expect(c.leases()).toEqual(["704"]);
  });

  it("applies nothing while a supervisor holds the worktree's lock, and says so", async () => {
    // `start.sh` takes this lock and its wrapper keeps it for the
    // supervisor's life: the page's liveness read can be a moment stale, the
    // lock cannot.
    const c = recovery("lock-held");
    c.endWith({ kind: "failed", why: "review cannot log in", at: "2026-09-22T10:00:00Z" });
    const lock = join(c.root, ".ralph", "logs", "supervisor.lock");
    const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const result = await c.send(c.deps, { loop: "ralph", action: "retry", run: "run-1", id: "re-locked" });
      expect(result).toMatchObject({ outcome: "applied", recorded: false });
      expect(result.why).toContain("supervisor lock is held");
      expect(c.record()).toBeNull();
      expect(existsSync(join(c.root, ".ralph", "control", "inbox", "re-locked.json"))).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("retries only a failed attempt, opening a linked one", async () => {
    const c = recovery("retry");
    const idle = await c.send(c.deps, { loop: "ralph", action: "retry", run: "run-1", id: "re-1" });
    expect(idle).toMatchObject({ outcome: "refused", recorded: true });

    c.endWith({ kind: "failed", why: "review cannot log in", at: "2026-09-22T10:00:00Z" });
    const retried = await c.send(c.deps, { loop: "ralph", action: "retry", run: "run-1", id: "re-2" });
    expect(retried).toMatchObject({ outcome: "applied", recorded: true });
    expect(retried.why).toContain("retrying as run-1/attempt-3 after run-1/attempt-2");
    expect(c.record()?.retries).toHaveLength(1);
  });
});
