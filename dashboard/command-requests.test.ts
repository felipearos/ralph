// @vitest-environment node
/**
 * The one parser per relayed command, held to explicit verdicts: every body
 * below is accepted with the typed request it names, or refused with the exact
 * status, error kind and message the local routes have always answered with.
 * The expectations are literals, so a change to any parser's order of checks
 * or wording shows up here rather than as a different 400 on the remote page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkCommandBody,
  COMMAND_PARSERS,
  ControlRouteError,
  isSafeCommandId,
  parseJsonBody,
  readBody,
} from "./command-requests";
import { RELAYED_COMMAND_KINDS, type RelayedCommandKind } from "./contracts";

type Verdict = { ok: true; value: unknown } | { ok: false; status: number; name: string; message: string };

const verdict = (run: () => unknown): Verdict => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof ControlRouteError) {
      return { ok: false, status: error.status, name: error.name, message: error.message };
    }
    throw error;
  }
};

const ok = (value: unknown): Verdict => ({ ok: true, value });
const bad = (message: string): Verdict => ({ ok: false, status: 400, name: "ControlRequestError", message });
const unconfirmed = (message: string): Verdict => ({ ok: false, status: 400, name: "ConfirmationRequired", message });

const BODIES: unknown[] = [
  null,
  [],
  "loop",
  {},
  { loop: "" },
  { loop: 7 },
  { loop: "ralph" },
  { loop: "ralph", confirm: true },
  { loop: "ralph", confirm: "yes" },
  { loop: "ralph", action: "pause" },
  { loop: "ralph", action: 3 },
  { loop: "ralph", action: "explode" },
  { loop: "ralph", action: "stop" },
  { loop: "ralph", action: "stop", confirm: true, stopKind: "after-iteration" },
  { loop: "ralph", action: "stop", confirm: true, stopKind: "sudden" },
  { loop: "ralph", action: "pause", stopKind: "after-iteration" },
  { loop: "ralph", action: "pause", scope: "phase" },
  { loop: "ralph", action: "pause", scope: "forever" },
  { loop: "ralph", action: "approve", scope: "phase" },
  { loop: "ralph", action: "arm-gate", phase: "nope" },
  { loop: "ralph", action: "pause", reconfirm: "yes" },
  { loop: "ralph", action: "abandon", issue: "14", confirm: true },
  { loop: "ralph", action: "abandon", issue: 14 },
  { loop: "ralph", action: "pause", run: 4 },
  { loop: "ralph", action: "pause", why: ["x"] },
  { loop: "ralph", action: "pause", id: 9 },
  { loop: "ralph", confirm: true, stopKind: "sudden" },
  { loop: "ralph", confirm: true, reconfirm: 1 },
  { loop: "ralph", confirm: true, id: ".hidden" },
  { loop: "ralph", confirm: true, id: "x.tmp" },
  { loop: "ralph", confirm: true, run: 1 },
  { loop: "ralph", through: "2026-10-09T00:00:00Z" },
  { loop: "ralph", through: "yesterday" },
  { loop: "ralph", through: 5 },
  { name: "rulo" },
  { name: "Bad Name" },
  { name: 3 },
  { name: "" },
];

const NOT_OBJECT = bad("the request body must be a JSON object");
const LOOP_STRING = bad("'loop' must be a string");
const ACTIONS = "pause, resume, stop, approve, deny, arm-gate, disarm-gate, retry, abandon, release, retry-phase";
const NO_ACTION = bad(`'action' is required: one of ${ACTIONS}`);
const CONTROL_NO_LOOP = bad("'loop' is required: name the loop the command is for");
const ACT_NO_LOOP = bad("'loop' is required: name the loop to act on");
const STOP_KINDS = "completed, blocked, failed";
const PAUSE = { loop: "ralph", action: "pause", run: null, why: null, stopKind: null, issue: null, reconfirm: false, scope: null, phase: null, id: null };
const RESTART_UNCONFIRMED = unconfirmed(
  'restart stops the loop at its next iteration boundary and starts it again: send it with "confirm": true',
);
const RESTART = { loop: "ralph", run: null, why: null, stopKind: null, reconfirm: false, id: null };
const STOP_NOW_UNCONFIRMED = unconfirmed(
  'stop now signals the loop\'s process group and ends the iteration in progress: send it with "confirm": true',
);
const STOP_NOW = { loop: "ralph", why: null, run: null, reconfirm: false, id: null };
const UNSAFE_ID = bad("'id' must be letters, numbers, '.', '_' or '-' (at most 128, not starting with a dot)");
const LOOP_ONLY = ok({ loop: "ralph" });
const NO_NAME = bad("'name' is required: name the agent");
const NO_REPO = bad("'repo' is required: the repository, as owner/name");
// No shared body names a `case`, so every object is refused for the missing case.
const NO_CASE_ID = bad("'case' is required: the test-set case's id");
const NO_ENTRY = bad("'entry' is required: the inbox entry's id");
const NO_THROUGH = bad("'through' is required: the time of the newest alert the operator has seen, as an ISO timestamp");
const MARK_NO_LOOP = bad("'loop' is required: name the loop whose alerts to mark read");

/** Bodies 0–5 are refused the same way by every loop-naming parser but for the "no loop" message. */
const loopless = (noLoop: Verdict): Verdict[] => [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, noLoop, noLoop, LOOP_STRING];
/** Bodies 6–33 for a parser that reads only the loop. */
const loopOnly = (): Verdict[] => Array.from({ length: 28 }, () => LOOP_ONLY);
/** Bodies 34–37 name an agent, not a loop. */
const named = (noLoop: Verdict): Verdict[] => [noLoop, noLoop, noLoop, noLoop];

const EXPECTED: Record<RelayedCommandKind, Verdict[]> = {
  control: [
    ...loopless(CONTROL_NO_LOOP),
    NO_ACTION,
    NO_ACTION,
    NO_ACTION,
    ok(PAUSE),
    bad("'action' must be a string"),
    bad(`unknown control action 'explode'; expected one of ${ACTIONS}`),
    unconfirmed(
      'stop ends the loop at its next iteration boundary, or its next phase boundary with scope phase: send it with "confirm": true',
    ),
    bad(`unknown stop kind 'after-iteration'; expected one of ${STOP_KINDS}`),
    bad(`unknown stop kind 'sudden'; expected one of ${STOP_KINDS}`),
    bad("'stopKind' applies only to stop"),
    ok({ ...PAUSE, scope: "phase" }),
    bad("unknown scope 'forever'; expected one of iteration, phase"),
    bad("'scope' applies only to pause and stop"),
    bad("unknown phase 'nope'; expected one of select, implement, verify, review, finish"),
    bad("'reconfirm' must be true or false"),
    bad("'issue' must be a positive whole number"),
    unconfirmed('abandon takes an expired claim back from its owner: send it with "confirm": true'),
    bad("'run' must be a string"),
    bad("'why' must be a string"),
    bad("'id' must be a string"),
    ...Array.from({ length: 8 }, () => NO_ACTION),
    ...named(CONTROL_NO_LOOP),
  ],
  start: [...loopless(ACT_NO_LOOP), ...loopOnly(), ...named(ACT_NO_LOOP)],
  restart: [
    ...loopless(ACT_NO_LOOP),
    RESTART_UNCONFIRMED,
    ok(RESTART),
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    bad(`unknown stop kind 'after-iteration'; expected one of ${STOP_KINDS}`),
    bad(`unknown stop kind 'sudden'; expected one of ${STOP_KINDS}`),
    bad(`unknown stop kind 'after-iteration'; expected one of ${STOP_KINDS}`),
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    bad("'reconfirm' must be true or false"),
    ok(RESTART),
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    bad(`unknown stop kind 'sudden'; expected one of ${STOP_KINDS}`),
    bad("'reconfirm' must be true or false"),
    ok({ ...RESTART, id: ".hidden" }),
    ok({ ...RESTART, id: "x.tmp" }),
    bad("'run' must be a string"),
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    RESTART_UNCONFIRMED,
    ...named(ACT_NO_LOOP),
  ],
  "stop-now": [
    ...loopless(ACT_NO_LOOP),
    STOP_NOW_UNCONFIRMED,
    ok(STOP_NOW),
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    ok(STOP_NOW),
    ok(STOP_NOW),
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    bad("'reconfirm' must be true or false"),
    ok(STOP_NOW),
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    bad("'id' must be a string"),
    ok(STOP_NOW),
    bad("'reconfirm' must be true or false"),
    UNSAFE_ID,
    UNSAFE_ID,
    bad("'run' must be a string"),
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    STOP_NOW_UNCONFIRMED,
    ...named(ACT_NO_LOOP),
  ],
  "resume-work": [...loopless(ACT_NO_LOOP), ...loopOnly(), ...named(ACT_NO_LOOP)],
  "agent-start": [
    NOT_OBJECT,
    NOT_OBJECT,
    NOT_OBJECT,
    ...Array.from({ length: 31 }, () => NO_NAME),
    ok({ body: { name: "rulo" }, name: "rulo" }),
    bad("'name' must be one lowercase word (a-z, then a-z or 0-9); got 'Bad Name'"),
    bad("'name' must be a string"),
    NO_NAME,
  ],
  "mark-read": [
    ...loopless(MARK_NO_LOOP),
    ...Array.from({ length: 25 }, () => NO_THROUGH),
    ok({ loop: "ralph", through: "2026-10-09T00:00:00.000Z" }),
    NO_THROUGH,
    bad("'through' must be a string"),
    ...named(MARK_NO_LOOP),
  ],
  // No body above carries a plan, nor a run's id: only their shapes are refused.
  "eval-start": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => bad("'plan' is required: the eval plan, a JSON object"))],
  "eval-stop": [
    NOT_OBJECT, NOT_OBJECT, NOT_OBJECT,
    ...Array.from({ length: 35 }, (_, index) => (index + 3 === 23 || index + 3 === 30 ? bad("'run' must be a string") : bad("'run' is required: the run's id"))),
  ],
  // No body above names a repository: an add is refused on that first.
  "eval-set-add": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_REPO)],
  // Only the ids at 25, 28 and 29 reach a case-id check; none is a case id.
  "eval-set-edit": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_CASE_ID)],
  "eval-set-retire": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_CASE_ID)],
  "eval-set-check": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_CASE_ID)],
  "eval-set-keep": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_CASE_ID)],
  // An inbox add judges its plan as a start does; no body above names an inbox entry.
  "eval-inbox-add": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => bad("'plan' is required: the eval plan, a JSON object"))],
  "eval-inbox-start": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_ENTRY)],
  "eval-inbox-dismiss": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_ENTRY)],
  // A propose names its run as a stop does; no body above names one as a string.
  "eval-improve-propose": [
    NOT_OBJECT, NOT_OBJECT, NOT_OBJECT,
    ...Array.from({ length: 35 }, (_, index) => (index + 3 === 23 || index + 3 === 30 ? bad("'run' must be a string") : bad("'run' is required: the finished eval run's id"))),
  ],
  "eval-set-calibrate": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => NO_CASE_ID)],
  // No body above names a proposal.
  "eval-proposal-open-pr": [NOT_OBJECT, NOT_OBJECT, NOT_OBJECT, ...Array.from({ length: 35 }, () => bad("'proposal' is required: the improver proposal's id"))],
};

describe("COMMAND_PARSERS", () => {
  it("has one parser for every relayed command", () => {
    expect(Object.keys(COMMAND_PARSERS).sort()).toEqual([...RELAYED_COMMAND_KINDS].sort());
  });

  for (const kind of RELAYED_COMMAND_KINDS) {
    it(`gives every ${kind} body its explicit verdict`, () => {
      expect(EXPECTED[kind]).toHaveLength(BODIES.length);
      BODIES.forEach((body, index) => {
        expect([index, body, verdict(() => COMMAND_PARSERS[kind](body))]).toEqual([index, body, EXPECTED[kind][index]]);
      });
    });

    it(`checkCommandBody throws ${kind}'s 400s and discards its request`, () => {
      BODIES.forEach((body, index) => {
        const expected = EXPECTED[kind][index]!;
        expect([index, verdict(() => checkCommandBody(kind, body))]).toEqual([
          index,
          expected.ok ? ok(undefined) : expected,
        ]);
      });
    });
  }
});

describe("parseJsonBody and readBody", () => {
  it("parses JSON text", () => {
    expect(parseJsonBody('{"loop":"ralph"}')).toEqual({ loop: "ralph" });
  });

  it("refuses text that is not JSON", () => {
    expect(verdict(() => parseJsonBody("{nope"))).toEqual(bad("the request body is not valid JSON"));
  });

  it("reads a request's body through the same step", async () => {
    await expect(readBody(new Request("http://127.0.0.1/", { method: "POST", body: '{"a":1}' }))).resolves.toEqual({ a: 1 });
    await expect(readBody(new Request("http://127.0.0.1/", { method: "POST", body: "{nope" }))).rejects.toMatchObject({
      status: 400,
      name: "ControlRequestError",
      message: "the request body is not valid JSON",
    });
  });
});

describe("isSafeCommandId", () => {
  it("accepts inbox-safe ids and refuses the rest", () => {
    expect(isSafeCommandId("a")).toBe(true);
    expect(isSafeCommandId("run-1.x_y")).toBe(true);
    expect(isSafeCommandId(".hidden")).toBe(false);
    expect(isSafeCommandId("x.tmp")).toBe(false);
    expect(isSafeCommandId("a".repeat(129))).toBe(false);
    expect(isSafeCommandId("a/b")).toBe(false);
  });
});

describe("dashboard/command-requests.ts", () => {
  it("imports only ./contracts, so the Vercel function never reaches the adapters' graph", () => {
    const source = readFileSync(join(__dirname, "command-requests.ts"), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((match) => match[1]);
    expect(specifiers).toEqual(["./contracts"]);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    // A bare side-effect import has no `from`, so the pattern above would miss it.
    expect(source).not.toMatch(/^\s*import\s+["']/m);
  });
});

describe("eval-start through the relay's gate (#827)", () => {
  // The remote handler judges a relayed body with checkCommandBody before it
  // queues it, so this is what lets the remote page start a clerk backtest.
  const sample = { cap: 5, since: "2026-10-01T00:00:00Z" };
  it("passes a clerk plan and a PR plan", () => {
    expect(() => checkCommandBody("eval-start", { plan: { clerk: "clara", sample, arms: [{ name: "opus" }] } })).not.toThrow();
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "pr", prs: [12] } } })).not.toThrow();
  });
  it("refuses a plan that is neither", () => {
    for (const plan of [{ clerk: "clara" }, { source: { kind: "pr", prs: [12] }, clerk: "clara", sample }, { source: { kind: "clerk", clerk: "clara" } }, {}]) {
      expect(() => checkCommandBody("eval-start", { plan }), JSON.stringify(plan)).toThrow(ControlRouteError);
    }
  });
  it("passes a test set plan, with or without its filters (#854)", () => {
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set", tags: ["ui"] } } })).not.toThrow();
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set" } } })).not.toThrow();
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set", cases: ["GH-12"] }, arms: [{ name: "opus" }] } })).not.toThrow();
  });
  it("refuses a test set plan beside a clerk, or with a filter that is not a list of strings", () => {
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set" }, clerk: "clara", sample } })).toThrow(ControlRouteError);
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set", tags: "ui" } } })).toThrow(/plan\.source\.tags/);
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "set", cases: [1] } } })).toThrow(/plan\.source\.cases/);
    expect(() => checkCommandBody("eval-start", { plan: { source: { kind: "clerk" } } })).toThrow(/test set source/);
  });
});

describe("the Test set's curation commands (#856)", () => {
  const add = { repo: "felipearos/loggd", prs: [12, 14], reason: "  the migration case  " };
  it("accepts an add, normalised, with or without tags and notes", () => {
    expect(verdict(() => COMMAND_PARSERS["eval-set-add"](add))).toEqual(ok({ repo: "felipearos/loggd", prs: [12, 14], reason: "the migration case" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-add"]({ ...add, tags: [" db ", "ui"], notes: "graded on the diff" }))).toEqual(
      ok({ repo: "felipearos/loggd", prs: [12, 14], reason: "the migration case", tags: ["db", "ui"], notes: "graded on the diff" }),
    );
  });

  it("refuses an add with no PRs, a bad repository, an empty reason or oversize tags", () => {
    const refused: [unknown, string][] = [
      [{ ...add, prs: [] }, "'prs' is required: a list of at least one PR number"],
      [{ ...add, prs: undefined }, "'prs' is required: a list of at least one PR number"],
      [{ ...add, prs: [0] }, "each PR must be a positive whole number; got 0"],
      [{ ...add, prs: [1.5] }, "each PR must be a positive whole number; got 1.5"],
      [{ ...add, prs: ["12"] }, "each PR must be a positive whole number; got \"12\""],
      [{ ...add, prs: Array.from({ length: 21 }, (_, index) => index + 1) }, "'prs' holds at most 20 PRs; got 21"],
      [{ ...add, repo: "loggd" }, "'repo' must be owner/name; got 'loggd'"],
      [{ ...add, repo: "a/b/c" }, "'repo' must be owner/name; got 'a/b/c'"],
      [{ ...add, reason: "   " }, "'reason' is required: why this case belongs in the set"],
      [{ ...add, reason: undefined }, "'reason' is required: why this case belongs in the set"],
      [{ ...add, reason: "x".repeat(4001) }, "'reason' is at most 4000 characters"],
      [{ ...add, tags: "db" }, "'tags' must be a list of strings"],
      [{ ...add, tags: ["x".repeat(65)] }, "each tag is at most 64 characters"],
      [{ ...add, tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }, "'tags' holds at most 20 tags; got 21"],
      [{ ...add, tags: [""] }, "each tag must be a non-empty string"],
      [{ ...add, notes: 3 }, "'notes' must be a string"],
    ];
    for (const [body, message] of refused) expect(verdict(() => COMMAND_PARSERS["eval-set-add"](body))).toEqual(bad(message));
  });

  it("accepts an edit of tags, notes or both, and an empty notes clears them", () => {
    expect(verdict(() => COMMAND_PARSERS["eval-set-edit"]({ case: "loggd-12", tags: ["db"] }))).toEqual(ok({ case: "loggd-12", tags: ["db"] }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-edit"]({ case: "loggd-12", notes: "" }))).toEqual(ok({ case: "loggd-12", notes: "" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-edit"]({ case: "loggd-12", tags: [], notes: "n" }))).toEqual(ok({ case: "loggd-12", tags: [], notes: "n" }));
  });

  it("refuses an edit with no id, a bad id, or neither tags nor notes", () => {
    const refused: [unknown, string][] = [
      [{ tags: ["db"] }, "'case' is required: the test-set case's id"],
      [{ case: "Loggd_12", tags: ["db"] }, "'case' must be a case id in lowercase kebab-case; got 'Loggd_12'"],
      [{ case: "loggd--12", notes: "n" }, "'case' must be a case id in lowercase kebab-case; got 'loggd--12'"],
      [{ case: "loggd-12" }, "an edit needs 'tags' or 'notes'"],
      [{ case: "loggd-12", tags: ["a,b"] }, "a tag may not contain a comma"],
      [{ case: "loggd-12", tags: Array.from({ length: 21 }, (_, index) => `t${index}`) }, "'tags' holds at most 20 tags; got 21"],
      [{ case: "loggd-12", notes: "x".repeat(4001) }, "'notes' is at most 4000 characters"],
    ];
    for (const [body, message] of refused) expect(verdict(() => COMMAND_PARSERS["eval-set-edit"](body))).toEqual(bad(message));
  });

  it("names the case under 'case', so the relay's own 'id' stamp cannot redirect it", () => {
    // The remote handler stores `{ ...fields, id: <uuid>, via: "remote" }`; a lowercase UUID fits the case shape.
    const stamped = { id: "3f9c1e2a-7b4d-4c1e-9a2b-1c2d3e4f5a6b", via: "remote" };
    expect(verdict(() => COMMAND_PARSERS["eval-set-retire"]({ case: "acme-app-12", ...stamped }))).toEqual(ok({ case: "acme-app-12" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-edit"]({ case: "acme-app-12", tags: ["db"], ...stamped }))).toEqual(ok({ case: "acme-app-12", tags: ["db"] }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-retire"](stamped))).toEqual(bad("'case' is required: the test-set case's id"));
    expect(verdict(() => COMMAND_PARSERS["eval-set-check"]({ case: "acme-app-12", test: "a.test.ts", ...stamped }))).toEqual(ok({ case: "acme-app-12", test: "a.test.ts" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-keep"]({ case: "acme-app-12", ...stamped }))).toEqual(ok({ case: "acme-app-12" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-keep"](stamped))).toEqual(bad("'case' is required: the test-set case's id"));
  });

  it("accepts a retire by id and refuses one without a case id", () => {
    expect(verdict(() => COMMAND_PARSERS["eval-set-retire"]({ case: "loggd-12" }))).toEqual(ok({ case: "loggd-12" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-retire"]({}))).toEqual(bad("'case' is required: the test-set case's id"));
    expect(verdict(() => COMMAND_PARSERS["eval-set-retire"]({ case: "../x" }))).toEqual(bad("'case' must be a case id in lowercase kebab-case; got '../x'"));
  });

  it("accepts a keep by id and refuses one without a case id (#860)", () => {
    expect(verdict(() => COMMAND_PARSERS["eval-set-keep"]({ case: "loggd-12" }))).toEqual(ok({ case: "loggd-12" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-keep"]({}))).toEqual(bad("'case' is required: the test-set case's id"));
    expect(verdict(() => COMMAND_PARSERS["eval-set-keep"]({ case: "../x" }))).toEqual(bad("'case' must be a case id in lowercase kebab-case; got '../x'"));
  });

  it("accepts a calibration verdict and refuses each malformed field by name (#876)", () => {
    const good = { case: "loggd-12", arms: ["opus", "codex"], axis: "correctness", preferred: "codex", reason: "  kept the migration  " };
    const stamped = { id: "3f9c1e2a-7b4d-4c1e-9a2b-1c2d3e4f5a6b", via: "remote" };
    expect(verdict(() => COMMAND_PARSERS["eval-set-calibrate"]({ ...good, ...stamped }))).toEqual(
      ok({ case: "loggd-12", arms: ["opus", "codex"], axis: "correctness", preferred: "codex", reason: "kept the migration" }),
    );
    const refused: [Record<string, unknown>, string][] = [
      [{ ...good, case: "../x" }, "'case' must be a case id in lowercase kebab-case; got '../x'"],
      [{ ...good, arms: ["opus"] }, "'arms' is required: exactly two arm names"],
      [{ ...good, arms: "opus" }, "'arms' is required: exactly two arm names"],
      [{ ...good, arms: ["opus", ""] }, "'arms' must be two non-empty arm names"],
      [{ ...good, arms: ["opus", "opus"], preferred: "opus" }, "'arms' must be two different arms"],
      [{ ...good, arms: ["opus", "--by"] }, "'arms' must be arm names of letters, digits, '.', '_' or '-', at most 64 characters; got '--by'"],
      [{ ...good, arms: ["opus", "x".repeat(65)] }, `'arms' must be arm names of letters, digits, '.', '_' or '-', at most 64 characters; got '${"x".repeat(65)}'`],
      [{ ...good, axis: "speed" }, "'axis' must be one of correctness, scope, tests, maintainability, review"],
      [{ ...good, preferred: "sonnet" }, "'preferred' must be one of the arms, opus or codex"],
      [{ ...good, reason: " " }, "'reason' is required: why that arm was better"],
      [{ ...good, reason: undefined }, "'reason' is required: why that arm was better"],
      [{ ...good, reason: "--by x" }, "'reason' may not start with --"],
      [{ ...good, reason: "x".repeat(4001) }, "'reason' is at most 4000 characters"],
    ];
    for (const [body, message] of refused) expect(verdict(() => COMMAND_PARSERS["eval-set-calibrate"](body)), message).toEqual(bad(message));
  });

  it("accepts an inbox add as a start's plan with an optional bounded reason, and a start or dismiss by entry (#872)", () => {
    const plan = { source: { kind: "pr", prs: [12] }, arms: ["opus"] };
    const stamped = { id: "3f9c1e2a-7b4d-4c1e-9a2b-1c2d3e4f5a6b", via: "remote" };
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, ...stamped }))).toEqual(ok({ plan }));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: "  worth a look  " }))).toEqual(ok({ plan, reason: "worth a look" }));
    // An empty reason is absent: the adapter gives the default.
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: " " }))).toEqual(ok({ plan }));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: "x".repeat(500) }))).toEqual(ok({ plan, reason: "x".repeat(500) }));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: "x".repeat(501) }))).toEqual(bad("'reason' is at most 500 characters"));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: 3 }))).toEqual(bad("'reason' must be a string"));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan, reason: "--by x" }))).toEqual(bad("'reason' may not start with --"));
    // The plan and the reason are bounded together: both ride one relay body.
    const big = { ...plan, filler: "x".repeat(3_200) };
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan: big }))).toEqual(ok({ plan: big }));
    expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"]({ plan: big, reason: "y".repeat(400) }))).toEqual(bad("'plan' and 'reason' together are over 3500 bytes; shorten the reason"));
    // The plan is judged exactly as a start judges it.
    for (const body of [{}, { plan: [] }, { plan: { source: { kind: "branch" } } }, { plan: { source: { kind: "pr" }, filler: "x".repeat(3_500) } }]) {
      expect(verdict(() => COMMAND_PARSERS["eval-inbox-add"](body)), JSON.stringify(body).slice(0, 80)).toEqual(verdict(() => COMMAND_PARSERS["eval-start"](body)));
    }
    for (const kind of ["eval-inbox-start", "eval-inbox-dismiss"] as const) {
      // The relay's own id never names the entry.
      expect(verdict(() => COMMAND_PARSERS[kind]({ entry: "rec-1a2b3c4d", ...stamped }))).toEqual(ok({ entry: "rec-1a2b3c4d" }));
      expect(verdict(() => COMMAND_PARSERS[kind](stamped))).toEqual(bad("'entry' is required: the inbox entry's id"));
      expect(verdict(() => COMMAND_PARSERS[kind]({ entry: "../x" }))).toEqual(bad("'entry' must be an inbox entry's id; got '../x'"));
      expect(verdict(() => COMMAND_PARSERS[kind]({ entry: "a".repeat(65) }))).toEqual(bad(`'entry' must be an inbox entry's id; got '${"a".repeat(65)}'`));
    }
  });

  it("accepts an improver propose as a run id and a goal, and refuses anything else (#873)", () => {
    const stamped = { id: "3f9c1e2a-7b4d-4c1e-9a2b-1c2d3e4f5a6b", via: "remote" };
    const propose = COMMAND_PARSERS["eval-improve-propose"];
    // The relay's own id never names the run.
    expect(verdict(() => propose({ run: "eval-20261119-ab12", goal: "quality", ...stamped }))).toEqual(ok({ run: "eval-20261119-ab12", goal: "quality" }));
    expect(verdict(() => propose({ run: " backtest-3 ", goal: "cost" }))).toEqual(ok({ run: "backtest-3", goal: "cost" }));
    expect(verdict(() => propose({ run: "eval-1", goal: "speed" }))).toEqual(bad("'goal' must be one of quality, cost; got \"speed\""));
    expect(verdict(() => propose({ run: "eval-1" }))).toEqual(bad("'goal' must be one of quality, cost; got undefined"));
    expect(verdict(() => propose({ goal: "quality", ...stamped }))).toEqual(bad("'run' is required: the finished eval run's id"));
    for (const run of ["../x", "Eval-1", "-eval", "a".repeat(81), "eval 1"]) {
      expect(verdict(() => propose({ run, goal: "quality" })), run).toEqual(bad(`'run' must be an eval run's id; got '${run}'`));
    }
    expect(verdict(() => propose({ run: "a".repeat(80), goal: "cost" }))).toEqual(ok({ run: "a".repeat(80), goal: "cost" }));
  });

  it("accepts an open-pr as a proposal id as the improver makes it, and refuses anything else (#875)", () => {
    const stamped = { id: "3f9c1e2a-7b4d-4c1e-9a2b-1c2d3e4f5a6b", via: "remote" };
    const openPr = COMMAND_PARSERS["eval-proposal-open-pr"];
    // The relay's own id never names the proposal.
    expect(verdict(() => openPr({ proposal: " prop-1a2b3c4d ", ...stamped }))).toEqual(ok({ proposal: "prop-1a2b3c4d" }));
    expect(verdict(() => openPr(stamped))).toEqual(bad("'proposal' is required: the improver proposal's id"));
    expect(verdict(() => openPr({ proposal: " " }))).toEqual(bad("'proposal' is required: the improver proposal's id"));
    expect(verdict(() => openPr({ proposal: 3 }))).toEqual(bad("'proposal' must be a string"));
    for (const proposal of ["../x", "--project", "prop-1", "prop-1A2B3C4D", "prop-1a2b3c4d5", "rec-1a2b3c4d", "prop-1a2b 3c4"]) {
      expect(verdict(() => openPr({ proposal })), proposal).toEqual(bad(`'proposal' must be an improver proposal's id; got '${proposal}'`));
    }
  });

  it("accepts a check as exactly one of a relative test path or a command, trimmed", () => {
    expect(verdict(() => COMMAND_PARSERS["eval-set-check"]({ case: "loggd-12", test: " src/a.test.ts " }))).toEqual(ok({ case: "loggd-12", test: "src/a.test.ts" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-check"]({ case: "loggd-12", command: "bun x vitest run a" }))).toEqual(ok({ case: "loggd-12", command: "bun x vitest run a" }));
    // An empty field is absent, so the other one alone is the check.
    expect(verdict(() => COMMAND_PARSERS["eval-set-check"]({ case: "loggd-12", test: " ", command: "make check" }))).toEqual(ok({ case: "loggd-12", command: "make check" }));
    expect(verdict(() => COMMAND_PARSERS["eval-set-check"]({ case: "loggd-12", test: "x".repeat(500) }))).toEqual(ok({ case: "loggd-12", test: "x".repeat(500) }));
    const ONE = "a check needs exactly one of 'test' (a test file's path) or 'command' (a shell command)";
    const refused: [unknown, string][] = [
      [{ test: "a.test.ts" }, "'case' is required: the test-set case's id"],
      [{ case: "../x", test: "a.test.ts" }, "'case' must be a case id in lowercase kebab-case; got '../x'"],
      [{ case: "loggd-12" }, ONE],
      [{ case: "loggd-12", test: "", command: "  " }, ONE],
      [{ case: "loggd-12", test: "a.test.ts", command: "make check" }, ONE],
      [{ case: "loggd-12", test: 3 }, "'test' must be a string"],
      [{ case: "loggd-12", command: ["make"] }, "'command' must be a string"],
      [{ case: "loggd-12", test: "--x" }, "'test' may not start with --"],
      [{ case: "loggd-12", command: "--x" }, "'command' may not start with --"],
      [{ case: "loggd-12", test: "/etc/a.test.ts" }, "'test' must be a relative path with no .. segment; got '/etc/a.test.ts'"],
      [{ case: "loggd-12", test: "src/../../a.test.ts" }, "'test' must be a relative path with no .. segment; got 'src/../../a.test.ts'"],
      [{ case: "loggd-12", test: "x".repeat(501) }, "'test' is at most 500 characters"],
      [{ case: "loggd-12", command: "x".repeat(2001) }, "'command' is at most 2000 characters"],
    ];
    for (const [body, message] of refused) expect(verdict(() => COMMAND_PARSERS["eval-set-check"](body))).toEqual(bad(message));
  });
});
