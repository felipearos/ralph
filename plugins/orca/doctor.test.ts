// @vitest-environment node
/**
 * The Orca plugin's doctor: five checks, the repair that fits each, and Fix
 * all — first check by check against an injected `orca`, then end to end
 * through the host (`plugin-doctor.ts`), a fake `orca` on disk and the core's
 * own `controls.ts poll`, which is where "a command sent from Orca reaches
 * the loop" is actually decided.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CONTROL_STATE_RELATIVE_PATH, parseControlState } from "../../controls";
import { STATE_RELATIVE_PATH } from "../../loop-state";
import { DOCTOR_RECORD_RELATIVE_PATH, parseDoctorRecord, type DoctorOutput } from "../../plugin-doctor";
import { ORCA_BINDING_RELATIVE_PATH, readOrcaConsumerBinding } from "./binding";
import type { Called } from "./cli";
import {
  DOCTOR_FORBIDDEN_ARGS,
  DOCTOR_VERBS,
  callOrcaForDoctor,
  diagnose,
  repair,
  type Check,
  type Context,
  type DoctorVerb,
} from "./doctor";
import { ORCA_STATE_RELATIVE_PATH, objectiveFor } from "./lifecycle";
import { MAILBOX_STATE_RELATIVE_PATH } from "./mailbox";
import { subprocessSuite } from "../../test-timeouts";

subprocessSuite("runs the Orca doctor and ralph.sh through bash and bun");

const REPO_ROOT = join(__dirname, "..", "..");

const scratchRoots: string[] = [];
afterAll(() => scratchRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const BUN = process.env.RALPH_TEST_BUN ?? ((): string => {
  try {
    return execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
  } catch {
    return process.execPath;
  }
})();

const scratch = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `ralph-orca-doctor-${label}-`));
  scratchRoots.push(root);
  mkdirSync(join(root, ".ralph", "logs"), { recursive: true });
  return root;
};

const adapterRecord = (root: string, over: Record<string, unknown> = {}): void =>
  writeFileSync(
    join(root, ORCA_STATE_RELATIVE_PATH),
    JSON.stringify({
      version: 1,
      ralphRun: "ralph-run-1",
      loop: "ralph",
      worktree: root,
      terminal: null,
      orcaRun: "run_fake",
      task: null,
      attempt: null,
      degraded: null,
      displacedBinding: null,
      lastRejected: null,
      lastEvent: null,
      ...over,
    }),
  );

/* --------------------------------------------------------------------------
 * Check by check, against an injected Orca.
 * ----------------------------------------------------------------------- */

const ok = (result: Record<string, unknown> = {}): Called => ({ ok: true, result, why: "", kind: null, code: null });
const refused = (why: string, kind: Called["kind"] = "refused"): Called => ({ ok: false, result: null, why, kind, code: null });
const ready = ok({ runtime: { state: "ready", reachable: true } });

interface Fake {
  ctx: Context;
  calls: string[];
}

function fake(root: string, answers: Partial<Record<DoctorVerb, (args: string[]) => Called>>, over: Partial<Context> = {}): Fake {
  const calls: string[] = [];
  const ctx: Context = {
    root,
    loop: { run: "ralph-run-1", loop: "ralph", worktree: root },
    host: null,
    now: () => Date.parse("2026-09-22T12:00:00.000Z"),
    call: (verb, args) => {
      calls.push([verb, ...args].join(" "));
      return (answers[verb] ?? (() => ok()))(args);
    },
    launch: (verb) => {
      calls.push(`launch ${verb}`);
    },
    startTimeoutMs: 0,
    sleep: () => undefined,
    ...over,
  };
  return { ctx, calls };
}

const byId = (checks: Check[]): Record<string, Check> => Object.fromEntries(checks.map((check) => [check.id, check]));
const repairIds = (check: Check | undefined): string[] => check?.repairs.map((row) => row.id) ?? [];

describe("the doctor's reach into Orca", () => {
  it("adds only startup, binding and terminal-opening verbs, and none that places work", () => {
    expect([...DOCTOR_VERBS]).toEqual([
      "status",
      "serve",
      "open",
      "orchestration run-current",
      "orchestration run-use",
      "orchestration run-create",
      "terminal create",
    ]);
    for (const verb of ["orchestration worker-start", "orchestration dispatch", "terminal send"]) {
      expect(DOCTOR_VERBS).not.toContain(verb);
    }
  });

  it("refuses to open a terminal that runs anything", () => {
    expect(DOCTOR_FORBIDDEN_ARGS).toContain("--command");
    expect(() => callOrcaForDoctor("terminal create", ["--command", "claude"])).toThrow(/may not pass '--command'/);
    expect(() => callOrcaForDoctor("terminal send" as DoctorVerb, [])).toThrow(/may not run 'terminal send'/);
  });
});

describe("diagnosing", () => {
  it("passes all five checks for a healthy, bound, unthrottled loop", () => {
    const root = scratch("healthy");
    adapterRecord(root, { terminal: "term_loop" });
    const { ctx } = fake(root, {
      status: () => ready,
      "orchestration run-current": () => ok({ run: { id: "run_fake" } }),
    });
    const checks = diagnose(ctx).checks;
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ["cli", "pass"],
      ["runtime", "pass"],
      ["run", "pass"],
      ["consumer", "pass"],
      ["backoff", "pass"],
    ]);
    expect(checks.every((check) => check.repairs.length === 0)).toBe(true);
  });

  it("offers only turning the plugin off when there is no CLI, and asks nothing further", () => {
    const root = scratch("no-cli");
    const { ctx, calls } = fake(root, { status: () => refused("no Orca CLI on PATH", "missing-cli") });
    const checks = byId(diagnose(ctx).checks);
    expect(checks.cli?.status).toBe("fail");
    expect(checks.cli?.detail).toMatch(/No Orca CLI on PATH/);
    expect(repairIds(checks.cli)).toEqual(["disable-plugin"]);
    for (const id of ["runtime", "run", "consumer"]) expect(checks[id]?.status).toBe("skipped");
    expect(calls).toEqual(["status"]);
  });

  it("starts a down runtime headless by default, with the app offered instead", () => {
    const root = scratch("runtime-down");
    const { ctx } = fake(root, { status: () => ok({ runtime: { state: "not-running", reachable: false } }) });
    const runtime = byId(diagnose(ctx).checks).runtime!;
    expect(runtime.status).toBe("fail");
    expect(runtime.detail).toMatch(/not-running/);
    expect(runtime.repairs).toEqual([
      { id: "serve", label: "Start Orca headless (orca serve)", default: true },
      { id: "open", label: "Open the Orca app (orca open)", default: false },
    ]);
  });

  it("names an unregistered run and offers to register it from the loop's terminal", () => {
    const root = scratch("unregistered");
    adapterRecord(root, { terminal: "term_loop", orcaRun: null, degraded: { why: "orca run-create timed out", at: "T", retryAt: "2026-09-22T11:00:00.000Z" } });
    const { ctx } = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: null }) });
    const checks = byId(diagnose(ctx).checks);
    expect(checks.run?.status).toBe("fail");
    expect(checks.run?.detail).toBe("Run ralph-run-1 was never registered: orca run-create timed out.");
    expect(checks.run?.repairs).toEqual([
      { id: "register", label: "Register the Run from the loop's terminal term_loop", default: true },
    ]);
    expect(checks.consumer?.status).toBe("skipped");
  });

  it("offers a terminal of the plugin's own when the loop has none to register from", () => {
    const root = scratch("unregistered-no-terminal");
    const { ctx } = fake(root, { status: () => ready });
    const run = byId(diagnose(ctx).checks).run!;
    expect(run.detail).toMatch(/no Orca Run was ever registered/);
    expect(run.repairs[0]?.label).toBe("Register the Run from a terminal the plugin opens for this loop");
  });

  it("diagnoses the original failure — Orca healthy, nothing bound — as the consumer check", () => {
    const root = scratch("no-consumer");
    adapterRecord(root, { terminal: null });
    const { ctx } = fake(root, { status: () => ready });
    const checks = byId(diagnose(ctx).checks);
    expect(checks.runtime?.status).toBe("pass");
    expect(checks.run?.status).toBe("pass");
    expect(checks.consumer?.status).toBe("fail");
    expect(checks.consumer?.detail).toMatch(/not started from an Orca terminal .* commands sent from Orca never reach the loop/);
    expect(repairIds(checks.consumer)).toEqual(["bind-new"]);
  });

  it("offers to rebind the loop's own terminal when it is merely unbound", () => {
    const root = scratch("unbound-terminal");
    adapterRecord(root, { terminal: "term_loop" });
    const { ctx } = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: null }) });
    const consumer = byId(diagnose(ctx).checks).consumer!;
    expect(consumer.detail).toMatch(/Terminal term_loop is not bound to Run run_fake/);
    expect(consumer.repairs).toEqual([
      { id: "rebind", label: "Rebind Run run_fake to terminal term_loop", default: true },
      { id: "bind-new", label: "Bind a terminal the plugin opens for this loop", default: false },
    ]);
  });

  it("never offers to take a terminal another Run holds", () => {
    const root = scratch("foreign-terminal");
    adapterRecord(root, { terminal: "term_loop" });
    const { ctx } = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: { id: "run_other" } }) });
    const consumer = byId(diagnose(ctx).checks).consumer!;
    expect(consumer.detail).toMatch(/bound to another Run \(run_other\)/);
    expect(repairIds(consumer)).toEqual(["bind-new"]);
  });

  it("offers to clear a back-off window only once nothing earlier fails", () => {
    const root = scratch("backoff");
    adapterRecord(root, { terminal: "term_loop" });
    writeFileSync(
      join(root, MAILBOX_STATE_RELATIVE_PATH),
      JSON.stringify({
        version: 1,
        delivered: [],
        gates: {},
        degraded: { why: "orca orchestration check timed out", at: "T", retryAt: "2026-09-22T12:01:00.000Z" },
      }),
    );
    const bound = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: { id: "run_fake" } }) });
    const backoff = byId(diagnose(bound.ctx).checks).backoff!;
    expect(backoff.status).toBe("fail");
    expect(backoff.detail).toMatch(/the command route: orca orchestration check timed out \(until 2026-09-22T12:01:00.000Z\)/);
    expect(repairIds(backoff)).toEqual(["retry-now"]);

    const unbound = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: null }) });
    const blocked = byId(diagnose(unbound.ctx).checks).backoff!;
    expect(blocked.status).toBe("skipped");
    expect(blocked.repairs).toEqual([]);
  });

  it("counts the host's own back-off, which only the host can see", () => {
    const root = scratch("host-backoff");
    adapterRecord(root, { terminal: "term_loop" });
    const { ctx } = fake(
      root,
      { status: () => ready, "orchestration run-current": () => ok({ run: { id: "run_fake" } }) },
      { host: { why: "on-event timed out after 60s", retryAt: "2026-09-22T12:00:30.000Z" } },
    );
    expect(byId(diagnose(ctx).checks).backoff?.detail).toMatch(/the plugin host: on-event timed out/);
  });
});

describe("repairing", () => {
  it("rebinds the Run to the loop's terminal, and records the binding the inbox hook reads", () => {
    const root = scratch("rebind");
    adapterRecord(root, { terminal: "term_loop" });
    let bound: string | null = null;
    const { ctx, calls } = fake(root, {
      status: () => ready,
      "orchestration run-current": () => ok({ run: bound === null ? null : { id: bound } }),
      "orchestration run-use": (args) => {
        bound = args[args.indexOf("--id") + 1] ?? null;
        return ok({ run: { id: bound } });
      },
    });
    const step = repair(ctx, "consumer", "rebind");
    expect(step).toMatchObject({ check: "consumer", action: "rebind", result: "repaired" });
    expect(calls).toContain("orchestration run-use --id run_fake --from term_loop");
    expect(readOrcaConsumerBinding(root)).toMatchObject({ ralphRun: "ralph-run-1", orcaRun: "run_fake", consumer: "term_loop" });
    expect(byId(diagnose(ctx).checks).consumer?.status).toBe("pass");
  });

  it("registers a Run the mirror would adopt, from a terminal it opens when the loop has none", () => {
    const root = scratch("register");
    const bindings: Record<string, { id: string; objective: string }> = {};
    const { ctx, calls } = fake(root, {
      status: () => ready,
      "terminal create": () => ok({ terminal: { handle: "term_new" } }),
      "orchestration run-current": (args) => ok({ run: bindings[args[args.indexOf("--from") + 1]!] ?? null }),
      "orchestration run-create": (args) => {
        const from = args[args.indexOf("--from") + 1]!;
        bindings[from] = { id: "run_new", objective: args[args.indexOf("--objective") + 1]! };
        return ok({ run: { id: "run_new" } });
      },
    });
    const step = repair(ctx, "run", "register");
    expect(step.result, step.why).toBe("repaired");
    expect(calls).toContain(`terminal create --worktree path:${root} --title ralph Orca mailbox`);
    expect(bindings.term_new?.objective).toBe(objectiveFor({ loop: "ralph", run: "ralph-run-1", worktree: root }));
    const state = JSON.parse(readFileSync(join(root, ORCA_STATE_RELATIVE_PATH), "utf8"));
    expect(state).toMatchObject({ ralphRun: "ralph-run-1", orcaRun: "run_new", worktree: root });
    expect(readOrcaConsumerBinding(root)?.consumer).toBe("term_new");
    const checks = byId(diagnose(ctx).checks);
    expect([checks.run?.status, checks.consumer?.status]).toEqual(["pass", "pass"]);
  });

  it("starts the runtime with orca serve, detached, and waits until it answers", () => {
    const root = scratch("serve");
    let up = false;
    const { ctx, calls } = fake(
      root,
      { status: () => (up ? ready : ok({ runtime: { state: "not-running", reachable: false } })) },
      {
        launch: (verb) => {
          calls.push(`launch ${verb}`);
          up = true;
        },
      },
    );
    expect(repair(ctx, "runtime", "serve")).toMatchObject({ result: "repaired" });
    expect(calls).toContain("launch serve");
    expect(calls).not.toContain("open");
  });

  it("says a started runtime that never answered is a failed repair", () => {
    const root = scratch("serve-slow");
    const { ctx } = fake(root, { status: () => ok({ runtime: { state: "starting", reachable: false } }) });
    expect(repair(ctx, "runtime", "serve")).toMatchObject({ result: "failed" });
  });

  it("refuses a repair the check does not offer now", () => {
    const root = scratch("not-offered");
    adapterRecord(root, { terminal: "term_loop" });
    const { ctx, calls } = fake(root, { status: () => ready, "orchestration run-current": () => ok({ run: { id: "run_fake" } }) });
    expect(repair(ctx, "runtime", "serve")).toMatchObject({ result: "not-repairable" });
    expect(repair(ctx, "consumer", "rebind")).toMatchObject({ result: "not-repairable" });
    expect(calls.filter((line) => line.startsWith("launch") || line.includes("run-use"))).toEqual([]);
  });
});

/* --------------------------------------------------------------------------
 * End to end: host, plugin, a fake Orca on disk, and the core's poll.
 * ----------------------------------------------------------------------- */

const FAKE_ORCA = `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.FAKE_ORCA_DIR;
const argv = process.argv.slice(2);
appendFileSync(join(dir, "calls"), argv.join(" ") + "\\n");
const args = argv.filter((arg) => arg !== "--json");
const opt = (name) => { const i = args.indexOf("--" + name); return i < 0 ? undefined : args[i + 1]; };
const read = (name, fallback) => { try { return JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { return fallback; } };
const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
const out = (result) => console.log(JSON.stringify({ ok: true, result }));
const verb = args[0] === "orchestration" || args[0] === "terminal" ? args[0] + " " + args[1] : args[0];
const bindings = read("bindings.json", {});
if (verb === "status") {
  out(existsSync(join(dir, "down")) ? { runtime: { state: "not-running", reachable: false } } : { runtime: { state: "ready", reachable: true } });
} else if (verb === "serve") {
  rmSync(join(dir, "down"), { force: true });
} else if (verb === "orchestration run-current") {
  out({ run: bindings[opt("from")] ?? null });
} else if (verb === "orchestration run-use") {
  bindings[opt("from")] = { id: opt("id"), objective: "" };
  write("bindings.json", bindings);
  out({ run: { id: opt("id") } });
} else if (verb === "orchestration run-create") {
  bindings[opt("from")] = { id: "run_new", objective: opt("objective") };
  write("bindings.json", bindings);
  out({ run: { id: "run_new" } });
} else if (verb === "terminal create") {
  out({ terminal: { handle: "term_new" } });
} else if (verb === "orchestration check") {
  if (argv.includes("--ack")) { write("mailbox.json", { messages: [] }); out({ messages: [] }); }
  else out(read("mailbox.json", { messages: [] }));
} else if (verb === "orchestration gate-list") {
  out({ gates: [] });
} else {
  out({});
}
`;

const CONFIG = {
  repo: "your-org/your-repo",
  owner: "your-github-login",
  baseBranch: "main",
  displayName: "Your Project",
  secrets: { runner: "none", withhold: [] },
  refuseFiles: [],
  envCheck: [],
  requiredChecks: [],
  gates: {},
  promptFragment: ".ralph/prompt.md",
  coderFragment: ".ralph/coder.md",
  plan: ".ralph/plan.md",
  journal: { dir: "journal/your-project" },
  loops: ["ralph"],
};

interface World {
  root: string;
  orca: string;
  calls: () => string[];
  queue: (messages: Record<string, unknown>[]) => void;
  poll: () => SpawnSyncReturns<string>;
  doctor: (args?: string[], env?: Record<string, string>) => DoctorOutput;
  config: () => Record<string, unknown>;
}

function world(label: string, plugins: string[] = ["orca"]): World {
  const root = scratch(label);
  const fakeDir = join(root, "fake-orca");
  mkdirSync(fakeDir);
  mkdirSync(join(root, "gitcommon"));
  const orca = join(fakeDir, "orca.mjs");
  writeFileSync(orca, `#!${BUN}\n${FAKE_ORCA}`);
  chmodSync(orca, 0o755);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
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
  chmodSync(join(bin, "git"), 0o755);
  writeFileSync(join(root, ".ralph", "config.json"), JSON.stringify({ ...CONFIG, ...(plugins.length > 0 ? { plugins } : {}) }, null, 2));
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
    }),
  );

  // The loop's environment and the page's: neither was started from an Orca
  // terminal, and this suite may itself be running in one.
  const base = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RALPH_STATE_ROOT: root,
      RALPH_ORCA_CLI: orca,
      FAKE_ORCA_DIR: fakeDir,
      RALPH_LOOP_NAME: "ralph",
      RALPH_ORCA_START_TIMEOUT_MS: "10000",
    };
    delete env.ORCA_TERMINAL_HANDLE;
    delete env.RALPH_PLUGINS;
    delete env.RALPH_RUN_ID;
    return env;
  };

  return {
    root,
    orca,
    calls: () =>
      existsSync(join(fakeDir, "calls"))
        ? readFileSync(join(fakeDir, "calls"), "utf8").split("\n").filter((line) => line !== "")
        : [],
    queue: (messages) => writeFileSync(join(fakeDir, "mailbox.json"), JSON.stringify({ messages, deliveryId: "delivery-1" })),
    poll: () =>
      spawnSync(BUN, [join(REPO_ROOT, "controls.ts"), "poll"], {
        encoding: "utf8",
        cwd: root,
        env: { ...base(), RALPH_PLUGINS: "orca", RALPH_RUN_ID: "ralph-run-1" },
      }),
    doctor: (args = [], env = {}) => {
      const ran = spawnSync(BUN, [join(REPO_ROOT, "plugin-doctor.ts"), ...args], {
        encoding: "utf8",
        cwd: root,
        env: { ...base(), ...env },
      });
      expect(ran.status, ran.stderr).toBe(0);
      return JSON.parse(ran.stdout) as DoctorOutput;
    },
    config: () => JSON.parse(readFileSync(join(root, ".ralph", "config.json"), "utf8")),
  };
}

const pauseFromOrca = {
  id: "msg_pause",
  from_handle: "term_operator",
  sequence: 1,
  type: "status",
  payload: JSON.stringify({ control: { command: "pause", why: "sent from the Orca board" } }),
};

const statuses = (output: DoctorOutput): Record<string, string> =>
  Object.fromEntries((output.plugins[0]?.report?.checks ?? []).map((check) => [check.id, check.status]));

describe("the original failure, reproduced and repaired", () => {
  it("finds the unbound consumer, binds one, and a command sent from Orca then reaches the loop", () => {
    const w = world("incident");
    adapterRecord(w.root, { terminal: null });
    w.queue([pauseFromOrca]);

    // The incident: Orca is healthy, the Run is registered, and the command
    // never arrives — the route degrades and the loop keeps working.
    const before = w.poll();
    expect(before.status, before.stderr).toBe(0);
    const mailbox = JSON.parse(readFileSync(join(w.root, MAILBOX_STATE_RELATIVE_PATH), "utf8"));
    expect(mailbox.degraded.why).toBe("no safe Orca consumer is available");

    const diagnosed = w.doctor();
    expect(diagnosed.enabled).toEqual(["orca"]);
    expect(statuses(diagnosed)).toEqual({ cli: "pass", runtime: "pass", run: "pass", consumer: "fail", backoff: "skipped" });

    const fixed = w.doctor(["--plugin", "orca", "--fix-all"]);
    expect(fixed.stopped).toBeNull();
    expect(fixed.steps.map((step) => [step.check, step.action, step.result])).toEqual([
      ["consumer", "bind-new", "repaired"],
      ["backoff", "retry-now", "repaired"],
    ]);
    expect(statuses(fixed)).toEqual({ cli: "pass", runtime: "pass", run: "pass", consumer: "pass", backoff: "pass" });
    expect(readOrcaConsumerBinding(w.root)?.consumer).toBe("term_new");

    // The command is in the loop's inbox now, and the loop's own poll — with
    // no Orca terminal in its environment — applies it.
    const after = w.poll();
    expect(after.status, after.stderr).toBe(10);
    const control = parseControlState(readFileSync(join(w.root, CONTROL_STATE_RELATIVE_PATH), "utf8"));
    expect(control?.hold).toMatchObject({ kind: "pause", why: "sent from the Orca board" });
    expect(w.calls()).toContain("terminal create --worktree path:" + w.root + " --title ralph Orca mailbox --json");
  });

  it("records every diagnosis and every step, and hands them back as history", () => {
    const w = world("history");
    adapterRecord(w.root, { terminal: null });
    w.doctor();
    const fixed = w.doctor(["--plugin", "orca", "--fix-all"]);
    const recorded = parseDoctorRecord(readFileSync(join(w.root, DOCTOR_RECORD_RELATIVE_PATH), "utf8"));
    expect(recorded.map((entry) => [entry.kind, entry.check, entry.action, entry.result])).toEqual([
      ["diagnosis", null, null, "failing"],
      ["repair", "consumer", "bind-new", "repaired"],
      ["diagnosis", null, null, "healthy"],
      ["fix-all", null, null, "healthy"],
    ]);
    expect(recorded.every((entry) => entry.plugin === "orca" && entry.run === "ralph-run-1")).toBe(true);
    expect(fixed.history).toEqual(recorded);
  });
});

describe("Fix all", () => {
  it("stops at a loop with no run, rather than calling it healthy", () => {
    const w = world("no-run");
    rmSync(join(w.root, STATE_RELATIVE_PATH));
    const fixed = w.doctor(["--plugin", "orca", "--fix-all"]);
    expect(statuses(fixed)).toMatchObject({ cli: "pass", runtime: "pass", run: "fail", consumer: "skipped" });
    expect(fixed.steps).toEqual([]);
    expect(fixed.stopped).toMatch(/^Run registered failed: The loop has no run on record .* no repair applies automatically$/);
  });

  it("does not record a re-check that found nothing new", () => {
    const w = world("recheck");
    adapterRecord(w.root, { terminal: null });
    w.doctor();
    w.doctor();
    w.doctor();
    const recorded = parseDoctorRecord(readFileSync(join(w.root, DOCTOR_RECORD_RELATIVE_PATH), "utf8"));
    expect(recorded.map((entry) => entry.kind)).toEqual(["diagnosis"]);
  });

  it("starts a down runtime with orca serve and carries on down the checks", () => {
    const w = world("runtime-down");
    adapterRecord(w.root, { terminal: null });
    writeFileSync(join(w.root, "fake-orca", "down"), "");
    const diagnosed = w.doctor();
    const runtime = diagnosed.plugins[0]?.report?.checks.find((check) => check.id === "runtime");
    expect(runtime?.repairs.map((row) => [row.id, row.default])).toEqual([
      ["serve", true],
      ["open", false],
    ]);
    const fixed = w.doctor(["--plugin", "orca", "--fix-all"]);
    expect(fixed.steps.map((step) => [step.check, step.action, step.result])).toEqual([
      ["runtime", "serve", "repaired"],
      ["consumer", "bind-new", "repaired"],
    ]);
    expect(w.calls()).toContain("serve");
    expect(w.calls()).not.toContain("open --json");
  });

  it("stops at the first check nothing can repair, and says why", () => {
    const w = world("no-cli");
    const fixed = w.doctor(["--plugin", "orca", "--fix-all"], { RALPH_ORCA_CLI: join(w.root, "no-such-orca") });
    expect(fixed.steps).toEqual([]);
    expect(fixed.stopped).toMatch(/^Orca CLI present failed: No Orca CLI on PATH.* no repair applies automatically; offered: Disable the Orca plugin for this project$/);
    expect(statuses(fixed).cli).toBe("fail");
  });
});

describe("the host's side of a repair", () => {
  it("turns the plugin off for the project, after which there is no panel and no plugin run", () => {
    const w = world("disable");
    const env = { RALPH_ORCA_CLI: join(w.root, "no-such-orca") };
    const disabled = w.doctor(["--plugin", "orca", "--repair", "cli:disable-plugin"], env);
    expect(disabled.steps[0]).toMatchObject({ check: "cli", action: "disable-plugin", result: "repaired" });
    expect(w.config().plugins).toBeUndefined();
    expect(w.config().repo).toBe("your-org/your-repo");

    const after = w.doctor([], env);
    expect(after.enabled).toEqual([]);
    expect(after.plugins).toEqual([]);
  });

  it("refuses a repair the plugin does not offer, without asking the plugin to try it", () => {
    const w = world("refuse");
    adapterRecord(w.root, { terminal: null });
    const refusedRepair = w.doctor(["--plugin", "orca", "--repair", "runtime:serve"]);
    expect(refusedRepair.steps[0]).toMatchObject({ check: "runtime", action: "serve", result: "not-repairable" });
    expect(w.calls()).not.toContain("serve");
    const disable = w.doctor(["--plugin", "orca", "--repair", "consumer:disable-plugin"]);
    expect(disable.steps[0]?.result).toBe("not-repairable");
    expect(w.config().plugins).toEqual(["orca"]);
  });

  it("makes no plugin subprocess at all when the plugin is off", () => {
    const w = world("off", []);
    const output = w.doctor();
    expect(output).toMatchObject({ enabled: [], plugins: [], steps: [], history: [] });
    expect(w.calls()).toEqual([]);
  });

  it("never touches the loop's own records, and can hold nothing", () => {
    const w = world("hands-off");
    adapterRecord(w.root, { terminal: null });
    w.poll();
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        [STATE_RELATIVE_PATH, CONTROL_STATE_RELATIVE_PATH].map((path) => [path, readFileSync(join(w.root, path), "utf8")]),
      );
    const before = snapshot();
    w.doctor(["--plugin", "orca", "--fix-all"]);
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(w.root, ".ralph", "logs", "supervisor.lock"))).toBe(false);
    // An empty mailbox leaves the inbox empty: the doctor itself wrote no command.
    const inbox = join(w.root, ".ralph", "control", "inbox");
    expect(existsSync(inbox) ? readdirSync(inbox).filter((name) => !name.startsWith(".")) : []).toEqual([]);
    expect(existsSync(join(w.root, ORCA_BINDING_RELATIVE_PATH))).toBe(true);
  });
});
