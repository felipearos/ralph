// @vitest-environment node
/**
 * felipearos/ralph#155's acceptance criteria for `ci-doctor/unpark.ts`:
 *
 *  AC 1 — run twice on the same (ticket, diagnosis), GitHub writes happen only
 *         on the first run.
 *  AC 2 — killed after step 2, the pull request is still a draft and the rerun
 *         completes step 3 without a second comment.
 *  AC 3 — a third unpark of one ticket is refused, and so is a second unpark
 *         for the same diagnosis.
 *
 * (AC 4 is `block-reason.ts`'s `ci-flake` kind and is pinned in
 * `block-reason.test.ts`.)
 *
 * The store here is REAL — a temp directory and the real `withStore` — because
 * the thing worth testing is that two runs agree about one file under a lock.
 * `gh` is injected and records its calls, so "wrote nothing" is an assertion
 * over an array rather than an absence nobody checks.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// `provenance()` builds its regex from the project roster at call time, and
// `test-ralph-env.setup.ts` strips every inherited `RALPH_*`. Set before the
// module is imported, as `ci-doctor/gate-poll.test.ts` does.
process.env.RALPH_PROJECT = join(__dirname, "..", "fixtures", "loggd");

import { isRateLimited } from "../frontier/github-rate-limit";

import { parkedCase } from "./gate";
import { readStore, withStore, type Case, type CiHealthStore } from "./store";
import {
  MAX_UNPARKS_PER_TICKET,
  decide,
  declinedMarker,
  diagnosisToken,
  ownerOf,
  readParked,
  recordUnpark,
  runUnpark,
  unpark,
  unparkComment,
  unparkMarker,
  markerIndex,
  type CommandDeps,
  type Decision,
  type StoreIo,
} from "./unpark";
import type { Gh, Ran } from "./gate";

const TICKET = 1557;
const PR = 1681;
const FLAKE = "flake:src/queue/retry.test.ts > retries";
const OTHER = "flake:src/a.test.ts > flaps";
const THIRD = "flake:src/b.test.ts > drifts";
const AT = "2026-10-04T12:00:00.000Z";
const BODY = `🤖 Ralph loop — run \`ralph-run-1\` · iteration session \`s1\`\n\nCloses #${TICKET}`;
const EVIDENCE = "Builds 2001 and 2005 are red on this test on four other branches, main included.";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchStore(): StoreIo {
  const dir = mkdtempSync(join(tmpdir(), "unpark-"));
  dirs.push(dir);
  return { path: join(dir, "ci-health.json"), with: withStore };
}

/** Local, because the store deliberately exports no budget counter: the budget is GitHub's. */
const unparkCount = (value: Case | undefined): number =>
  value === undefined ? 0 : Object.values(value.unparks).reduce((total, times) => total + times.length, 0);

const ok = (stdout = ""): Ran => ({ ok: true, stdout, stderr: "" });
const json = (value: unknown): Ran => ok(JSON.stringify(value));

interface World {
  comments?: string[];
  labels?: string[];
  isDraft?: boolean;
  body?: string | null;
}

/** A `gh` that records every call and answers the two reads from one world. */
function fakeGh(world: World = {}): Gh & { calls: string[] } {
  const calls: string[] = [];
  const gh = (async (args: string[]): Promise<Ran> => {
    calls.push(args.join(" "));
    if (args[0] === "issue" && args[1] === "view") {
      return json({
        comments: (world.comments ?? []).map((body) => ({ body, createdAt: AT })),
        labels: (world.labels ?? []).map((name) => ({ name })),
      });
    }
    if (args[0] === "pr" && args[1] === "view") {
      return json({ isDraft: world.isDraft ?? true, body: world.body === undefined ? BODY : world.body });
    }
    return ok();
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}

const writes = (gh: { calls: string[] }): string[] =>
  gh.calls.filter((call) => !call.includes("--json"));

function deps(store: StoreIo, gh: Gh): CommandDeps & { lines: string[] } {
  const lines: string[] = [];
  return { io: { gh }, store, now: () => AT, out: (l) => lines.push(l), err: (l) => lines.push(l), lines };
}

const argv = (diagnosis = FLAKE): string[] => [
  String(TICKET),
  "--pr",
  String(PR),
  "--diagnosis",
  diagnosis,
  "--evidence",
  EVIDENCE,
];

/** The world after a completed unpark: marker commented, label gone, PR ready. */
const unparked = (diagnoses: string[] = [FLAKE]): World => ({
  comments: diagnoses.map((d) => unparkComment({ ticket: TICKET, diagnosis: d, evidence: EVIDENCE })),
  labels: ["ready-for-agent"],
  isDraft: false,
});

describe("the marker", () => {
  it("carries the diagnosis as a hash, because a case key cannot go in an attribute", () => {
    expect(unparkMarker(TICKET, FLAKE)).toBe(`<!-- ci-doctor unpark ticket=${TICKET} diagnosis=${diagnosisToken(FLAKE)} -->`);
    expect(diagnosisToken(FLAKE)).toMatch(/^[0-9a-f]{16}$/);
    expect(diagnosisToken(FLAKE)).not.toBe(diagnosisToken(OTHER));
  });

  it("reads back the diagnoses a ticket's comments record, and only this ticket's", () => {
    const mine = unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE });
    const quoted = `A hand-off note quoting ${unparkMarker(9999, OTHER)} from another ticket.`;
    expect([...markerIndex(TICKET, [{ body: mine }, { body: quoted }]).keys()]).toEqual([diagnosisToken(FLAKE)]);
  });

  it("remembers the NEWEST comment that records a diagnosis, which is what the re-park check needs", () => {
    const one = unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE });
    expect(markerIndex(TICKET, [{ body: one }, { body: "note" }, { body: one }]).get(diagnosisToken(FLAKE))).toBe(2);
  });

  it("puts the verdict first and the marker last, so a truncated read still shows the reason", () => {
    const body = unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE });
    expect(body.split("\n")[0]).toBe(`unparked: ${FLAKE}`);
    expect(body.trimEnd().endsWith(unparkMarker(TICKET, FLAKE))).toBe(true);
    expect(body).toContain(EVIDENCE);
  });

  it("counts a refusal apart from an unpark, so a refusal cannot spend the budget", () => {
    expect(markerIndex(TICKET, [{ body: `No. ${declinedMarker(TICKET, FLAKE)}` }]).size).toBe(0);
  });
});

describe("the owner", () => {
  it("is the loop the pull request body is stamped for", () => {
    expect(ownerOf(BODY)).toBe("ralph");
    expect(ownerOf("🤖 Rafa loop — run `r`")).toBe("rafa");
  });

  it("is unknown rather than guessed when the body carries no provenance line", () => {
    expect(ownerOf("Closes #1557")).toBeNull();
    expect(ownerOf(null)).toBeNull();
  });
});

describe("decide", () => {
  const base = { ticket: TICKET, diagnosis: FLAKE, owner: "ralph", comments: [], labels: ["ralph-blocked"], isDraft: true };

  it("takes all three steps on a ticket nothing has touched", () => {
    expect(decide(base)).toEqual({
      act: "unpark",
      comment: true,
      removeLabel: "ralph-blocked",
      ready: true,
      resuming: false,
    });
  });

  it("drops only the OWNER's block label, and never a claim", () => {
    expect(decide({ ...base, labels: ["ralph-blocked", "rafa-wip"] })).toMatchObject({
      act: "unpark",
      removeLabel: "ralph-blocked",
    });
  });

  it("faults on a block label the pull request's loop does not account for", () => {
    // Readying the PR while an unattributable block label stays on is the end
    // state the write order exists to prevent.
    expect(decide({ ...base, labels: ["ralph-blocked", "rafa-blocked"] })).toMatchObject({ act: "fault" });
  });

  it("refuses to guess which loop parked a ticket whose pull request is unstamped", () => {
    expect(decide({ ...base, owner: null })).toMatchObject({ act: "fault" });
  });

  it("needs no owner once the block label is already gone — a resume survives an edited body", () => {
    expect(decide({ ...base, owner: null, labels: ["ready-for-agent"] })).toMatchObject({
      act: "unpark",
      removeLabel: null,
    });
  });
});

/**
 * AC 1. The second run is not a special case in the code: each step asks
 * GitHub what is outstanding, and after a completed unpark the answer to all
 * three is "nothing".
 */
describe("AC 1 — a second run on the same (ticket, diagnosis) writes nothing", () => {
  it("comments, unblocks and readies on the first run and writes nothing on the second", async () => {
    const store = scratchStore();
    const first = fakeGh({ labels: ["ralph-blocked"], isDraft: true });
    expect(await runUnpark(argv(), deps(store, first))).toBe(0);
    expect(writes(first)).toEqual([
      expect.stringContaining(`issue comment ${TICKET} --body unparked: ${FLAKE}`),
      `issue edit ${TICKET} --remove-label ralph-blocked`,
      `pr ready ${PR}`,
    ]);

    const second = fakeGh(unparked());
    const run = deps(store, second);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(writes(second)).toEqual([]);
    expect(run.lines.join("\n")).toContain("already unparked");
    // The kind leads the line: `why` alone opens "…was unparked…" on a
    // decline, which the doctor's prompt (§2.3) would read as success.
    expect(run.lines.join("\n")).toMatch(/^unpark: (unpark|resumed|declined|nothing|fault):/m);
  });

  it("records the diagnosis in the store exactly once across both runs", async () => {
    const store = scratchStore();
    await runUnpark(argv(), deps(store, fakeGh({ labels: ["ralph-blocked"], isDraft: true })));
    const after: CiHealthStore = readStore(store.path);
    expect(after.cases[`parked:${TICKET}`]?.unparks).toEqual({ [FLAKE]: [AT] });

    await runUnpark(argv(), deps(store, fakeGh(unparked())));
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks).toEqual({ [FLAKE]: [AT] });
  });

  it("writes the store only after step 3, so an interrupted run is never recorded as done", async () => {
    // `gate.ts actionable` stops offering a ticket whose diagnosis the store
    // holds. Recorded before `pr ready`, that would strand a draft nobody
    // shepherds with the gate convinced the work was finished.
    const store = scratchStore();
    const gh = (async (args: string[]): Promise<Ran> => {
      if (args[0] === "issue" && args[1] === "view") return json({ comments: [], labels: [{ name: "ralph-blocked" }] });
      if (args[0] === "pr" && args[1] === "view") return json({ isDraft: true, body: BODY });
      if (args[0] === "pr" && args[1] === "ready") return { ok: false, stdout: "", stderr: "pr ready exploded" };
      return ok();
    }) as Gh;
    await expect(runUnpark(argv(), deps(store, gh))).rejects.toThrow(/pr ready exploded/);
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks ?? {}).toEqual({});
  });
});

/**
 * AC 2. The crash point the issue names: between step 2 and step 3. The
 * marker is on the issue, the label is gone, the pull request is still a
 * draft — so the one outstanding step is the one that runs.
 */
describe("AC 2 — a run killed after step 2 is finished by the next one", () => {
  it("readies the pull request without writing a second comment", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE })],
      labels: ["ready-for-agent"],
      isDraft: true,
    });
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(writes(gh)).toEqual([`pr ready ${PR}`]);
    expect(run.lines.join("\n")).toContain("resumed");
  });

  it("drops the label and readies when the comment landed and nothing else did", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE })],
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    expect(await runUnpark(argv(), deps(store, gh))).toBe(0);
    expect(writes(gh)).toEqual([`issue edit ${TICKET} --remove-label ralph-blocked`, `pr ready ${PR}`]);
  });

  it("still records the diagnosis when it resumes, so the gate stops offering the ticket", async () => {
    const store = scratchStore();
    await runUnpark(
      argv(),
      deps(
        store,
        fakeGh({
          comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE })],
          labels: ["ready-for-agent"],
          isDraft: true,
        }),
      ),
    );
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks).toEqual({ [FLAKE]: [AT] });
  });
});

/** AC 3. The budget, counted off the issue's comments because the store is a cache. */
describe("AC 3 — the budget", () => {
  it("refuses a third unpark of one ticket and leaves the label and the pull request alone", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [FLAKE, OTHER].map((d) => unparkComment({ ticket: TICKET, diagnosis: d, evidence: EVIDENCE })),
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    const run = deps(store, gh);
    expect(await runUnpark([...argv(THIRD)], run)).toBe(0);
    expect(writes(gh)).toEqual([expect.stringContaining(`issue comment ${TICKET} --body unpark-declined: ${THIRD}`)]);
    expect(writes(gh).join("\n")).not.toContain("--remove-label");
    expect(writes(gh).join("\n")).not.toContain("pr ready");
    expect(run.lines.join("\n")).toContain(`the budget is ${MAX_UNPARKS_PER_TICKET}`);
  });

  it("comments that refusal once, not on every poll", async () => {
    const store = scratchStore();
    const prior = [FLAKE, OTHER].map((d) => unparkComment({ ticket: TICKET, diagnosis: d, evidence: EVIDENCE }));
    const gh = fakeGh({
      comments: [...prior, `unpark-declined: ${THIRD}\n\n${declinedMarker(TICKET, THIRD)}`],
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    expect(await runUnpark([...argv(THIRD)], deps(store, gh))).toBe(0);
    expect(writes(gh)).toEqual([]);
  });

  it("writes no second comment for a diagnosis already unparked, whatever else is outstanding", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE })],
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    await runUnpark(argv(), deps(store, gh));
    expect(writes(gh).filter((call) => call.includes("issue comment"))).toEqual([]);
  });

  it("counts the budget off GitHub, not off the store, because the store may be rebuilt", async () => {
    // A fresh store — as a deleted `ci-health.json` leaves it — must not
    // restore a spent allowance.
    const store = scratchStore();
    const gh = fakeGh({
      comments: [FLAKE, OTHER].map((d) => unparkComment({ ticket: TICKET, diagnosis: d, evidence: EVIDENCE })),
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    expect(unparkCount(readStore(store.path).cases[`parked:${TICKET}`])).toBe(0);
    await runUnpark([...argv(THIRD)], deps(store, gh));
    expect(writes(gh).join("\n")).not.toContain("--remove-label");
  });
});

/**
 * The state that is otherwise invisible: a chronic flake's steady state. On
 * GitHub a re-park looks exactly like an unpark interrupted after step 1 —
 * marker present, label present, draft — and read as a resume it would be
 * unparked again, with no comment and no bound, for as long as the test stays
 * flaky. The ordering of the comments is what tells them apart.
 */
describe("a ticket parked AGAIN after an unpark", () => {
  const reparked = (): World => ({
    comments: [
      unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE }),
      `blocked: PR #${PR} red on a flaky test (src/queue/retry.test.ts), not the diff`,
    ],
    labels: ["ralph-blocked"],
    isDraft: true,
  });

  it("is a second unpark of that diagnosis, which the budget refuses", () => {
    expect(
      decide({
        ticket: TICKET,
        diagnosis: FLAKE,
        owner: "ralph",
        comments: reparked().comments!.map((body) => ({ body })),
        labels: ["ralph-blocked"],
        isDraft: true,
      }),
    ).toMatchObject({ act: "declined" });
  });

  it("is not re-unparked: the label and the pull request are left alone", async () => {
    const store = scratchStore();
    const gh = fakeGh(reparked());
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(writes(gh).join("\n")).not.toContain("--remove-label");
    expect(writes(gh).join("\n")).not.toContain("pr ready");
    expect(run.lines.join("\n")).toContain("parked on a flake again");
  });

  it("is still distinguished from a resume, which has no newer block record", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE })],
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    expect(await runUnpark(argv(), deps(store, gh))).toBe(0);
    expect(writes(gh)).toEqual([`issue edit ${TICKET} --remove-label ralph-blocked`, `pr ready ${PR}`]);
  });
});

/**
 * The gate's trigger is the store, not GitHub, and the store may be deleted
 * and rebuilt from a scan at any time. A completed unpark that the rebuilt
 * store has forgotten must be re-learned rather than re-offered for good.
 */
describe("a rebuilt store", () => {
  it("learns a completed unpark from GitHub without writing anything to GitHub", async () => {
    const store = scratchStore();
    const gh = fakeGh(unparked());
    expect(await runUnpark(argv(), deps(store, gh))).toBe(0);
    expect(writes(gh)).toEqual([]);
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks).toEqual({ [FLAKE]: [AT] });
  });
});

describe("what the command refuses to be given", () => {
  it("refuses a diagnosis that is not a case key, which would blind the gate for good", async () => {
    const store = scratchStore();
    const gh = fakeGh();
    // `gate.ts` reads the test id back out of the case's `rule`, and never
    // re-reads a ticket it already has a case for.
    await expect(runUnpark(argv("a flaky retry test"), deps(store, gh))).rejects.toThrow(/case key/);
    expect(gh.calls).toEqual([]);
  });

  it("refuses evidence carrying an unpark marker, which would spend the budget it reports on", async () => {
    const store = scratchStore();
    const gh = fakeGh();
    const forged = [String(TICKET), "--pr", String(PR), "--diagnosis", FLAKE, "--evidence", unparkMarker(TICKET, OTHER)];
    await expect(runUnpark(forged, deps(store, gh))).rejects.toThrow(/must not contain a ci-doctor unpark marker/);
    expect(gh.calls).toEqual([]);
  });

  it("refuses a pull request that does not name the ticket — a transposed --pr readies a stranger's draft", async () => {
    const store = scratchStore();
    const gh = fakeGh({ labels: ["ralph-blocked"], isDraft: true, body: "🤖 Ralph loop — run `r`\n\nCloses #9999" });
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(1);
    expect(writes(gh)).toEqual([]);
    expect(run.lines.join("\n")).toContain(`does not name #${TICKET}`);
  });
});

/**
 * Round 2's two defects, both of which round 1's own fixes created.
 */
describe("a block record that is not a re-park", () => {
  const after = (body: string): World => ({
    comments: [unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE }), body],
    labels: ["ralph-blocked"],
    isDraft: true,
  });

  it("stands down rather than unpark over a migration a person has to apply", async () => {
    const store = scratchStore();
    const gh = fakeGh(after("needs-migration: apply drizzle/0062_x.sql before merging"));
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(writes(gh).join("\n")).not.toContain("--remove-label");
    expect(writes(gh).join("\n")).not.toContain("pr ready");
    expect(run.lines.join("\n")).toContain("blocked again as migration");
  });

  it("stands down rather than unpark over a human who looked at it", async () => {
    const store = scratchStore();
    const gh = fakeGh(after("blocked: taking this one by hand, the diff is wrong"));
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(run.lines.join("\n")).toContain("blocked again as other");
  });

  it("writes NOTHING when the unpark already completed, whatever was blocked afterwards", async () => {
    // AC 1 again, and the state round 1 got wrong: with all three steps done,
    // a later block record must not make the doctor comment a refusal.
    const store = scratchStore();
    const gh = fakeGh({
      comments: [
        unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE }),
        "needs-migration: apply drizzle/0062_x.sql before merging",
      ],
      labels: ["ready-for-agent"],
      isDraft: false,
    });
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(0);
    expect(writes(gh)).toEqual([]);
    expect(run.lines.join("\n")).toContain("already unparked");
  });

  it("asks nothing-to-do before anything else, so an unattributable label cannot fault a finished ticket", () => {
    expect(
      decide({
        ticket: TICKET,
        diagnosis: FLAKE,
        owner: null,
        comments: [{ body: unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE }) }],
        labels: [],
        isDraft: false,
      }),
    ).toMatchObject({ act: "nothing" });
  });
});

describe("the store record's key", () => {
  it("is the key the GATE reads — the parked case's own rule, not the doctor's spelling", async () => {
    // `testIdOf` returns the bare file when the quoted FAIL line has no title,
    // where a case key is `flake:<file> > <test>`. Recorded under the doctor's
    // spelling, `actionable` would stay non-null and re-offer the ticket for
    // ever with the record sitting right there.
    const store = scratchStore();
    await withStore(store.path, (open) => {
      open.cases[`parked:${TICKET}`] = { ...parkedCase("src/queue/retry.test.ts") };
    });
    await runUnpark(argv(), deps(store, fakeGh({ labels: ["ralph-blocked"], isDraft: true })));
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks).toEqual({
      "flake:src/queue/retry.test.ts": [AT],
    });
  });

  it("falls back to the argument only for a case this run is creating", async () => {
    const store = scratchStore();
    await runUnpark(argv(), deps(store, fakeGh({ labels: ["ralph-blocked"], isDraft: true })));
    expect(readStore(store.path).cases[`parked:${TICKET}`]).toMatchObject({
      rule: "src/queue/retry.test.ts > retries",
      unparks: { [FLAKE]: [AT] },
    });
  });

  it("records a refusal too, since a refused ticket keeps its label and stays in the gate's search", async () => {
    const store = scratchStore();
    const gh = fakeGh({
      comments: [FLAKE, OTHER].map((d) => unparkComment({ ticket: TICKET, diagnosis: d, evidence: EVIDENCE })),
      labels: ["ralph-blocked"],
      isDraft: true,
    });
    expect(await runUnpark(argv(THIRD), deps(store, gh))).toBe(0);
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks).toEqual({ [THIRD]: [AT] });
  });
});

/**
 * The fences the issue states as prose: "The doctor never removes a `-wip`
 * label and never pushes, rebases, requeues or closes a coder's PR." Pinned
 * here because nothing else in the codebase stops this module growing one.
 */
describe("what the doctor may not do", () => {
  it("never touches a claim label or the pull request beyond readying it", async () => {
    const store = scratchStore();
    const gh = fakeGh({ labels: ["ralph-blocked", "ralph-wip"], isDraft: true });
    await runUnpark(argv(), deps(store, gh));
    const all = gh.calls.join("\n");
    expect(all).not.toContain("-wip");
    expect(all).not.toContain("pr close");
    expect(all).not.toContain("pr merge");
    expect(all).not.toContain("pr edit");
    expect(all).not.toContain("--add-label");
    expect(gh.calls.filter((call) => call.startsWith("pr ") && !call.includes("--json"))).toEqual([`pr ready ${PR}`]);
  });

  it("faults rather than drop a label it cannot attribute", async () => {
    const store = scratchStore();
    const gh = fakeGh({ labels: ["ralph-blocked"], isDraft: true, body: `Closes #${TICKET}` });
    const run = deps(store, gh);
    expect(await runUnpark(argv(), run)).toBe(1);
    expect(writes(gh)).toEqual([]);
    expect(run.lines.join("\n")).toContain("no provenance line");
  });
});

describe("the CLI surface", () => {
  it("validates the whole argv before the first read", async () => {
    const store = scratchStore();
    const gh = fakeGh();
    await expect(runUnpark([String(TICKET), "--pr", String(PR)], deps(store, gh))).rejects.toThrow(/--diagnosis/);
    await expect(runUnpark(["--pr", String(PR)], deps(store, gh))).rejects.toThrow(/ticket number/);
    await expect(runUnpark([String(TICKET), "--diagnosis", FLAKE, "--evidence", "e"], deps(store, gh))).rejects.toThrow(/--pr/);
    await expect(runUnpark([String(TICKET), "--pr", String(PR), "--diagnosis", FLAKE], deps(store, gh))).rejects.toThrow(
      /--evidence/,
    );
    expect(gh.calls).toEqual([]);
  });

  it("reads a throttle as time rather than a fault, on a READ as well as a write", async () => {
    // `main()` turns a RateLimitedError into exit 75, which the supervisor
    // waits out; a plain Error stops the loop for a human.
    const store = scratchStore();
    const limited = (which: string) =>
      (async (args: string[]): Promise<Ran> =>
        args[0] === which
          ? { ok: false, stdout: "", stderr: "API rate limit exceeded for user ID 1." }
          : json({ comments: [], labels: [], isDraft: true, body: BODY })) as Gh;
    await expect(runUnpark(argv(), deps(store, limited("issue")))).rejects.toSatisfy(isRateLimited);
    await expect(runUnpark(argv(), deps(store, limited("pr")))).rejects.toSatisfy(isRateLimited);
  });

  it("holds the budget as a parameter, not only as a constant", () => {
    const one = {
      ticket: TICKET,
      diagnosis: OTHER,
      owner: "ralph",
      comments: [{ body: unparkComment({ ticket: TICKET, diagnosis: FLAKE, evidence: EVIDENCE }) }],
      labels: ["ralph-blocked"],
      isDraft: true,
    };
    expect(decide({ ...one, max: 1 })).toMatchObject({ act: "declined" });
    expect(decide({ ...one, max: 2 })).toMatchObject({ act: "unpark" });
  });

  it("reports a read it could not make rather than deciding from half a ticket", async () => {
    const store = scratchStore();
    const gh = (async (args: string[]): Promise<Ran> =>
      args[0] === "issue" ? { ok: false, stdout: "", stderr: "gh: not found" } : ok()) as Gh;
    await expect(runUnpark(argv(), deps(store, gh))).rejects.toThrow(/could not read #1557/);
  });
});

describe("the store record", () => {
  it("creates the parked case when the scan has not written one, carrying the flake as its rule", async () => {
    const store = scratchStore();
    expect(await recordUnpark({ ticket: TICKET, diagnosis: FLAKE, at: AT, testId: "src/a.test.ts" }, store)).toBe(true);
    const value = readStore(store.path).cases[`parked:${TICKET}`];
    expect(value).toMatchObject({ kind: "parked", rule: "src/a.test.ts", unparks: { [FLAKE]: [AT] } });
  });

  it("does not append a second timestamp for a diagnosis it already holds", async () => {
    const store = scratchStore();
    await recordUnpark({ ticket: TICKET, diagnosis: FLAKE, at: AT }, store);
    expect(await recordUnpark({ ticket: TICKET, diagnosis: FLAKE, at: "2026-10-05T00:00:00.000Z" }, store)).toBe(false);
    expect(unparkCount(readStore(store.path).cases[`parked:${TICKET}`])).toBe(1);
  });

  it("is the shape ci-doctor/gate.ts actionable reads", async () => {
    const store = scratchStore();
    await recordUnpark({ ticket: TICKET, diagnosis: FLAKE, at: AT }, store);
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks[FLAKE]).toBeDefined();
    expect(readStore(store.path).cases[`parked:${TICKET}`]?.unparks[OTHER]).toBeUndefined();
  });
});

describe("unpark", () => {
  it("makes no GitHub write at all on a nothing or a fault decision", async () => {
    for (const decision of [
      { act: "nothing", why: "done" },
      { act: "fault", why: "unstamped" },
    ] satisfies Decision[]) {
      const store = scratchStore();
      const gh = fakeGh();
      const outcome = await unpark({ ticket: TICKET, pr: PR, diagnosis: FLAKE, evidence: EVIDENCE, at: AT }, decision, { gh }, store);
      expect(gh.calls).toEqual([]);
      expect(outcome).toMatchObject({ kind: decision.act, commented: false, unblocked: false, readied: false });
    }
  });

  it("records a nothing but never a fault — a fault has established nothing", async () => {
    const nothing = scratchStore();
    await unpark(
      { ticket: TICKET, pr: PR, diagnosis: FLAKE, evidence: EVIDENCE, at: AT },
      { act: "nothing", why: "done" },
      { gh: fakeGh() },
      nothing,
    );
    expect(readStore(nothing.path).cases[`parked:${TICKET}`]?.unparks).toEqual({ [FLAKE]: [AT] });

    const fault = scratchStore();
    await unpark(
      { ticket: TICKET, pr: PR, diagnosis: FLAKE, evidence: EVIDENCE, at: AT },
      { act: "fault", why: "unstamped" },
      { gh: fakeGh() },
      fault,
    );
    expect(readStore(fault.path).cases[`parked:${TICKET}`]).toBeUndefined();
  });
});

describe("readParked", () => {
  it("reads the comments and labels in one call, because both decide the same run", async () => {
    const gh = fakeGh({ comments: ["hello"], labels: ["ralph-blocked"] });
    expect(await readParked(TICKET, { gh })).toEqual({
      comments: [{ body: "hello", createdAt: AT }],
      labels: ["ralph-blocked"],
    });
    expect(gh.calls).toEqual([`issue view ${TICKET} --json comments,labels`]);
  });
});
