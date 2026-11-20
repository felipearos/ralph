// @vitest-environment node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAllowedPushCommand,
  MAX_GITHUB_COMMENTS_PER_TICKET,
  NOTIFICATION_KINDS,
  pushInputsForRecord,
  type PushState,
  usageCli,
} from "./push-notification";
import { buildObservation } from "./runner-failure";
import { subprocessSuite } from "./test-timeouts";

subprocessSuite("runs the push-notification CLI under bun with flock");

const ROOT = import.meta.dirname;
const BUN = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf8" }).trim();
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) spawnSync("rm", ["-rf", dir]);
});

/**
 * A project worktree (`root`) and a copy of the harness (`root/home`), so a
 * test that removes the harness's pattern file removes the one this CLI reads
 * — not the real checkout's, which would leave the withheld path untested.
 */
function fixture(name: string) {
  const root = join(tmpdir(), `ralph-push-${name}-${process.pid}-${Date.now()}`);
  const bin = join(root, "bin");
  const logs = join(root, ".ralph", "logs");
  const home = join(root, "home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(logs, { recursive: true });
  cpSync(ROOT, home, {
    recursive: true,
    filter: (source) => !/\/(node_modules|\.git|journal|logs|\.ralph|fixtures|examples|dashboard)(\/|$)/.test(source.slice(ROOT.length)),
  });
  scratch.push(root);

  writeFileSync(
    join(logs, "orca-lifecycle.json"),
    JSON.stringify({ version: 1, ralphRun: "ralph-run-1", loop: "ralph", orcaRun: "run_1" }),
  );
  writeFileSync(
    join(root, "leases.json"),
    JSON.stringify({
      version: 1,
      leases: {
        "722": {
          version: 1,
          issue: 722,
          run: "ralph-run-1",
          loop: "ralph",
          expiresAt: "2126-01-01T00:00:00.000Z",
          claimedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );

  const calls = join(root, "calls.jsonl");
  for (const command of ["orca", "gh"]) {
    const path = join(bin, command);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> ${JSON.stringify(calls)}\nprintf '{"ok":true,"result":{}}\\n'\n`,
    );
    chmodSync(path, 0o755);
  }
  const usage = join(root, "usage.py");
  writeFileSync(usage, "#!/bin/sh\nprintf '<details>usage footer</details>\\n'\n");
  chmodSync(usage, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    RALPH_STATE_ROOT: root,
    RALPH_RUN_ID: "ralph-run-1",
    RALPH_LOOP_NAME: "ralph",
    RALPH_CLAIM_LEASE_PATH: join(root, "leases.json"),
    RALPH_USAGE_CLI: usage,
    RALPH_ORCA_CLI: join(bin, "orca"),
    // The Orca plugin on, so an alert has somewhere to go besides the ticket.
    RALPH_PLUGINS: "orca",
    TEST_SECRET_TOKEN: "secret-value-12345",
  };
  return {
    root,
    usage,
    gh: join(bin, "gh"),
    run: (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(BUN, [join(home, "push-notification.ts"), "push", ...args], {
        // `cwd` as well as `RALPH_STATE_ROOT`: the state root is what the CLI
        // prefers, but its fallback is the cwd's git toplevel, which inherited
        // from the runner is this checkout (#199).
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...extra },
      }),
    observation: (stage: string, extra: Record<string, string> = {}) =>
      spawnSync(BUN, [join(home, "push-notification.ts"), "observation", "--stage", stage], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...extra },
      }),
    start: (args: string[], extra: Record<string, string> = {}) =>
      spawn(BUN, [join(home, "push-notification.ts"), "push", ...args], {
        cwd: root,
        stdio: "ignore",
        env: { ...env, ...extra },
      }),
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    state: () =>
      JSON.parse(readFileSync(join(logs, "push-notifications.json"), "utf8")) as PushState,
    feed: () =>
      existsSync(join(logs, "notifications.jsonl"))
        ? readFileSync(join(logs, "notifications.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
  };
}

describe("problem and terminal-state pushes", () => {
  it("mechanically refuses external actions outside footer generation and issue comments", () => {
    expect(() => assertAllowedPushCommand("github", ["pr", "create"])).toThrow(/refusing/);
    expect(() => assertAllowedPushCommand("usage", ["--step", "x", "--json"])).toThrow(/refusing/);
    expect(() =>
      assertAllowedPushCommand("github", ["issue", "comment", "722", "--body", "safe"]),
    ).not.toThrow();
    expect(() => assertAllowedPushCommand("lock", ["--bad"])).toThrow(/refusing/);
    expect(() =>
      assertAllowedPushCommand("lock", [
        "-x", "-w", "1", join(ROOT, ".ralph", "logs", "push-notifications.json.lock"),
        process.execPath, join(ROOT, "push-notification.ts"), "claim",
        "--kind", "gate-failure", "--occurrence", "gate:1",
      ]),
    ).not.toThrow();
  });

  it("maps supervisor failures and endings without turning milestones into pushes", () => {
    expect(pushInputsForRecord(["--event", "iteration-start", "--iteration", "2"], 722)).toEqual([]);
    expect(
      pushInputsForRecord(
        ["--event", "no-sigil", "--iteration", "2", "--stop", "failed", "--why", "no final sigil"],
        722,
      ).map((input) => input.kind),
    ).toEqual(["no-sigil", "run-finished"]);
    expect(
      pushInputsForRecord(["--event", "stop", "--stop", "blocked", "--why", "needs a human"], 722)
        .map((input) => input.kind),
    ).toEqual(["ticket-blocked", "run-finished"]);
    expect(
      pushInputsForRecord(
        ["--event", "cap-reached", "--stop", "completed", "--why", "iteration cap reached"],
        722,
      ).map((input) => input.kind),
    ).toEqual(["ticket-blocked", "run-finished"]);
    // A spent backoff is the run ending on a blocker nobody cleared overnight.
    expect(
      pushInputsForRecord(
        ["--event", "backoff-exhausted", "--stop", "blocked", "--why", "backed off for 21600s"],
        722,
      ).map((input) => input.kind),
    ).toEqual(["ticket-blocked", "run-finished"]);
    // Every other loop on a spent shared episode (#431): its run ends, but the
    // blocked push was the one loop that claimed the escalation.
    expect(
      pushInputsForRecord(
        ["--event", "backoff-exhausted-shared", "--stop", "blocked", "--why", "already escalated on this host"],
        722,
      ).map((input) => input.kind),
    ).toEqual(["run-finished"]);
  });

  it("maps the secrets-env and usage-limit-stop endings (#418)", () => {
    // The development environment check failed after the preflight passed:
    // a gate failure, like a denied preflight.
    expect(
      pushInputsForRecord(
        ["--event", "secrets-env", "--iteration", "3", "--stop", "failed", "--why", "development env check failed"],
        722,
      ).map((input) => input.kind),
    ).toEqual(["gate-failure", "run-finished"]);
    // A usage limit whose wait could not be armed is a rate limit, not a lost sigil.
    const limit = pushInputsForRecord(
      ["--event", "usage-limit-stop", "--iteration", "5", "--stop", "failed", "--why", "five_hour limit"],
      722,
    );
    expect(limit.map((input) => input.kind)).toEqual(["rate-limit", "run-finished"]);
    expect(limit[0]).toMatchObject({ priority: "high", subject: "Iteration 5 stopped on a usage limit", iteration: 5 });
    expect(NOTIFICATION_KINDS).toContain("preflight-stalled");
    expect(NOTIFICATION_KINDS).toContain("migration-applied-stalled");
    expect(NOTIFICATION_KINDS).toContain("gate-hold-exhausted");
  });

  it("pushes one occurrence once to Orca and the held ticket, through shared redaction", () => {
    const f = fixture("once");
    const args = [
      "--kind", "permission-denial",
      "--occurrence", "executor:1:permission-denied",
      "--subject", "Executor permission denied",
      "--body", "tool failed with secret-value-12345",
      "--priority", "high",
      "--ticket", "722",
    ];

    expect(f.run(args).status).toBe(0);
    expect(f.run(args).status).toBe(0);

    const calls = f.calls();
    expect(calls.filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(1);
    expect(calls.join("\n")).not.toContain("secret-value-12345");
    expect(calls.join("\n")).toContain("[redacted:env:TEST_SECRET_TOKEN]");
    expect(calls.join("\n")).toContain("<details>usage footer</details>");
    expect(f.state().occurrences).toHaveProperty("ralph-run-1:executor:1:permission-denied");
  });

  it("pages nobody for a stage that exited cleanly, and pages a kill as a timeout", () => {
    // 2026-09-23: three "Runner credential failed" pages, every one from text
    // in a command's output — two of them on runs that exited 0, one on a run
    // the watchdog had killed at 900s. Driven through the CLI `delegate.sh`
    // calls, with rows the real classifier built.
    const f = fixture("observation");
    const home = join(f.root, "home");
    const signals = ".ralph/logs/signals-executor-overnight.jsonl";
    writeFileSync(
      join(f.root, signals),
      `${JSON.stringify({ at: "2026-09-23T08:17:50Z", kind: "authentication", evidence: "bash exited 1: never retry an unauthorized request", source: "tool" })}\n`,
    );
    const row = (exitCode: number, note: string | null) =>
      buildObservation(
        { stage: "executor", runner: "codex", exitCode, note, signalsPath: signals },
        { RALPH_LOOP_NAME: "ralph", RALPH_RUN_ID: "ralph-run-1", RALPH_SESSION_ID: "s-1" },
        { root: f.root, home, leasePath: join(f.root, "absent.json") },
      );
    const ledger = join(f.root, ".ralph", "logs", "runner-failures.jsonl");
    const extra = { RALPH_SESSION_ID: "s-1" };

    const clean = row(0, null);
    expect(clean.kind).toBe("none");
    writeFileSync(ledger, `${JSON.stringify(clean)}\n`);
    expect(f.observation("executor", extra).status).toBe(0);
    expect(f.calls()).toEqual([]);

    const killed = row(124, "the executor was killed at its 900s timeout");
    expect(killed.kind).toBe("timeout");
    writeFileSync(ledger, `${JSON.stringify(killed)}\n`);
    expect(f.observation("executor", extra).status).toBe(0);
    const orca = f.calls().filter((line) => line.startsWith("orca "));
    expect(orca).toHaveLength(1);
    expect(orca.join("\n")).not.toContain("credential");
    expect(f.feed().filter((entry) => entry.event === "raised").map((entry) => entry.kind)).toEqual([
      "stage-timeout",
    ]);
  });

  it("serializes concurrent replays before claiming an occurrence", async () => {
    const f = fixture("concurrent");
    const lock = join(f.root, ".ralph", "logs", "push-notifications.json.lock");
    const holder = spawn("flock", [lock, "sleep", "0.3"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const args = [
      "--kind", "permission-denial",
      "--occurrence", "executor:concurrent:permission-denied",
      "--subject", "Executor permission denied",
      "--body", "tool was denied",
      "--ticket", "722",
    ];
    const children = [f.start(args), f.start(args)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.calls()).toEqual([]);
    await new Promise<void>((resolve) => holder.on("close", () => resolve()));
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on("close", () => resolve());
          }),
      ),
    );

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(f.calls().filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(1);
  });

  it("does not hold the state lock while generating a usage footer", async () => {
    const f = fixture("slow-footer");
    const footerStarted = join(f.root, "footer-started");
    writeFileSync(
      f.usage,
      `#!/bin/sh\ntouch ${JSON.stringify(footerStarted)}\nsleep 2\nprintf '<details>usage footer</details>\\n'\n`,
    );
    const args = (occurrence: string) => [
      "--kind", "gate-failure",
      "--occurrence", occurrence,
      "--subject", "Gate failed",
      "--body", "the check failed",
      "--ticket", "722",
    ];

    const first = f.start(args("gate:slow-footer:first"), { RALPH_PUSH_TIMEOUT_MS: "500" });
    while (!existsSync(footerStarted)) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = f.start(args("gate:slow-footer:second"), { RALPH_PUSH_TIMEOUT_MS: "50" });
    await Promise.all(
      [first, second].map(
        (child) =>
          new Promise<void>((resolve) => {
            child.on("close", () => resolve());
          }),
      ),
    );

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(2);
    expect(Object.keys(f.state().occurrences)).toHaveLength(2);
  });

  it("recovers a state lock whose owning process has exited", () => {
    const f = fixture("dead-lock");
    const lock = join(f.root, ".ralph", "logs", "push-notifications.json.lock");
    writeFileSync(lock, "left behind by a dead process");

    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:after-dead-lock",
        "--subject", "Gate failed",
        "--body", "the check failed",
        "--ticket", "722",
      ]).status,
    ).toBe(0);
    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
  });

  it("never breaks a state lock whose owner is alive", async () => {
    const f = fixture("live-lock");
    const lock = join(f.root, ".ralph", "logs", "push-notifications.json.lock");
    // Held until the test is done and waited for until it is held: a fixed
    // 30 ms head start and a 0.3 s hold both lose to a loaded host, which let
    // the CLI take a lock nobody held yet, or one already released.
    const holder = spawn("flock", [lock, "sleep", "60"], { stdio: "ignore", detached: true });
    const closed = new Promise<void>((resolve) => holder.on("close", () => resolve()));
    try {
      const deadline = Date.now() + 10_000;
      while (spawnSync("flock", ["-n", lock, "true"]).status === 0) {
        if (Date.now() > deadline) throw new Error("the holder never took the lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(
        f.run(
          [
            "--kind", "gate-failure",
            "--occurrence", "gate:while-live-lock",
            "--subject", "Gate failed",
            "--body", "the check failed",
            "--ticket", "722",
          ],
          { RALPH_PUSH_TIMEOUT_MS: "20" },
        ).status,
      ).toBe(0);
      expect(f.calls()).toEqual([]);
    } finally {
      // The whole group, so the `sleep` holding the lock goes with its `flock`.
      process.kill(-holder.pid!, "SIGKILL");
      await closed;
    }
  });

  it("serializes concurrent distinct claims without losing state or comment caps", async () => {
    const f = fixture("many-concurrent");
    const children = Array.from({ length: 8 }, (_, index) =>
      f.start([
        "--kind", "gate-failure",
        "--occurrence", `gate:concurrent:${index}`,
        "--subject", "Gate failed",
        "--body", `failure ${index}`,
        "--ticket", "722",
      ]),
    );
    await Promise.all(
      children.map(
        (child) => new Promise<void>((resolve) => child.on("close", () => resolve())),
      ),
    );

    expect(Object.keys(f.state().occurrences)).toHaveLength(8);
    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(8);
    expect(f.calls().filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(5);
  });

  it("never comments without a live claim for the ticket", () => {
    const f = fixture("unheld");
    const run = f.run([
      "--kind", "run-finished",
      "--occurrence", "run-finished",
      "--subject", "Run finished",
      "--body", "No ticket was claimed",
      "--ticket", "999",
    ]);

    expect(run.status).toBe(0);
    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(f.calls().some((line) => line.startsWith("gh "))).toBe(false);
  });

  it("does not post a ticket comment when it cannot produce the required footer", () => {
    const f = fixture("footer-failure");
    writeFileSync(f.usage, "#!/bin/sh\nexit 1\n");

    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:footer-failure",
        "--subject", "Gate failed",
        "--body", "the check failed",
        "--ticket", "722",
      ]).status,
    ).toBe(0);

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(f.calls().some((line) => line.startsWith("gh "))).toBe(false);
  });

  it("counts successful comments rather than failed delivery reservations", () => {
    const f = fixture("failed-reservations");
    writeFileSync(f.usage, "#!/bin/sh\nexit 1\n");
    for (let index = 0; index < MAX_GITHUB_COMMENTS_PER_TICKET; index++) {
      expect(
        f.run([
          "--kind", "gate-failure",
          "--occurrence", `gate:footer-failure:${index}`,
          "--subject", "Gate failed",
          "--body", "the check failed",
          "--ticket", "722",
        ]).status,
      ).toBe(0);
    }
    expect(f.calls().some((line) => line.startsWith("gh "))).toBe(false);

    writeFileSync(f.usage, "#!/bin/sh\nprintf '<details>usage footer</details>\\n'\n");
    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:footer-recovered",
        "--subject", "Gate failed",
        "--body", "the check recovered",
        "--ticket", "722",
      ]).status,
    ).toBe(0);

    expect(f.calls().filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(1);
    expect(f.state().ticketComments["ralph-run-1:722"]).toBe(1);
  });

  it("releases a reservation when GitHub rejects the comment", () => {
    const f = fixture("github-rejected");
    writeFileSync(f.gh, "#!/bin/sh\nexit 1\n");
    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:github-rejected",
        "--subject", "Gate failed",
        "--body", "the check failed",
        "--ticket", "722",
      ]).status,
    ).toBe(0);
    expect(f.state().ticketComments["ralph-run-1:722"] ?? 0).toBe(0);

    writeFileSync(
      f.gh,
      `#!/bin/sh\nprintf '%s\\n' "gh $*" >> ${JSON.stringify(join(f.root, "calls.jsonl"))}\nprintf '{"ok":true,"result":{}}\\n'\n`,
    );
    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:github-recovered",
        "--subject", "Gate failed",
        "--body", "the check recovered",
        "--ticket", "722",
      ]).status,
    ).toBe(0);
    expect(f.state().ticketComments["ralph-run-1:722"]).toBe(1);
  });

  it("rechecks the live claim after footer generation before commenting", () => {
    const f = fixture("lease-expired-during-footer");
    writeFileSync(
      f.usage,
      `#!/bin/sh\nprintf '{"version":1,"leases":{}}' > ${JSON.stringify(join(f.root, "leases.json"))}\nprintf '<details>usage footer</details>\\n'\n`,
    );

    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:lease-expired",
        "--subject", "Gate failed",
        "--body", "the check failed",
        "--ticket", "722",
      ]).status,
    ).toBe(0);

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(f.calls().some((line) => line.startsWith("gh "))).toBe(false);
  });

  it("withholds caller text when the shared redaction rules are unavailable", () => {
    const f = fixture("missing-redaction");
    unlinkSync(join(f.root, "home", "runner-signals.json"));

    expect(
      f.run([
        "--kind", "gate-failure",
        "--occurrence", "gate:missing-redaction",
        "--subject", "Secret subject secret-value-12345",
        "--body", "Secret body secret-value-12345",
        "--ticket", "722",
      ]).status,
    ).toBe(0);

    const calls = f.calls();
    expect(calls.filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(1);
    expect(calls.join("\n")).not.toContain("secret-value-12345");
    expect(calls.join("\n")).toContain("Details withheld");
  });

  it("bounds notification comments on one ticket without dropping Orca occurrences", () => {
    const f = fixture("bound");
    for (let index = 0; index < MAX_GITHUB_COMMENTS_PER_TICKET + 2; index++) {
      expect(
        f.run([
          "--kind", "gate-failure",
          "--occurrence", `gate:${index}`,
          "--subject", "Gate failed",
          "--body", `failure ${index}`,
          "--ticket", "722",
        ]).status,
      ).toBe(0);
    }

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(
      MAX_GITHUB_COMMENTS_PER_TICKET + 2,
    );
    expect(f.calls().filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(
      MAX_GITHUB_COMMENTS_PER_TICKET,
    );

    writeFileSync(
      join(f.root, ".ralph", "logs", "orca-lifecycle.json"),
      JSON.stringify({ version: 1, ralphRun: "ralph-run-2", loop: "ralph", orcaRun: "run_2" }),
    );
    writeFileSync(
      join(f.root, "leases.json"),
      JSON.stringify({
        version: 1,
        leases: {
          "722": {
            version: 1,
            issue: 722,
            run: "ralph-run-2",
            loop: "ralph",
            expiresAt: "2126-01-01T00:00:00.000Z",
            claimedAt: "2026-01-02T00:00:00.000Z",
          },
        },
      }),
    );
    expect(
      f.run(
        [
          "--kind", "gate-failure",
          "--occurrence", "gate:new-run",
          "--subject", "Gate failed again",
          "--body", "new run failure",
          "--ticket", "722",
        ],
        { RALPH_RUN_ID: "ralph-run-2" },
      ).status,
    ).toBe(0);
    expect(f.calls().filter((line) => line.startsWith("gh issue comment 722"))).toHaveLength(
      MAX_GITHUB_COMMENTS_PER_TICKET + 1,
    );
  });

  it.each([
    ["missing", "/definitely/missing/orca"],
    ["erroring", join(tmpdir(), `erroring-orca-${process.pid}`)],
    ["hanging", join(tmpdir(), `hanging-orca-${process.pid}`)],
  ])("survives an Orca binary that is %s", (_name, cli) => {
    const f = fixture(`failure-${_name}`);
    if (_name !== "missing") {
      writeFileSync(cli, _name === "erroring" ? "#!/bin/sh\nexit 9\n" : "#!/bin/sh\nsleep 5\n");
      chmodSync(cli, 0o755);
      scratch.push(cli);
    }
    const run = f.run(
      ["--kind", "stage-timeout", "--occurrence", `timeout:${_name}`, "--subject", "Stage timeout", "--body", "timed out"],
      { RALPH_ORCA_CLI: cli, RALPH_PUSH_TIMEOUT_MS: "20" },
    );
    expect(run.status).toBe(0);
  });
});

describe("the local notification feed", () => {
  const alert = (occurrence: string) => [
    "--kind", "permission-denial",
    "--occurrence", occurrence,
    "--subject", "Executor permission denied",
    "--body", "tool failed with secret-value-12345",
    "--priority", "high",
    "--ticket", "722",
  ];

  it("writes every alert once, redacted, with its kind, ticket, iteration and time, and how each channel took it", () => {
    const f = fixture("feed");
    expect(f.run(alert("executor:1:denied"), { RALPH_ITERATION: "3" }).status).toBe(0);
    expect(f.run(alert("executor:1:denied"), { RALPH_ITERATION: "3" }).status).toBe(0);

    const feed = f.feed();
    const raised = feed.filter((line) => line.event === "raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      version: 1,
      id: "ralph-run-1:executor:1:denied",
      run: "ralph-run-1",
      loop: "ralph",
      kind: "permission-denial",
      subject: "Executor permission denied",
      priority: "high",
      ticket: 722,
      iteration: 3,
      plugins: ["orca"],
      github: "eligible",
    });
    expect(Date.parse(String(raised[0]!.at))).not.toBeNaN();
    expect(JSON.stringify(feed)).not.toContain("secret-value-12345");
    expect(String(raised[0]!.body)).toContain("[redacted:env:TEST_SECRET_TOKEN]");

    const deliveries = feed.filter((line) => line.event === "delivery");
    expect(deliveries).toEqual([
      expect.objectContaining({ id: "ralph-run-1:executor:1:denied", channel: "plugin", name: "orca", ok: true, ran: true, why: null }),
      expect.objectContaining({ id: "ralph-run-1:executor:1:denied", channel: "github", name: "github", ok: true, outcome: "posted" }),
    ]);
  });

  it("records an alert no plugin could take as undelivered, with the plugin's reason", () => {
    const f = fixture("feed-undelivered");
    // No Orca Run on record for this run: the plugin answers that it had nowhere to send it.
    unlinkSync(join(f.root, ".ralph", "logs", "orca-lifecycle.json"));
    expect(f.run(alert("executor:2:denied")).status).toBe(0);

    const delivery = f.feed().find((line) => line.event === "delivery" && line.channel === "plugin");
    expect(delivery).toMatchObject({ name: "orca", ok: false, ran: true, why: "no Orca Run to send the alert to" });
    expect(f.feed().find((line) => line.event === "raised")).toMatchObject({ iteration: null });
  });

  it("writes the feed with no plugin enabled, and names none", () => {
    const f = fixture("feed-no-plugin");
    expect(f.run(alert("executor:3:denied"), { RALPH_PLUGINS: "" }).status).toBe(0);

    const feed = f.feed();
    expect(feed.find((line) => line.event === "raised")).toMatchObject({ plugins: [], kind: "permission-denial" });
    expect(feed.filter((line) => line.channel === "plugin")).toEqual([]);
    expect(f.calls().some((line) => line.startsWith("orca "))).toBe(false);
  });

  it("names an enabled plugin that is not installed as undelivered", () => {
    const f = fixture("feed-missing-plugin");
    expect(f.run(alert("executor:4:denied"), { RALPH_PLUGINS: "pager" }).status).toBe(0);

    const feed = f.feed();
    expect(feed.find((line) => line.event === "raised")).toMatchObject({ plugins: ["pager"] });
    expect(feed.find((line) => line.channel === "plugin")).toMatchObject({ name: "pager", ok: false, ran: false });
  });

  it("still writes the feed, and only the feed, with pushes switched off", () => {
    const f = fixture("feed-off");
    expect(f.run(alert("executor:5:denied"), { RALPH_PUSH_NOTIFICATIONS: "0" }).status).toBe(0);

    expect(f.feed()).toEqual([expect.objectContaining({ event: "raised", kind: "permission-denial", plugins: [], github: "absent", unsent: expect.stringContaining("switched off") })]);
    expect(f.calls()).toEqual([]);
  });

  it("still writes the feed when the notification record cannot be claimed, and sends nothing", () => {
    const f = fixture("feed-unclaimed");
    // No flock on PATH: the claim cannot run, so nobody may send, but the alert is not lost.
    const bin = join(f.root, "noflock");
    mkdirSync(bin);
    for (const tool of ["gh", "orca"]) cpSync(join(f.root, "bin", tool), join(bin, tool));
    expect(f.run(alert("executor:6:denied"), { PATH: `${bin}:${dirname(BUN)}:/usr/bin/env-only-missing` }).status).toBe(0);

    expect(f.feed()).toEqual([expect.objectContaining({ event: "raised", id: "ralph-run-1:executor:6:denied", plugins: [], unsent: expect.stringContaining("could not be locked") })]);
    expect(f.calls()).toEqual([]);
  });

  it("carries a supervisor event's iteration onto the alerts it raises", () => {
    expect(
      pushInputsForRecord(["--event", "no-sigil", "--iteration", "4", "--why", "no sigil"], 722).map((input) => input.iteration),
    ).toEqual([4, 4]);
    expect(pushInputsForRecord(["--event", "frontier-empty"], null).map((input) => input.iteration)).toEqual([null]);
  });

  describe("a reconciler retry (#420)", () => {
    const retried = (occurrence: string, retry: string[]) => [
      "--kind", "loop-retried",
      "--occurrence", occurrence,
      "--subject", "ralph (software-factory): retried",
      "--body", "cause: no-sigil",
      "--priority", "normal",
      ...retry,
    ];

    it("accepts loop-retried and loop-retry-capped", () => {
      expect(NOTIFICATION_KINDS).toContain("loop-retried");
      expect(NOTIFICATION_KINDS).toContain("loop-retry-capped");

      const f = fixture("feed-retry-kinds");
      expect(f.run(retried("loop-retried:software-factory:ralph:1", [])).status).toBe(0);
      expect(f.run([
        "--kind", "loop-retry-capped",
        "--occurrence", "loop-retry-capped:software-factory:ralph:1",
        "--subject", "ralph (software-factory): retries spent",
        "--body", "7 of 7",
        "--priority", "high",
      ]).status).toBe(0);

      expect(f.feed().filter((line) => line.event === "raised").map((line) => line.kind)).toEqual([
        "loop-retried",
        "loop-retry-capped",
      ]);
    });

    it("carries the attempt, the schedule's length and the cause onto the raised line, as numbers", () => {
      const f = fixture("feed-retry");
      expect(
        f.run(retried("loop-retried:software-factory:ralph:2", [
          "--retry-attempt", "2", "--retry-of", "7", "--retry-cause", "no-sigil",
        ])).status,
      ).toBe(0);

      expect(f.feed().find((line) => line.event === "raised")?.retry).toEqual({ attempt: 2, of: 7, cause: "no-sigil" });
    });

    it("writes no retry key without the flags, so existing lines keep their shape", () => {
      const f = fixture("feed-no-retry");
      expect(f.run(alert("executor:7:denied")).status).toBe(0);

      expect(f.feed().find((line) => line.event === "raised")).not.toHaveProperty("retry");
    });

    it("drops a partial or malformed retry, and still raises the alert", () => {
      const f = fixture("feed-bad-retry");
      const malformed = [
        ["--retry-attempt", "0", "--retry-of", "7", "--retry-cause", "no-sigil"],
        ["--retry-attempt", "8", "--retry-of", "7", "--retry-cause", "no-sigil"],
        ["--retry-attempt", "two", "--retry-of", "7", "--retry-cause", "no-sigil"],
        ["--retry-attempt", "1.5", "--retry-of", "7", "--retry-cause", "no-sigil"],
        ["--retry-attempt", "2", "--retry-of", "7"],
        ["--retry-attempt", "2", "--retry-of", "7", "--retry-cause", "  "],
        ["--retry-of", "7", "--retry-cause", "no-sigil"],
      ];
      malformed.forEach((retry, index) => {
        expect(f.run(retried(`loop-retried:software-factory:ralph:bad-${index}`, retry)).status).toBe(0);
      });

      const raised = f.feed().filter((line) => line.event === "raised");
      expect(raised).toHaveLength(malformed.length);
      for (const line of raised) expect(line).not.toHaveProperty("retry");
    });
  });
});

describe("usageCli", () => {
  it("defaults to the harness's own usage.py, which exists, not one inside the project", () => {
    const cli = usageCli({});
    expect(cli).toBe(join(ROOT, "usage.py"));
    expect(existsSync(cli)).toBe(true);
  });

  it("honours RALPH_USAGE_CLI", () => {
    expect(usageCli({ RALPH_USAGE_CLI: " /tmp/usage " })).toBe("/tmp/usage");
  });
});

describe("the roles' kinds (#138)", () => {
  it("accepts role-invariant and ci-incident", () => {
    expect(NOTIFICATION_KINDS).toContain("role-invariant");
    expect(NOTIFICATION_KINDS).toContain("ci-incident");

    const f = fixture("role-kinds");
    expect(
      f.run([
        "--kind", "role-invariant",
        "--occurrence", "role-invariant:triager:4",
        "--subject", "Triager left the worktree dirty",
        "--body", "the supervisor restored it",
        "--priority", "high",
        "--ticket", "722",
      ]).status,
    ).toBe(0);

    expect(f.state().occurrences).toHaveProperty("ralph-run-1:role-invariant:triager:4");
    expect(f.feed().filter((line) => line.kind === "role-invariant")).toHaveLength(1);
  });

  it("pages once for one incident, however many builds carry it", () => {
    const f = fixture("ci-incident");
    // The key the ci-doctor writes: the signature, and the build it began on.
    const args = (build: number) => [
      "--kind", "ci-incident",
      "--occurrence", `ci-incident:agent-lost:${build}`,
      "--subject", "CI infrastructure incident",
      "--body", "agents lost mid-job on 4 builds",
      "--priority", "high",
      "--ticket", "722",
    ];

    expect(f.run(args(36_657_498)).status).toBe(0);
    expect(f.run(args(36_657_498)).status).toBe(0);

    expect(f.calls().filter((line) => line.startsWith("orca "))).toHaveLength(1);
    expect(f.feed().filter((line) => line.event === "raised")).toHaveLength(1);
    // A second incident of the same shape, beginning on another build, is
    // another alert: the first build is in the key for exactly that reason.
    expect(f.run(args(36_661_179)).status).toBe(0);
    expect(f.feed().filter((line) => line.event === "raised")).toHaveLength(2);
  });

  it("records two restarts of one dead run, because the attempt is in the key (#346)", () => {
    // The dashboard's reconciler pushes an attempt, not a success, and a loop
    // that dies before writing a new `state.json` keeps the old run id. The
    // record dedupes on `<run>:<occurrence>`, so without the attempt's
    // timestamp in the occurrence the second restart would vanish — and the
    // bound, which counts these records, would never trip.
    expect(NOTIFICATION_KINDS).toContain("loop-restarted");
    expect(NOTIFICATION_KINDS).toContain("loop-restart-capped");

    const f = fixture("loop-restarted");
    const attempt = (at: string) => [
      "--kind", "loop-restarted",
      "--occurrence", `loop-restarted:software-factory:ralph:${at}`,
      "--subject", "ralph (software-factory): restart restarted",
      "--body", "reason: supervisor 4242 gone, no stopReason\noutcome: restarted (pid 5151)",
      "--priority", "normal",
    ];

    expect(f.run(attempt("2026-10-20T12:00:00.000Z")).status).toBe(0);
    expect(f.run(attempt("2026-10-20T12:01:00.000Z")).status).toBe(0);
    // The same key twice is one record, which is what makes the timestamp
    // load-bearing rather than decorative.
    expect(f.run(attempt("2026-10-20T12:01:00.000Z")).status).toBe(0);

    const raised = f.feed().filter((line) => line.kind === "loop-restarted" && line.event === "raised");
    expect(raised).toHaveLength(2);
    expect(raised[0]?.body).toContain("no stopReason");
  });

  it("raises nothing for a kind nobody declared", () => {
    const f = fixture("unknown-kind");

    // A push is best effort, so a typo exits 0 — and must reach nothing.
    expect(f.run([
      "--kind", "role-invariants",
      "--occurrence", "typo:1",
      "--subject", "s", "--body", "b", "--priority", "high", "--ticket", "722",
    ]).status).toBe(0);

    expect(f.feed()).toEqual([]);
    expect(f.calls()).toEqual([]);
  });
});
