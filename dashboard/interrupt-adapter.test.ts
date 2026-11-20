// @vitest-environment node
/**
 * The one module on the dashboard that may signal a process, driven against
 * real processes.
 *
 * Every refusal is a real process the check has to see through: a pid that
 * has exited, a pid that is not `ralph.sh`, a `ralph.sh` running in another
 * checkout, and one sharing the dashboard's own process group. The accepted
 * target is a stand-in supervisor started the way `start.sh` starts one — a
 * `setsid` wrapper leading the group, with `ralph.sh` and its child inside it
 * — and the signal is asserted to reach all of them and nothing else.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { SIGNAL_SURFACE, createInterruptAdapter } from "./interrupt-adapter";
import { subprocessSuite } from "../test-timeouts";

subprocessSuite("interrupts real bash and sleep processes");

const roots: string[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A checkout with a stand-in `ralph.sh` that keeps a child of its own. */
function checkout(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ralph-interrupt-${label}-`)));
  roots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  writeFileSync(join(root, "ralph.sh"), "sleep 60 &\nwait\n");
  return root;
}

const pidFile = (root: string) => join(root, SIGNAL_SURFACE.pidFile);

async function waitFor(read: () => string | null): Promise<string> {
  for (let tries = 0; tries < 100; tries++) {
    const value = read();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("timed out");
}

/** As `start.sh` does it: a `setsid` wrapper leads the group and publishes the supervisor's pid. */
async function startLikeStartSh(root: string, cwd = root): Promise<{ pid: number; group: number }> {
  const wrapper = spawn(
    "bash",
    ["-c", `bash ${JSON.stringify(join(root, "ralph.sh"))} & printf '%s\\n' "$!" > ${JSON.stringify(pidFile(root))}; wait`],
    { cwd, detached: true, stdio: "ignore" },
  );
  children.push(wrapper);
  groups.push(wrapper.pid!);
  const pid = Number(await waitFor(() => (existsSync(pidFile(root)) ? readFileSync(pidFile(root), "utf8").trim() : null)));
  await sleep(50);
  return { pid, group: wrapper.pid! };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the checks before any signal", () => {
  it("accepts this checkout's supervisor and names its group", async () => {
    const root = checkout("ok");
    const { pid, group } = await startLikeStartSh(root);
    const target = createInterruptAdapter({ root }).inspect();
    expect(target).toMatchObject({ ok: true, pid, group, pidFile: SIGNAL_SURFACE.pidFile });
    expect(target.checks.map((check) => [check.check, check.ok])).toEqual([
      ["pid-file", true],
      ["alive", true],
      ["ralph.sh", true],
      ["cwd", true],
      ["group", true],
    ]);
  });

  it("accepts a supervisor started by hand that leads its own group", async () => {
    const root = checkout("by-hand");
    const supervisor = spawn("bash", [join(root, "ralph.sh")], { cwd: root, detached: true, stdio: "ignore" });
    children.push(supervisor);
    groups.push(supervisor.pid!);
    writeFileSync(pidFile(root), `${supervisor.pid}\n`);
    await sleep(50);
    expect(createInterruptAdapter({ root }).inspect()).toMatchObject({ ok: true, group: supervisor.pid });
  });

  it("refuses a checkout with no pid, naming the file", () => {
    const root = checkout("no-pid");
    const missing = createInterruptAdapter({ root }).inspect();
    expect(missing).toMatchObject({ ok: false, pid: null, group: null });
    expect(missing.checks).toEqual([{ check: "pid-file", ok: false, detail: expect.stringContaining("supervisor.pid") }]);
    writeFileSync(pidFile(root), "\n");
    expect(createInterruptAdapter({ root }).inspect().checks[0]).toMatchObject({ check: "pid-file", ok: false });
    writeFileSync(pidFile(root), "1234; rm -rf /\n");
    expect(createInterruptAdapter({ root }).inspect().checks[0]).toMatchObject({ check: "pid-file", ok: false });
  });

  it("refuses a pid that is not running", () => {
    const root = checkout("dead");
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" });
    writeFileSync(pidFile(root), gone.stdout);
    const target = createInterruptAdapter({ root }).inspect();
    expect(target.ok).toBe(false);
    expect(target.checks.at(-1)).toMatchObject({ check: "alive", ok: false });
  });

  it("refuses a live pid that is not ralph.sh", async () => {
    const root = checkout("not-ralph");
    const other = spawn("sleep", ["60"], { cwd: root, detached: true, stdio: "ignore" });
    children.push(other);
    writeFileSync(pidFile(root), `${other.pid}\n`);
    await sleep(50);
    const target = createInterruptAdapter({ root }).inspect();
    expect(target.ok).toBe(false);
    expect(target.checks.at(-1)).toMatchObject({ check: "ralph.sh", ok: false, detail: expect.stringContaining("sleep") });
  });

  it("refuses a ralph.sh working in another checkout, as a reused pid would", async () => {
    const root = checkout("wrong-cwd");
    const elsewhere = checkout("elsewhere");
    const { pid } = await startLikeStartSh(root, elsewhere);
    const target = createInterruptAdapter({ root }).inspect();
    expect(target.ok).toBe(false);
    expect(target.pid).toBe(pid);
    expect(target.checks.at(-1)).toMatchObject({ check: "cwd", ok: false, detail: expect.stringContaining(elsewhere) });
  });

  it("refuses a supervisor in the dashboard's own process group", async () => {
    const root = checkout("own-group");
    const supervisor = spawn("bash", [join(root, "ralph.sh")], { cwd: root, stdio: "ignore" });
    children.push(supervisor);
    writeFileSync(pidFile(root), `${supervisor.pid}\n`);
    await sleep(50);
    const target = createInterruptAdapter({ root }).inspect();
    expect(target.ok).toBe(false);
    expect(target.checks.at(-1)).toMatchObject({ check: "group", ok: false });
  });
});

describe("the signal", () => {
  it("reaches the supervisor and its children through the group, and nothing outside it", async () => {
    const root = checkout("signal");
    const { pid, group } = await startLikeStartSh(root);
    const bystander = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    children.push(bystander);
    const adapter = createInterruptAdapter({ root });
    // Unchecked, nothing vouches for the group: only an inspection's target is the loop's.
    expect(adapter.remaining({ pid, group }).ours).toBe(false);
    expect(adapter.inspect().ok).toBe(true);

    expect(adapter.remaining({ pid, group })).toEqual({ supervisor: true, group: true, ours: true });
    expect(adapter.signal(group, "SIGTERM")).toBeNull();
    for (let tries = 0; tries < 100 && adapter.remaining({ pid, group }).group; tries++) await sleep(20);

    expect(adapter.remaining({ pid, group })).toMatchObject({ supervisor: false, group: false });
    expect(alive(pid)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it("still vouches for a group whose supervisor and leader are gone but whose straggler ignores SIGTERM", async () => {
    // A child the iteration left in the group — a hung test runner, a dev
    // server — outlives SIGTERM. The group number is still the loop's: the
    // kernel keeps it while any member holds it, and it could only have been
    // reused after the group emptied and the pid counter came all the way round.
    const root = checkout("straggler");
    writeFileSync(join(root, "ralph.sh"), "bash -c 'trap \"\" TERM; exec sleep 60' &\nsleep 60 &\nwait\n");
    const { pid, group } = await startLikeStartSh(root);
    const adapter = createInterruptAdapter({ root });
    expect(adapter.inspect().ok).toBe(true);
    expect(adapter.signal(group, "SIGTERM")).toBeNull();
    for (let tries = 0; tries < 100 && adapter.remaining({ pid, group }).supervisor; tries++) await sleep(20);
    await sleep(100);

    expect(adapter.remaining({ pid, group })).toEqual({ supervisor: false, group: true, ours: true });
    expect(adapter.signal(group, "SIGKILL")).toBeNull();
    for (let tries = 0; tries < 100 && adapter.remaining({ pid, group }).group; tries++) await sleep(20);
    expect(adapter.remaining({ pid, group }).group).toBe(false);
  });

  it("stops vouching for a leaderless group once the pid counter has wrapped since the check", async () => {
    const root = checkout("wrapped");
    writeFileSync(join(root, "ralph.sh"), "bash -c 'trap \"\" TERM; exec sleep 60' &\nsleep 60 &\nwait\n");
    const { pid, group } = await startLikeStartSh(root);
    let last = 4_000_000;
    const adapter = createInterruptAdapter({ root, lastPid: () => last });
    expect(adapter.inspect().ok).toBe(true);
    adapter.signal(group, "SIGTERM");
    for (let tries = 0; tries < 100 && adapter.remaining({ pid, group }).supervisor; tries++) await sleep(20);
    await sleep(100);
    expect(adapter.remaining({ pid, group }).ours).toBe(true);
    // The counter went down: it came round, and the number could name somebody else's group now.
    last = 300;
    expect(adapter.remaining({ pid, group })).toEqual({ supervisor: false, group: true, ours: false });
    // And a counter that cannot be read proves nothing.
    last = Number.NaN;
    expect(adapter.remaining({ pid, group }).ours).toBe(false);
  });

  it("reports a group it could not signal rather than throwing", () => {
    const root = checkout("no-group");
    expect(createInterruptAdapter({ root }).signal(2 ** 22, "SIGTERM")).toMatch(/ESRCH/);
  });
});

describe("the audit record", () => {
  it("appends one line per entry to a file the project never commits", () => {
    const root = checkout("audit");
    const adapter = createInterruptAdapter({ root });
    const entry = {
      id: "now-1",
      at: "2026-09-22T00:00:00.000Z",
      event: "refused" as const,
      loop: "ralph",
      run: "run-1",
      reason: "the model is looping",
      target: { pidFile: SIGNAL_SURFACE.pidFile, pid: null, group: null },
      checks: [{ check: "pid-file" as const, ok: false, detail: "missing" }],
      signal: null,
      outcome: "refused",
      detail: "no pid",
    };
    expect(adapter.audit(entry)).toBeNull();
    expect(adapter.audit({ ...entry, id: "now-2" })).toBeNull();
    const lines = readFileSync(join(root, SIGNAL_SURFACE.audit.path), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["now-1", "now-2"]);
    expect(JSON.parse(lines[0]!)).toEqual(entry);
    expect(readFileSync(join(root, SIGNAL_SURFACE.audit.dir, ".gitignore"), "utf8")).toBe("*\n");
  });
});
