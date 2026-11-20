// @vitest-environment node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { subprocessSuite } from "./test-timeouts";
import { writeProjectConfig, type RosterFixture } from "./dashboard/fixtures";

subprocessSuite("runs start.sh with real flock, sleep and pgrep, and fake systemd-run and systemctl");

const HARNESS = __dirname;
const scratchRoots: string[] = [];
const childPids: number[] = [];

afterAll(() => {
  for (const pid of childPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/**
 * A project worktree (`root`) and a separate harness checkout (`home`), as
 * `~/ralph` and a project are. `start.sh` resolves the harness from its own
 * location and the project from its cwd.
 */
function scratchStarter(roster?: RosterFixture): { root: string; home: string; argvFile: string } {
  const scratch = mkdtempSync(join(tmpdir(), "loggd-ralph-start-"));
  scratchRoots.push(scratch);
  const root = join(scratch, "project");
  const home = join(scratch, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const file of ["start.sh", "project.sh"]) cpSync(join(HARNESS, file), join(home, file));
  chmodSync(join(home, "start.sh"), 0o755);
  // Only for the role case: the poll interval is read by a real
  // `project-config.ts`, so the scratch harness needs that module and the
  // three it imports. Without them the read fails and 300 stays the default,
  // which is what every other test here asserts.
  if (roster !== undefined) {
    for (const file of ["project-config.ts", "paths.ts", "project-id.ts", "roles.ts"]) {
      cpSync(join(HARNESS, file), join(home, file));
    }
    writeProjectConfig(root, roster);
  }

  writeFileSync(
    join(bin, "nohup"),
    [
      "#!/usr/bin/env bash",
      'sleep "${FAKE_NOHUP_DELAY:-0}"',
      'exec "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "nohup"), 0o755);

  const argvFile = join(root, "argv.log");
  writeFileSync(argvFile, "");
  const fakeSupervisor = [
    "#!/usr/bin/env bash",
    'sleep "${FAKE_SUPERVISOR_WRITE_DELAY:-0}"',
    `printf 'wait=%s max=%s pid=%s cwd=%s\\n' "$RALPH_WAIT_FOR_WORK" "$1" "$$" "$PWD" >> ${JSON.stringify(argvFile)}`,
    'sleep "${FAKE_SUPERVISOR_SLEEP:-30}"',
    "",
  ].join("\n");
  writeFileSync(join(home, "ralph.sh"), fakeSupervisor);
  chmodSync(join(home, "ralph.sh"), 0o755);

  return { root, home, argvFile };
}

function start(root: string, env: Record<string, string> = {}) {
  return spawnSync(join(root, "..", "home", "start.sh"), {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...env },
  });
}

function publishedPid(root: string): number {
  const pid = Number(
    readFileSync(join(root, ".ralph", "logs", "supervisor.pid"), "utf8").trim(),
  );
  childPids.push(pid);
  return pid;
}

/**
 * The supervisor invocations recorded so far, once there are at least `count`.
 *
 * The fake supervisor runs in the background and records itself after
 * `start.sh` has returned, so a read straight after `start` races it; on a
 * loaded host that write took longer than the second this used to wait
 * (#187). Waits up to 10 s, then returns what is there for the assertion.
 */
function recordedInvocations(argvFile: string, count = 1): string[] {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lines = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
    if (lines.length >= count || Date.now() > deadline) return lines;
    execFileSync("sleep", ["0.02"]);
  }
}

function recordedInvocation(argvFile: string): string {
  return recordedInvocations(argvFile).join("\n");
}

describe("the daily Ralph starter", () => {
  it("starts a detached gated supervisor with daily defaults", () => {
    const work = scratchStarter();
    const run = start(work.root);

    expect(run.status).toBe(0);
    expect(recordedInvocation(work.argvFile)).toMatch(/wait=300 max=50/);
    // The supervisor runs in the PROJECT, not in the harness checkout: its cwd
    // is what the process-table matcher tells the loops apart by.
    expect(recordedInvocation(work.argvFile)).toContain(`cwd=${work.root}`);
    expect(run.stdout).toContain("waits 300s, runs up to 50 iterations");
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  it("waits the interval this loop's ROLE declares when the operator names none", () => {
    // A triager's gate answers "what has nobody looked at", which nothing but a
    // human filing an issue or a coder finishing one can change, so it polls at
    // half the rate (`roles.ts`'s `pollSeconds`). Read here rather than in
    // `ralph.sh`, where an empty interval means UNGATED.
    const work = scratchStarter(["codo", { name: "tria", role: "triager" }]);
    writeFileSync(join(work.root, ".ralph", "loop-name"), "tria\n");

    const run = start(work.root);
    expect(run.status).toBe(0);
    expect(recordedInvocation(work.argvFile)).toMatch(/wait=600 max=50/);
    expect(run.stdout).toContain("waits 600s");
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  it("takes the roster's first loop when the worktree names none, as the supervisor does", () => {
    // `ralph.sh` falls back to the roster's first loop, so `start.sh` has to
    // too: a default-named triager handed a coder's interval is the one case
    // the per-role interval exists for. 600 can only come from the read — the
    // fallback is 300 — so this is also what proves the read happened at all.
    const work = scratchStarter([{ name: "tria", role: "triager" }, "codo"]);
    const run = start(work.root);
    expect(run.status).toBe(0);
    expect(recordedInvocation(work.argvFile)).toMatch(/wait=600 max=50/);
    publishedPid(work.root);
  });

  it("keeps 300 for a coder, and for a worktree whose loop the roster cannot place", () => {
    // Both halves land on 300, which is also the fallback — so neither proves
    // the read ran; the two 600 cases above do that. What these pin is that a
    // coder's number did not MOVE when the interval became per-role, and that
    // an unplaceable name degrades rather than refusing the start: the refusal
    // is `ralph.sh`'s to make, a moment later, with the roster named.
    const coder = scratchStarter(["codo", { name: "tria", role: "triager" }]);
    writeFileSync(join(coder.root, ".ralph", "loop-name"), "codo\n");
    expect(start(coder.root).status).toBe(0);
    expect(recordedInvocation(coder.argvFile)).toMatch(/wait=300 max=50/);
    publishedPid(coder.root);

    const stranger = scratchStarter(["codo"]);
    writeFileSync(join(stranger.root, ".ralph", "loop-name"), "nobody\n");
    expect(start(stranger.root).status).toBe(0);
    expect(recordedInvocation(stranger.argvFile)).toMatch(/wait=300 max=50/);
    publishedPid(stranger.root);
  });

  it("allows an operator to override the interval and iteration cap", () => {
    const work = scratchStarter();
    const run = start(work.root, {
      RALPH_WAIT_FOR_WORK: "60",
      RALPH_MAX_ITERATIONS: "10",
    });

    expect(run.status).toBe(0);
    expect(recordedInvocation(work.argvFile)).toMatch(/wait=60 max=10/);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  it.each([
    ["RALPH_WAIT_FOR_WORK", "soon"],
    ["RALPH_WAIT_FOR_WORK", "0"],
    ["RALPH_MAX_ITERATIONS", "many"],
    ["RALPH_MAX_ITERATIONS", "0"],
  ])("rejects invalid %s=%s before launching", (name, value) => {
    const work = scratchStarter();
    const run = start(work.root, { [name]: value });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`${name} must be a positive integer`);
    expect(readFileSync(work.argvFile, "utf8")).toBe("");
  });

  it("waits for delayed PID publication without waiting for the supervisor", () => {
    const work = scratchStarter();
    const started = Date.now();
    const run = start(work.root, {
      FAKE_NOHUP_DELAY: "0.5",
      FAKE_SUPERVISOR_WRITE_DELAY: "0.75",
      FAKE_SUPERVISOR_SLEEP: "2",
    });

    expect(run.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  it("bounds startup and launches nothing when the wrapper never becomes ready", () => {
    const work = scratchStarter();
    const started = Date.now();
    const run = start(work.root, { FAKE_NOHUP_DELAY: "3" });

    expect(run.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_800);
    expect(run.stderr).toContain("did not publish a PID");
    expect(readFileSync(work.argvFile, "utf8")).toBe("");
  });

  it("does not start a duplicate supervisor in the same worktree", () => {
    const work = scratchStarter();
    const first = start(work.root);
    const second = start(work.root);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already running");
    expect(recordedInvocations(work.argvFile)).toHaveLength(1);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  // The live-supervisor guard refuses a start, and the reconciler restarts
  // through it unattended: a supervisor.pid that names anything other than a
  // live supervisor of THIS worktree must never block a start.
  it.each([
    ["a recycled pid that is no supervisor", "plain"],
    ["a ralph.sh running in another worktree", "elsewhere"],
    ["a shell whose -c command only mentions ralph.sh", "shell"],
  ] as const)("starts when supervisor.pid names %s", (_label, kind) => {
    const work = scratchStarter();
    const other = join(work.root, "..", "other");
    mkdirSync(other, { recursive: true });
    const script = join(other, "ralph.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(script, 0o755);
    const [command, args, cwd, marker] =
      kind === "plain"
        ? ["sleep", ["30"], work.root, "sleep"]
        : kind === "elsewhere"
          ? ["bash", [script], other, "/ralph.sh"]
          : ["bash", ["-c", `sleep 30; : ${script}`], work.root, "-c"];
    const impostor = spawn(command, args, { cwd, stdio: "ignore", detached: true });
    impostor.unref();
    const pid = impostor.pid ?? 0;
    childPids.push(pid);
    awaitCmdline(pid, marker);
    mkdirSync(join(work.root, ".ralph", "logs"), { recursive: true });
    writeFileSync(join(work.root, ".ralph", "logs", "supervisor.pid"), `${pid}\n`);

    const run = start(work.root);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Started Ralph supervisor");
    expect(publishedPid(work.root)).not.toBe(pid);
  });

  it("waits briefly for a lock held a moment, as the dashboard's recovery poll holds it", () => {
    const work = scratchStarter();
    mkdirSync(join(work.root, ".ralph", "logs"), { recursive: true });
    const lock = join(work.root, ".ralph", "logs", "supervisor.lock");
    const holder = spawn("flock", [lock, "sleep", "0.5"], { stdio: "ignore" });
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i += 1) {
      execFileSync("sleep", ["0.02"]);
    }
    const run = start(work.root);
    holder.kill();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Started Ralph supervisor");
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });

  it("releases the lock when the supervisor dies but its descendant remains", () => {
    const work = scratchStarter();
    const first = start(work.root);
    const firstPid = publishedPid(work.root);
    // The supervisor forks its child a moment after publishing its own pid, so
    // on a loaded host an immediate pgrep can find nothing yet: poll for it.
    const descendantPid = firstChildOf(firstPid);
    childPids.push(descendantPid);

    process.kill(firstPid, "SIGTERM");
    execFileSync("sleep", ["0.3"]);
    expect(() => process.kill(descendantPid, 0)).not.toThrow();

    const second = start(work.root);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Started Ralph supervisor");
    expect(recordedInvocations(work.argvFile, 2)).toHaveLength(2);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
  });
});

/**
 * Fake `systemd-run` and `systemctl` on the scratch PATH, so no test ever
 * creates or stops a real unit on the host of the live loops. `systemd-run`
 * records its argv, then execs the command after its options, as the real
 * `--scope` does; with FAKE_SYSTEMD_RUN_FAIL set it refuses and runs nothing.
 * `systemctl` answers `show-environment`, reports FAKE_UNIT_LOADSTATE for the
 * unit and records every other call.
 */
function fakeSystemd(root: string): { runLog: string; ctlLog: string } {
  const bin = join(root, "bin");
  const runLog = join(root, "systemd-run.log");
  const ctlLog = join(root, "systemctl.log");
  writeFileSync(runLog, "");
  writeFileSync(ctlLog, "");
  writeFileSync(
    join(bin, "systemd-run"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(runLog)}`,
      '[ -n "${FAKE_SYSTEMD_RUN_FAIL:-}" ] && exit 1',
      // A stalled user manager: the job never starts, so nothing is exec'd.
      '[ -n "${FAKE_SYSTEMD_RUN_HANG:-}" ] && exec sleep 30',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    --unit) shift 2 ;;",
      "    -*) shift ;;",
      "    *) break ;;",
      "  esac",
      "done",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      'case "$*" in',
      "  *show-environment*) exit 0 ;;",
      '  *"show -p LoadState"*) echo "${FAKE_UNIT_LOADSTATE:-not-found}"; exit 0 ;;',
      '  *"show -p ControlGroup"*) echo "${FAKE_UNIT_CGROUP:-}"; exit 0 ;;',
      "esac",
      `printf '%s\\n' "$*" >> ${JSON.stringify(ctlLog)}`,
      'case "$*" in',
      "  *is-active*|*is-failed*) exit 1 ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "systemd-run"), 0o755);
  chmodSync(join(bin, "systemctl"), 0o755);
  return { runLog, ctlLog };
}

/** The supervisor log `start.sh` appends its launch line to. */
function loopLog(root: string): string {
  return readFileSync(join(root, ".ralph", "logs", "loop.stdout"), "utf8");
}

/** A process's parent pid, from `/proc/<pid>/stat` (after the `(comm)` field). */
function parentOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

/** Polls until nothing holds `lock`, or throws after 10 s. */
function awaitLockFree(lock: string): void {
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", lock, "true"]).status !== 0) {
    if (Date.now() > deadline) throw new Error(`${lock} still held after 10 s`);
    execFileSync("sleep", ["0.02"]);
  }
}

describe("the supervisor's systemd unit", () => {
  it("falls back to nohup setsid when systemd-run is not on PATH", () => {
    const work = scratchStarter();
    // Only the tools start.sh and the fake supervisor need, as symlinks, so
    // the host's own systemd-run (and systemctl) cannot be found.
    const tools = join(work.root, "tools");
    mkdirSync(tools);
    for (const tool of ["bash", "env", "dirname", "readlink", "git", "cat", "mkdir", "flock", "setsid", "sleep", "tr", "realpath"]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found.startsWith("/")) symlinkSync(found, join(tools, tool));
    }
    const PATH = `${join(work.root, "bin")}:${tools}`;
    // The full environment, not just PATH: a bash with no SHLVL whose stdin
    // is node's socketpair takes itself for an ssh session and sources the
    // host's bashrc, which recursed without end under this narrow PATH.
    const probe = spawnSync("bash", ["-c", "command -v systemd-run"], {
      env: { ...process.env, PATH },
      stdio: "ignore",
    });
    expect(probe.status).toBe(1);

    const run = start(work.root, { PATH, RALPH_LOOP_SCOPE: "" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Started Ralph supervisor \(pid \d+\);/);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
    expect(loopLog(work.root)).toContain(
      "start.sh: launching with nohup setsid (systemd-run --user unavailable: systemd-run not on PATH)",
    );
  });

  it("launches in a transient user scope named for the project and the loop", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    mkdirSync(join(work.root, ".ralph"), { recursive: true });
    writeFileSync(join(work.root, ".ralph", "loop-name"), "codo\n");

    const run = start(work.root, { RALPH_LOOP_SCOPE: "", RALPH_PROJECT_ID: "soft ware/x" });
    expect(run.status).toBe(0);
    const argv = readFileSync(fakes.runLog, "utf8");
    expect(argv).toMatch(/^--user --scope --quiet --collect --unit ralph-loop-soft-ware-x-codo bash -c /);
    const pid = publishedPid(work.root);
    expect(recordedInvocation(work.argvFile)).toContain(`pid=${pid}`);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(run.stdout).toContain(`Started Ralph supervisor (pid ${pid}) in unit ralph-loop-soft-ware-x-codo.scope;`);
    expect(loopLog(work.root)).toContain("start.sh: launching in transient unit ralph-loop-soft-ware-x-codo.scope");
    // Nothing loaded under the name, so nothing was stopped.
    expect(readFileSync(fakes.ctlLog, "utf8")).not.toMatch(/\bstop\b/);
  });

  it("names the unit for the worktree's basename and loop `ralph` when neither is given", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const run = start(work.root, { RALPH_LOOP_SCOPE: "" });
    expect(run.status).toBe(0);
    expect(readFileSync(fakes.runLog, "utf8")).toContain("--unit ralph-loop-project-ralph ");
    publishedPid(work.root);
  });

  it("stops a stale unit left by a dead supervisor before launching", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const run = start(work.root, { RALPH_LOOP_SCOPE: "", FAKE_UNIT_LOADSTATE: "loaded" });
    expect(run.status).toBe(0);
    const calls = readFileSync(fakes.ctlLog, "utf8");
    expect(calls).toContain("--user stop ralph-loop-project-ralph.scope");
    expect(calls).toContain("--user reset-failed ralph-loop-project-ralph.scope");
    expect(readFileSync(fakes.runLog, "utf8")).not.toBe("");
    expect(loopLog(work.root)).toContain("stopped stale unit ralph-loop-project-ralph.scope");
    publishedPid(work.root);
  });

  // The same unit name can belong to another worktree's loop (a worktree with
  // no loop name defaults to `ralph`): its live supervisor must survive.
  it.each([
    ["leaves a scope holding another loop's live supervisor alone, and starts on the fallback", "supervisor"],
    ["still stops a scope that holds only a dead supervisor's orphans", "orphan"],
  ] as const)("%s", (_label, kind) => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const other = join(work.root, "..", "other");
    mkdirSync(other, { recursive: true });
    const script = join(other, "ralph.sh");
    writeFileSync(script, "#!/usr/bin/env bash\nsleep 30\n");
    chmodSync(script, 0o755);
    const [command, args, marker] = kind === "supervisor" ? ["bash", [script, "50"], "/ralph.sh"] : ["sleep", ["30"], "sleep"];
    const held = spawn(command, args, { cwd: other, stdio: "ignore", detached: true });
    held.unref();
    const heldPid = held.pid ?? 0;
    childPids.push(heldPid);
    awaitCmdline(heldPid, marker);
    const cgroupRoot = join(work.root, "cgroup");
    const scopeDir = join(cgroupRoot, "app.slice", "ralph-loop-project-ralph.scope");
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(join(scopeDir, "cgroup.procs"), `${heldPid}\n`);

    const run = start(work.root, {
      RALPH_LOOP_SCOPE: "",
      FAKE_UNIT_LOADSTATE: "loaded",
      FAKE_UNIT_CGROUP: "/app.slice/ralph-loop-project-ralph.scope",
      RALPH_CGROUP_ROOT: cgroupRoot,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Started Ralph supervisor");
    publishedPid(work.root);
    const calls = readFileSync(fakes.ctlLog, "utf8");
    if (kind === "supervisor") {
      expect(calls).not.toMatch(/\bstop\b/);
      expect(readFileSync(fakes.runLog, "utf8")).toBe("");
      expect(loopLog(work.root)).toContain(
        "launching with nohup setsid (systemd-run --user unavailable: unit ralph-loop-project-ralph.scope holds a live supervisor this worktree does not own)",
      );
      expect(() => process.kill(heldPid, 0)).not.toThrow();
    } else {
      expect(calls).toContain("--user stop ralph-loop-project-ralph.scope");
      expect(loopLog(work.root)).toContain("launching in transient unit ralph-loop-project-ralph.scope");
    }
  });

  it("refuses to start beside a live supervisor whose wrapper was killed", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const env = { RALPH_LOOP_SCOPE: "", FAKE_UNIT_LOADSTATE: "loaded" };
    expect(start(work.root, env).status).toBe(0);
    const pid = publishedPid(work.root);
    recordedInvocations(work.argvFile);
    // The wrapper holds the lock; killing it alone leaves the supervisor.
    process.kill(parentOf(pid), "SIGKILL");
    awaitLockFree(join(work.root, ".ralph", "logs", "supervisor.lock"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    writeFileSync(fakes.ctlLog, "");
    writeFileSync(fakes.runLog, "");

    const second = start(work.root, env);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(`already running (pid ${pid})`);
    expect(readFileSync(fakes.runLog, "utf8")).toBe("");
    expect(readFileSync(fakes.ctlLog, "utf8")).not.toMatch(/\bstop\b/);
    expect(recordedInvocations(work.argvFile)).toHaveLength(1);
    expect(readFileSync(join(work.root, ".ralph", "logs", "supervisor.pid"), "utf8").trim()).toBe(String(pid));
  });

  it("falls back to nohup setsid when systemd-run stalls without running anything", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const run = start(work.root, { RALPH_LOOP_SCOPE: "", FAKE_SYSTEMD_RUN_HANG: "1" });
    expect(run.status).toBe(0);
    expect(readFileSync(fakes.runLog, "utf8")).not.toBe("");
    expect(run.stdout).toMatch(/^Started Ralph supervisor \(pid \d+\);/);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
    expect(loopLog(work.root)).toContain("systemd-run refused or stalled on unit ralph-loop-project-ralph.scope");
    expect(recordedInvocations(work.argvFile)).toHaveLength(1);
  });

  it("answers already running for this worktree's own supervisor in the scope, when its pid file lost it", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const live = spawn(join(work.root, "..", "home", "ralph.sh"), ["50"], { cwd: work.root, stdio: "ignore", detached: true });
    live.unref();
    const livePid = live.pid ?? 0;
    childPids.push(livePid);
    awaitCmdline(livePid, "/ralph.sh");
    const cgroupRoot = join(work.root, "cgroup");
    const scopeDir = join(cgroupRoot, "app.slice", "ralph-loop-project-ralph.scope");
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(join(scopeDir, "cgroup.procs"), `${livePid}\n`);
    writeFileSync(work.argvFile, "");

    const run = start(work.root, {
      RALPH_LOOP_SCOPE: "",
      FAKE_UNIT_LOADSTATE: "loaded",
      FAKE_UNIT_CGROUP: "/app.slice/ralph-loop-project-ralph.scope",
      RALPH_CGROUP_ROOT: cgroupRoot,
      FAKE_SUPERVISOR_SLEEP: "0",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`already running (pid ${livePid})`);
    expect(readFileSync(fakes.runLog, "utf8")).toBe("");
    expect(readFileSync(fakes.ctlLog, "utf8")).not.toMatch(/\bstop\b/);
    expect(readFileSync(join(work.root, ".ralph", "logs", "supervisor.pid"), "utf8").trim()).toBe(String(livePid));
  });

  it("prints nothing on stderr when supervisor.pid names a pid that is gone", () => {
    const work = scratchStarter();
    mkdirSync(join(work.root, ".ralph", "logs"), { recursive: true });
    // Above the default pid_max, so no live process can hold it.
    writeFileSync(join(work.root, ".ralph", "logs", "supervisor.pid"), "4194304\n");
    const run = start(work.root);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    publishedPid(work.root);
  });

  it("falls back to nohup setsid when systemd-run refuses the unit", () => {
    const work = scratchStarter();
    const fakes = fakeSystemd(work.root);
    const run = start(work.root, { RALPH_LOOP_SCOPE: "", FAKE_SYSTEMD_RUN_FAIL: "1" });
    expect(run.status).toBe(0);
    expect(readFileSync(fakes.runLog, "utf8")).not.toBe("");
    expect(run.stdout).toMatch(/^Started Ralph supervisor \(pid \d+\);/);
    expect(publishedPid(work.root)).toBeGreaterThan(0);
    expect(loopLog(work.root)).toContain(
      "start.sh: systemd-run refused or stalled on unit ralph-loop-project-ralph.scope (status 1); falling back to nohup setsid",
    );
  });
});

/** Polls until `pid` has exec'd into a command line containing `marker`, or throws after 10 s. */
function awaitCmdline(pid: number, marker: string): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    let argv = "";
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {}
    if (argv.split("\0").some((arg) => arg.includes(marker))) return;
    if (Date.now() > deadline) throw new Error(`pid ${pid} never ran ${marker}`);
    execFileSync("sleep", ["0.02"]);
  }
}

function firstChildOf(parent: number, budgetMs = 10_000): number {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    const pid = Number(found.stdout.trim().split("\n")[0]);
    if (found.status === 0 && pid > 0) return pid;
    if (Date.now() > deadline) throw new Error(`no child of ${parent} appeared within ${budgetMs} ms`);
    execFileSync("sleep", ["0.05"]);
  }
}
