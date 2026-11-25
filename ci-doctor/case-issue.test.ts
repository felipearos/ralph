// @vitest-environment node
/**
 * #159's acceptance criteria:
 *
 * - AC 1 — an issue the doctor creates for its own fix is never OFFERED to a
 *   coder, and one it files FOR coders is. Asserted against the real
 *   `frontier/next-tasks` classification, not against a label list. (Once
 *   claimed it does appear, in IN FLIGHT, as every claimed ticket does — that
 *   is what "never appears" has to mean, and the claimed case is pinned too.)
 * - AC 2 — a second filing for the same case finds the issue by its body
 *   marker. The marker tests carry no store at all, which is the point: the
 *   dedupe has to hold after the store is deleted.
 * - AC 3 — the doctor that loses the case lease files nothing and claims
 *   nothing.
 * - AC 4 — a second failed fix hands the issue to the coders, label AND claim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { cleanupFixtures, scratchProject } from "../dashboard/fixtures";

process.env.RALPH_PROJECT_OWNER = "felipearosr";
process.env.RALPH_PROJECT = scratchProject("case-issue");

import {
  attemptedFix,
  DOCTOR_CASE_LABELS,
  carriesCaseMarker,
  caseMarker,
  caseToken,
  CASE_LABEL,
  CODER_FILING_LABELS,
  countFailedFix,
  ensureCaseIssue,
  fileForCoders,
  filedCase,
  findCaseIssue,
  flagValue,
  handOffToCoders,
  issueBodyWithCaseMarker,
  markerKeyOf,
  issueNumberOf,
  knownIssue,
  readCaseIssue,
  recordFiled,
  recordHandedOff,
  UNREJECTABLE_PREFIXES,
  parkedOnCase,
  unrejectable,
  recordRejected,
  rejectedBuild,
  rejectedCase,
  runEnsure,
  runFixFailed,
  runReject,
  shouldHandOff,
  type CaseIssueIo,
  type CommandDeps,
  type StoreIo,
} from "./case-issue";
import { isRateLimited } from "../frontier/github-rate-limit";
import { CHECK_CASE_PREFIX } from "./classify";
import { takeCaseLease } from "./case-lease";
import { emptyStore, failureSignature, readStore, withStore, type Case } from "./store";
import { buildTickets, classify, type RawIssue } from "../frontier/next-tasks";
import type { Gh, Ran } from "./gate";

// The scratch projects this file registers with the fixtures; nothing drains
// them unless the suite says so (#271).
afterAll(cleanupFixtures);

const FLAKE = "flake:src/a.test.ts > flaps";
const T0 = Date.parse("2026-09-30T10:00:00.000Z");
const living = (): boolean => true;

const ok = (stdout = ""): Ran => ({ ok: true, stdout, stderr: "" });
const json = (value: unknown): Ran => ok(JSON.stringify(value));

interface Row {
  number: number;
  state: string;
  body: string;
  labels: { name: string }[];
}

const row = (number: number, key: string, labels: string[] = [CASE_LABEL], state = "OPEN"): Row => ({
  number,
  state,
  body: issueBodyWithCaseMarker("Diagnosis.", key),
  labels: labels.map((name) => ({ name })),
});

/** A `gh` that records every call and answers the search from `rows`. */
function fakeGh(over: { rows?: Row[]; view?: Row | null; created?: string; fail?: (args: string[]) => Ran | null } = {}): Gh & {
  calls: string[];
} {
  const calls: string[] = [];
  const gh = (async (args: string[]): Promise<Ran> => {
    calls.push(args.join(" "));
    const forced = over.fail?.(args);
    if (forced !== null && forced !== undefined) return forced;
    if (args[1] === "view") return json(over.view ?? null);
    if (args[1] === "list") return json(over.rows ?? []);
    if (args[1] === "create") return ok(over.created ?? "https://github.com/o/r/issues/412\n");
    return ok();
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}

function fakeClaim(answer: { claimed: boolean; refusal: string | null } = { claimed: true, refusal: null }): CaseIssueIo["claim"] & {
  calls: string[];
} {
  const calls: string[] = [];
  const claim = (async (issue: number, label: string) => {
    calls.push(`${issue} ${label}`);
    return answer;
  }) as CaseIssueIo["claim"] & { calls: string[] };
  claim.calls = calls;
  return claim;
}

function fakeLease(answer: { taken: boolean; holder: string | null } = { taken: true, holder: null }): CaseIssueIo["lease"] & {
  calls: string[];
} {
  const calls: string[] = [];
  const lease = (async (key: string) => {
    calls.push(key);
    return answer;
  }) as CaseIssueIo["lease"] & { calls: string[] };
  lease.calls = calls;
  return lease;
}

function fakeRelease(released = true): CaseIssueIo["release"] & { calls: number[] } {
  const calls: number[] = [];
  const release = (async (issue: number) => {
    calls.push(issue);
    return { released };
  }) as CaseIssueIo["release"] & { calls: number[] };
  release.calls = calls;
  return release;
}

const fakeIo = (over: Partial<CaseIssueIo> & { gh: Gh }): CaseIssueIo => ({
  claim: fakeClaim(),
  lease: fakeLease(),
  release: fakeRelease(),
  ...over,
});

const request = { key: FLAKE, title: "Flake: src/a.test.ts > flaps", body: "Diagnosis.", loop: "doc" };

describe("the case marker", () => {
  it("round-trips a key with a colon, a slash, spaces and a quote", () => {
    for (const key of [FLAKE, "regression:a/b/c.test.ts > does", 'flake:x.test.ts > reads "Blocked:" as a reason']) {
      expect(carriesCaseMarker(issueBodyWithCaseMarker("text", key), key)).toBe(true);
    }
  });

  it("identifies the case by a hash, not by the readable key", () => {
    // A case key is a test id, and test ids contain quotes — so the readable
    // half of the marker is not the identity and is never parsed back out.
    const quoted = 'flake:x.test.ts > reads "Blocked:" as a reason';
    expect(carriesCaseMarker(caseMarker(quoted), quoted)).toBe(true);
    expect(caseToken(quoted)).toMatch(/^ci-doctor-case-[0-9a-f]{16}$/);
    expect(caseToken(quoted)).not.toBe(caseToken(`${quoted} and more`));
  });

  it("leads the body, so a truncated read still shows it", () => {
    expect(issueBodyWithCaseMarker("text", FLAKE).startsWith(caseMarker(FLAKE))).toBe(true);
  });
});

describe("findCaseIssue", () => {
  it("searches the punctuation-free token in:body under the ci-health label", async () => {
    const gh = fakeGh({ rows: [row(7, FLAKE)] });
    // `markerKey` says WHICH of the asked keys the body carried — this one —
    // and the body comes back so a rekeyed case can be re-stamped (#237).
    expect(await findCaseIssue(FLAKE, { gh })).toMatchObject({ number: 7, state: "OPEN", labels: [CASE_LABEL], markerKey: FLAKE });
    expect(gh.calls[0]).toContain("--label ci-health");
    expect(gh.calls[0]).toContain(`"${caseToken(FLAKE)}" in:body`);
    expect(gh.calls).toHaveLength(1);
  });

  it("refuses a different case the search answered with", async () => {
    const gh = fakeGh({ rows: [row(7, `${FLAKE} and more`)] });
    expect(await findCaseIssue(FLAKE, { gh })).toBeNull();
  });

  it("says 'unreadable' rather than 'none' when gh failed or answered nonsense", async () => {
    // The distinction is the whole point: "none" licenses a create, and one
    // 403 would then file a duplicate for a case that already has an issue.
    const failed = fakeGh({ fail: () => ({ ok: false, stdout: "", stderr: "boom" }) });
    expect(await findCaseIssue(FLAKE, { gh: failed })).toBe("unreadable");
    const garbage = fakeGh({ fail: () => ok("not json") });
    expect(await findCaseIssue(FLAKE, { gh: garbage })).toBe("unreadable");
    const notAList = fakeGh({ fail: () => json({ number: 1 }) });
    expect(await findCaseIssue(FLAKE, { gh: notAList })).toBe("unreadable");
  });

  it("drops a row with no number rather than inventing one", async () => {
    const gh = fakeGh({ fail: () => json([{ state: "OPEN", labels: [], body: caseMarker(FLAKE) }]) });
    expect(await findCaseIssue(FLAKE, { gh })).toBeNull();
  });
});

describe("an issue whose marker is the key a #237 rekey moved the case off", () => {
  const OLD = "flake:flaps";
  const NEW = "flake:src/a.test.ts > flaps";
  const req = { key: NEW, title: "t", body: "Diagnosis.", loop: "doc", filedAs: OLD };

  /**
   * A `gh` whose SEARCH behaves like GitHub's: a row comes back only for the
   * token actually asked for. `fakeGh` answers every `list` with every row,
   * which cannot show that the old token is what found this issue.
   */
  const byToken = (rows: Row[]): Gh & { calls: string[] } =>
    fakeGh({
      fail: (args) => {
        if (args[1] !== "list") return null;
        const search = args.join(" ");
        return json(rows.filter((candidate) => search.includes(caseToken(markerKeyOf(candidate.body, [OLD, NEW]) ?? ""))));
      },
    });

  it("is found by the old key's token rather than filed a second time", async () => {
    // AC 2. Without `filedAs` the search for the new token returns nothing and
    // `ensure` creates a duplicate beside the open issue.
    const gh = byToken([row(412, OLD)]);
    const result = await ensureCaseIssue(req, fakeIo({ gh, claim: fakeClaim() }));
    expect(result).toMatchObject({ issue: 412, created: false, restamped: true });
    // Two searches, the current key first: the old token is only worth a call
    // when the current one found nothing.
    const searches = gh.calls.filter((call) => call.includes("in:body"));
    expect(searches).toHaveLength(2);
    expect(searches[0]).toContain(caseToken(NEW));
    expect(searches[1]).toContain(caseToken(OLD));
  });

  it("is re-stamped with the new key's marker, so the next search needs no store", async () => {
    const gh = byToken([row(412, OLD)]);
    await ensureCaseIssue(req, fakeIo({ gh, claim: fakeClaim() }));
    const edit = gh.calls.find((call) => call.startsWith("issue edit"));
    expect(edit).toContain(caseToken(NEW));
    // The old marker stays: a doctor on an older deploy still has to find it,
    // and a second token costs the search nothing.
    expect(edit).toContain(caseToken(OLD));
  });

  it("is re-stamped once and not again, because the new marker then matches first", async () => {
    const gh = fakeGh({ rows: [row(412, NEW)] });
    const result = await ensureCaseIssue(req, fakeIo({ gh, claim: fakeClaim() }));
    expect(result).toMatchObject({ issue: 412, restamped: false });
    expect(gh.calls.some((call) => call.startsWith("issue edit"))).toBe(false);
  });

  it("is found through the store's remembered number too, marker and all", async () => {
    const gh = fakeGh({ view: row(412, OLD) });
    expect(await readCaseIssue(412, NEW, { gh }, OLD)).toMatchObject({ number: 412, markerKey: OLD });
    // And a body carrying NEITHER key is still somebody else's issue.
    const other = fakeGh({ view: row(412, "flake:elsewhere > t") });
    expect(await readCaseIssue(412, NEW, { gh: other }, OLD)).toBeNull();
  });

  it("files for the coders against the same issue rather than a second ticket", async () => {
    const gh = byToken([row(412, OLD, [CASE_LABEL])]);
    const result = await fileForCoders(req, fakeIo({ gh, release: fakeRelease() }));
    expect(result).toMatchObject({ issue: 412, created: false });
    expect(gh.calls.some((call) => call.startsWith("issue create"))).toBe(false);
    expect(gh.calls.find((call) => call.startsWith("issue edit"))).toContain(caseToken(NEW));
  });
});

describe("readCaseIssue", () => {
  it("accepts the store's number when the marker still matches", async () => {
    const gh = fakeGh({ view: row(412, FLAKE) });
    expect(await readCaseIssue(412, FLAKE, { gh })).toMatchObject({ number: 412 });
  });

  it("rejects the store's number when the marker does not", async () => {
    const gh = fakeGh({ view: row(412, "regression:other > thing") });
    expect(await readCaseIssue(412, FLAKE, { gh })).toBeNull();
  });

  it("falls through to the search when the remembered issue cannot be read at all", async () => {
    // A number the cache remembers that 404s must not wedge the case: the
    // issue may be gone, and "could not tell" would refuse every `ensure`
    // until a human edited the cache.
    const gh = fakeGh({ fail: (args) => (args[1] === "view" ? { ok: false, stdout: "", stderr: "404" } : null) });
    expect(await readCaseIssue(412, FLAKE, { gh })).toBeNull();
  });
});

describe("ensureCaseIssue", () => {
  it("creates one ci-health issue with no ready-for-agent and no wip, then claims it", async () => {
    const gh = fakeGh();
    const claim = fakeClaim();
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim }))).toEqual({
      kind: "claimed",
      issue: 412,
      created: true,
      claimed: true,
      refusal: null,
    });
    const creates = gh.calls.filter((call) => call.includes("issue create"));
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--label ci-health");
    expect(creates[0]).not.toContain("ready-for-agent");
    expect(creates[0]).not.toContain("-wip");
    expect(creates[0]).toContain(caseToken(FLAKE));
    expect(claim.calls).toEqual(["412 doc-wip"]);
  });

  it("finds the existing issue by marker instead of creating a second one", async () => {
    // AC 2, with no store in this test at all: the identity is on GitHub, so
    // it holds after the store is deleted.
    const gh = fakeGh({ rows: [row(412, FLAKE)] });
    const claim = fakeClaim();
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim }))).toEqual({
      kind: "claimed",
      issue: 412,
      created: false,
      claimed: true,
      refusal: null,
      restamped: false,
    });
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(0);
    expect(claim.calls).toEqual(["412 doc-wip"]);
  });

  it("prefers the number the store remembers, without searching", async () => {
    const gh = fakeGh({ view: row(412, FLAKE) });
    expect(await ensureCaseIssue({ ...request, known: 412 }, fakeIo({ gh }))).toMatchObject({
      issue: 412,
      created: false,
    });
    expect(gh.calls.filter((call) => call.includes("issue list"))).toHaveLength(0);
  });

  it("falls through to the search when the remembered number is not this case", async () => {
    const gh = fakeGh({ view: row(99, "regression:other > thing"), rows: [row(412, FLAKE)] });
    expect(await ensureCaseIssue({ ...request, known: 99 }, fakeIo({ gh }))).toMatchObject({ issue: 412 });
  });

  it("files nothing when GitHub could not be read", async () => {
    const gh = fakeGh({ fail: (args) => (args[1] === "list" ? { ok: false, stdout: "", stderr: "403" } : null) });
    const claim = fakeClaim();
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim }))).toEqual({
      kind: "unreadable",
      issue: null,
      created: false,
      claimed: false,
      refusal: "GitHub could not be read for this case",
    });
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(0);
    expect(claim.calls).toEqual([]);
  });

  it("reopens a closed issue for a case that has recurred", async () => {
    const gh = fakeGh({ rows: [row(412, FLAKE, [CASE_LABEL], "CLOSED")] });
    expect(await ensureCaseIssue(request, fakeIo({ gh }))).toMatchObject({ issue: 412, created: false });
    expect(gh.calls).toContain("issue reopen 412");
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(0);
  });

  it("passes a lost claim race through as a refusal rather than throwing", async () => {
    const gh = fakeGh();
    const claim = fakeClaim({ claimed: false, refusal: "lease held by run x" });
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim }))).toEqual({
      kind: "refused",
      issue: 412,
      created: true,
      claimed: false,
      refusal: "lease held by run x",
    });
  });

  it("creates nothing and claims nothing when another doctor holds the case", async () => {
    // AC 3. The marker search cannot settle this — both doctors would read an
    // empty registry and both create — so the lease decides first, inside the
    // store's lock, and this path reaches GitHub not at all.
    const gh = fakeGh();
    const claim = fakeClaim();
    const lease = fakeLease({ taken: false, holder: "doc run other" });
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim, lease }))).toEqual({
      kind: "held",
      issue: null,
      created: false,
      claimed: false,
      refusal: "the case is held by doc run other",
    });
    expect(gh.calls).toEqual([]);
    expect(claim.calls).toEqual([]);
    expect(lease.calls).toEqual([FLAKE]);
  });

  it("neither creates nor re-claims an issue this doctor already holds", async () => {
    const gh = fakeGh({ rows: [row(412, FLAKE, [CASE_LABEL, "doc-wip"])] });
    const claim = fakeClaim();
    expect(await ensureCaseIssue(request, fakeIo({ gh, claim }))).toEqual({
      kind: "claimed",
      issue: 412,
      created: false,
      claimed: true,
      refusal: null,
      restamped: false,
    });
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(0);
    expect(claim.calls).toEqual([]);
  });

  it("throws when the created issue's number cannot be read", async () => {
    const gh = fakeGh({ created: "created something somewhere\n" });
    await expect(ensureCaseIssue(request, fakeIo({ gh }))).rejects.toThrow(/could not read the new issue number/);
  });

  it("throws gh's stderr when the create fails", async () => {
    const gh = fakeGh({ fail: (args) => (args[1] === "create" ? { ok: false, stdout: "", stderr: "no label" } : null) });
    await expect(ensureCaseIssue(request, fakeIo({ gh }))).rejects.toThrow(/no label/);
  });

  it("raises a throttle as its own error, so the caller can wait rather than stop", async () => {
    const gh = fakeGh({
      fail: (args) =>
        args[1] === "create" ? { ok: false, stdout: "", stderr: "API rate limit exceeded (HTTP 403)" } : null,
    });
    await expect(ensureCaseIssue(request, fakeIo({ gh }))).rejects.toSatisfy(isRateLimited);
  });
});

describe("fileForCoders", () => {
  it("files with ci-health, ready-for-agent and bug", async () => {
    const gh = fakeGh();
    expect(
      await fileForCoders({ key: "regression:a > b", title: "t", body: "b" }, { gh, release: fakeRelease() }),
    ).toEqual({ issue: 412, created: true, opened: true });
    const created = gh.calls.find((call) => call.includes("issue create")) ?? "";
    for (const label of CODER_FILING_LABELS) expect(created).toContain(`--label ${label}`);
  });

  it("dedupes on the marker too", async () => {
    const gh = fakeGh({ rows: [row(99, "regression:a > b", [...CODER_FILING_LABELS])] });
    expect(
      await fileForCoders({ key: "regression:a > b", title: "t", body: "b" }, { gh, release: fakeRelease() }),
    ).toEqual({ issue: 99, created: false, opened: false });
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(0);
    // Already the coders': nothing to open, so nothing is edited.
    expect(gh.calls.filter((call) => call.includes("issue edit"))).toHaveLength(0);
  });

  it("files nothing when GitHub could not be read", async () => {
    const gh = fakeGh({ fail: () => ({ ok: false, stdout: "", stderr: "403" }) });
    expect(
      await fileForCoders({ key: "regression:a > b", title: "t", body: "b" }, { gh, release: fakeRelease() }),
    ).toEqual({ issue: null, created: false, opened: false });
  });
});

describe("handOffToCoders", () => {
  /** One ordered log, so the order the comments argue for is the order asserted. */
  const logged = (): { gh: Gh & { calls: string[] }; release: CaseIssueIo["release"]; log: string[] } => {
    const log: string[] = [];
    const gh = (async (args: string[]): Promise<Ran> => {
      log.push(`gh ${args.join(" ")}`);
      return ok();
    }) as Gh & { calls: string[] };
    gh.calls = log;
    const release = (async (issue: number) => {
      log.push(`release ${issue}`);
      return { released: true };
    }) as CaseIssueIo["release"];
    return { gh, release, log };
  };

  it("comments the findings, releases the claim, then relabels", async () => {
    const { gh, release, log } = logged();
    expect(
      await handOffToCoders(
        { issue: 412, loop: "doc", findings: "What I tried.", labels: [CASE_LABEL, "doc-wip"] },
        { gh, release },
      ),
    ).toEqual({ handedOff: true });
    // The release comes BEFORE the relabel because either order can be
    // interrupted and only this one fails safe: still wearing its claim label,
    // the ticket stays hidden and the hand-off can be run again.
    expect(log).toEqual([
      "gh issue comment 412 --body What I tried.",
      "release 412",
      "gh issue edit 412 --remove-label doc-wip --add-label ready-for-agent --add-label bug",
    ]);
  });

  it("removes the stuck label and only the labels the issue carries", async () => {
    // `gh` 404s on removing a label that is not there, and a ticket left
    // wearing `-blocked` is dropped by the frontier however ready it looks.
    const { gh, log } = logged();
    const release = fakeRelease();
    await handOffToCoders(
      { issue: 412, loop: "doc", findings: "f", labels: [CASE_LABEL, "doc-blocked", "bug"] },
      { gh, release },
    );
    expect(log).toEqual([
      "gh issue comment 412 --body f",
      "gh issue edit 412 --remove-label doc-blocked --add-label ready-for-agent",
    ]);
    // Not this run's claim to release: no `doc-wip` was on it.
    expect(release.calls).toEqual([]);
  });

  it("throws rather than reporting a hand-off the edit did not make", async () => {
    const gh = fakeGh({ fail: (args) => (args[1] === "edit" ? { ok: false, stdout: "", stderr: "404" } : null) });
    const release = fakeRelease();
    await expect(
      handOffToCoders({ issue: 412, loop: "doc", findings: "f", labels: [CASE_LABEL, "doc-wip"] }, { gh, release }),
    ).rejects.toThrow(/404/);
    expect(await handOffToCoders({ issue: 412, loop: "doc", findings: "f", labels: [...CODER_FILING_LABELS] }, {
      gh: fakeGh(),
      release: fakeRelease(),
    })).toEqual({ handedOff: false });
  });
});

const seen = (build: number): Case["evidence"][number] => ({
  build,
  branch: "pr-branch",
  commit: `c${build}`,
  kind: "assertion",
  line: `FAIL a.test.ts > flaps (build ${build})`,
});

const confirmed = (): Case => ({
  kind: "flake",
  state: "confirmed",
  evidence: [],
  cost72h: { redBuilds: 0, mainReds: 0, dequeues: 0 },
  issue: null,
  pr: null,
  fixAttempts: 0,
  unparks: {},
});

describe("parkedOnCase", () => {
  const withCases = (cases: Record<string, Case>) => ({ ...emptyStore(), cases });

  it("finds the parked tickets whose rule is this case's subject, in order", () => {
    const store = withCases({
      [FLAKE]: confirmed(),
      "parked:1557": { ...confirmed(), kind: "parked", rule: "src/a.test.ts > flaps" },
      "parked:1402": { ...confirmed(), kind: "parked", rule: "src/a.test.ts > flaps" },
      "parked:1900": { ...confirmed(), kind: "parked", rule: "src/other.test.ts > x" },
      // A non-parked case naming the same subject is not a parked ticket.
      "regression:src/a.test.ts > flaps": { ...confirmed(), kind: "regression", rule: "src/a.test.ts > flaps" },
    });
    expect(parkedOnCase(store, FLAKE)).toEqual([1402, 1557]);
  });

  it("is empty for a key that is not a flake, however its subject matches", () => {
    // `actionable` looks a parked ticket up as `flake:<testId>`, so rejecting
    // the `regression:` case of the same subject leaves the flake case alone
    // and priority 4 may still unpark these tickets. Claiming otherwise would
    // print a false warning.
    const store = withCases({
      "parked:1557": { ...confirmed(), kind: "parked", rule: "src/a.test.ts > flaps" },
    });
    expect(parkedOnCase(store, "regression:src/a.test.ts > flaps")).toEqual([]);
    expect(parkedOnCase(store, FLAKE)).toEqual([1557]);
  });

  it("is empty for a case nothing is parked on, and for a parked case with no rule", () => {
    expect(parkedOnCase(withCases({ [FLAKE]: confirmed() }), FLAKE)).toEqual([]);
    const noRule = withCases({ "parked:1557": { ...confirmed(), kind: "parked", rule: null } });
    expect(parkedOnCase(noRule, FLAKE)).toEqual([]);
  });
});

describe("the case transitions", () => {
  it("files without mutating its input", () => {
    const before = confirmed();
    expect(filedCase(before, 412)).toMatchObject({ issue: 412, state: "filed" });
    expect(before.issue).toBeNull();
    expect(before.state).toBe("confirmed");
  });

  it("counts a fix attempt and hands off on the second", () => {
    const one = attemptedFix(confirmed());
    expect(one.fixAttempts).toBe(1);
    expect(shouldHandOff(one)).toBe(false);
    const two = attemptedFix(one);
    expect(two.fixAttempts).toBe(2);
    expect(shouldHandOff(two)).toBe(true);
  });

  it("rejects to `retired`, as of the newest build it has evidence for", () => {
    const before: Case = { ...confirmed(), issue: 412, pr: 7, fixAttempts: 1, evidence: [seen(90), seen(104), seen(97)] };
    const after = rejectedCase(before, "the file is gone from main", "2026-10-07T08:00:00.000Z");
    expect(after).toMatchObject({
      state: "retired",
      rejectedAt: { build: 104, at: "2026-10-07T08:00:00.000Z", reason: "the file is gone from main" },
    });
    // What later stages own survives a rejection: it is not a reset.
    expect(after).toMatchObject({ issue: 412, pr: 7, fixAttempts: 1 });
    expect(before.state).toBe("confirmed");
    expect(before.rejectedAt).toBeUndefined();
  });

  it("takes a case with no evidence as of build 0, so any build is newer", () => {
    // The boundary fails OPEN here on purpose: a rejection that could never be
    // overtaken would bury a case the next red build genuinely re-opens.
    expect(rejectedBuild(confirmed())).toBe(0);
    expect(rejectedCase(confirmed(), "why", "2026-10-07T08:00:00.000Z").rejectedAt).toMatchObject({ build: 0 });
  });

  it("records the DISTINCT failure signatures of its evidence (#57)", () => {
    const row = (build: number, line: string): Case["evidence"][number] => ({ ...seen(build), line });
    const before: Case = {
      ...confirmed(),
      evidence: [
        // Two rows differing only in a timestamp: one signature.
        row(101, "error: XX000 database unreachable at 2026-11-21T01:00:00.000Z"),
        row(102, "error: XX000 database unreachable at 2026-11-22T03:15:42.000Z"),
        // A different error code: a second one.
        row(103, "error: 08006 connection reset"),
      ],
    };
    const signatures = rejectedCase(before, "the database is down", "2026-11-22T08:00:00.000Z").rejectedAt?.signatures;
    expect(signatures).toEqual([
      failureSignature("assertion", "error: XX000 database unreachable at 2026-11-21T01:00:00.000Z"),
      failureSignature("assertion", "error: 08006 connection reset"),
    ]);
    expect(rejectedCase(confirmed(), "why", "2026-10-07T08:00:00.000Z").rejectedAt?.signatures).toEqual([]);
  });
});

describe("issueNumberOf", () => {
  it("reads the number off the printed URL", () => {
    expect(issueNumberOf("https://github.com/o/r/issues/412\n")).toBe(412);
    expect(issueNumberOf("")).toBeNull();
  });
});

describe("AC 1 — what a coder's frontier offers", () => {
  const issue = (number: number, labels: string[]): RawIssue => ({
    number,
    title: `case ${number}`,
    body: "## What to build\n\nFix it.\n",
    labels: labels.map((name) => ({ name })),
    assignees: [],
    author: { login: "felipearosr" },
    comments: [],
  });

  const buckets = (raw: RawIssue[]) => {
    const frontier = classify(buildTickets(raw, raw.map(() => [])), []);
    const numbers = (tickets: { number: number }[]): number[] => tickets.map((ticket) => ticket.number);
    return {
      ready: numbers(frontier.readyTasks),
      offered: [...numbers(frontier.readyTasks), ...frontier.orderedGroups.flatMap((group) => numbers(group.members))],
      elsewhere: [
        ...numbers(frontier.inFlight),
        ...numbers(frontier.blocked),
        ...numbers(frontier.specs),
        ...numbers(frontier.occluded),
      ],
    };
  };

  it("never offers the doctor's own case issue, and offers the one filed for coders", () => {
    // Asserted through the real classification rather than against a label
    // list, because the label list is the thing under test: what decides is
    // `frontier/next-tasks.ts`'s own predicate.
    const before = buckets([issue(500, [...DOCTOR_CASE_LABELS]), issue(501, [...CODER_FILING_LABELS])]);
    expect(before.offered).toContain(501);
    expect(before.offered).not.toContain(500);
    // Before the claim it is in no bucket a coder reads at all.
    expect(before.elsewhere).not.toContain(500);
  });

  it("still never offers it once the claim is on it", () => {
    // Claimed, it shows in IN FLIGHT, as every claimed ticket does — which is
    // the only reading of "never appears in --dry-run" that any label scheme
    // can satisfy, including the one the issue prescribes.
    const after = buckets([issue(500, [...DOCTOR_CASE_LABELS, "ralph-wip"])]);
    expect(after.offered).not.toContain(500);
    expect(after.ready).not.toContain(500);
  });

  it("AC 4 — offers the ticket once the hand-off's labels are on it", async () => {
    // The criterion is that a CODER takes it, and `classify` is what decides
    // that. Driven from the labels `handOffToCoders` actually writes, so the
    // label set and the frontier's verdict on it cannot drift apart.
    const before = [CASE_LABEL, "doc-wip", "doc-blocked"];
    const log: string[] = [];
    const gh = (async (args: string[]) => {
      log.push(args.join(" "));
      return ok();
    }) as Gh;
    await handOffToCoders({ issue: 500, loop: "doc", findings: "f", labels: before }, { gh, release: fakeRelease() });
    const edit = log.find((call) => call.includes("issue edit")) ?? "";
    const after = before
      .filter((label) => !edit.includes(`--remove-label ${label}`))
      .concat([...edit.matchAll(/--add-label (\S+)/g)].map((match) => match[1] as string));
    expect(buckets([issue(500, after)]).offered).toContain(500);
  });
});

describe("the store side", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const storeIo = (): StoreIo => {
    const dir = mkdtempSync(join(tmpdir(), "case-issue-"));
    dirs.push(dir);
    return { path: join(dir, "ralph", "ci-health.json"), with: withStore, read: readStore };
  };

  const seed = async (store: StoreIo, key: string, value: Case): Promise<void> => {
    await store.with(store.path, (open) => {
      open.cases[key] = value;
    });
  };

  const caseOf = async (store: StoreIo, key: string): Promise<Case | undefined> =>
    store.with(store.path, (open) => structuredClone(open.cases[key]));

  it("records the filing on the case", async () => {
    const store = storeIo();
    await seed(store, FLAKE, confirmed());
    expect(await recordFiled(FLAKE, 412, store)).toBe(true);
    expect(await caseOf(store, FLAKE)).toMatchObject({ issue: 412, state: "filed" });
    expect(await knownIssue(FLAKE, store)).toBe(412);
  });

  it("records the rejection, its reason and its boundary on the case", async () => {
    const store = storeIo();
    await seed(store, FLAKE, { ...confirmed(), evidence: [seen(90), seen(104)] });
    expect(await recordRejected(FLAKE, "a ratchet, not a flake", store, "2026-10-07T08:00:00.000Z")).toEqual({ build: 104, parked: [] });
    expect(await caseOf(store, FLAKE)).toMatchObject({
      state: "retired",
      rejectedAt: { build: 104, at: "2026-10-07T08:00:00.000Z", reason: "a ratchet, not a flake" },
    });
  });

  it("re-rejecting is harmless and does not move the boundary backwards", async () => {
    const store = storeIo();
    await seed(store, FLAKE, { ...confirmed(), evidence: [seen(104)] });
    expect(await recordRejected(FLAKE, "first", store, "2026-10-07T08:00:00.000Z")).toMatchObject({ build: 104 });
    expect(await recordRejected(FLAKE, "second", store, "2026-10-07T09:00:00.000Z")).toMatchObject({ build: 104 });
    expect(await caseOf(store, FLAKE)).toMatchObject({ rejectedAt: { build: 104, reason: "second" } });
  });

  it("names the coders' tickets a rejection leaves parked", async () => {
    // `actionable` unparks only a `confirmed` or `fixed` case, so a rejection
    // unparks nobody. Usually right — the failure is the branch's own — but it
    // must never be silent: parked tickets starving their loops is a failure
    // this project has already had.
    const store = storeIo();
    await seed(store, FLAKE, confirmed());
    await seed(store, "parked:1557", { ...confirmed(), kind: "parked", state: "candidate", rule: "src/a.test.ts > flaps" });
    await seed(store, "parked:1402", { ...confirmed(), kind: "parked", state: "candidate", rule: "src/other.test.ts > x" });
    const done = await recordRejected(FLAKE, "a ratchet", store, "2026-10-07T08:00:00.000Z");
    expect(done?.parked).toEqual([1557]);
  });

  it("reports a rejection of a case the store has lost rather than inventing one", async () => {
    const store = storeIo();
    expect(await recordRejected(FLAKE, "why", store)).toBeNull();
    expect(await caseOf(store, FLAKE)).toBeUndefined();
  });

  it("reports a case the store has lost rather than inventing one", async () => {
    // The store is a cache; a filing it cannot remember is not a fault, and
    // the next scan rebuilds the case.
    const store = storeIo();
    expect(await recordFiled(FLAKE, 412, store)).toBe(false);
    expect(await caseOf(store, FLAKE)).toBeUndefined();
    expect(await knownIssue(FLAKE, store)).toBeNull();
  });

  it("marks a coder filing handed-off", async () => {
    const store = storeIo();
    await seed(store, FLAKE, confirmed());
    expect(await recordHandedOff(FLAKE, 99, store)).toBe(true);
    expect(await caseOf(store, FLAKE)).toMatchObject({ issue: 99, state: "handed-off" });
  });

  it("hands off on the second failed fix and not the first", async () => {
    const store = storeIo();
    await seed(store, FLAKE, { ...confirmed(), issue: 412, state: "filed" });
    expect(await countFailedFix(FLAKE, store)).toEqual({ attempts: 1, handedOff: false, issue: 412 });
    expect(await countFailedFix(FLAKE, store)).toEqual({ attempts: 2, handedOff: true, issue: 412 });
    expect(await caseOf(store, FLAKE)).toMatchObject({ fixAttempts: 2 });
  });

  it("throws on a case the gate never wrote, rather than counting from zero forever", async () => {
    const store = storeIo();
    await expect(countFailedFix(FLAKE, store)).rejects.toThrow(/no case flake:/);
  });

  it("AC 3 — two doctors over the real lease end with one issue and one claim", async () => {
    const store = storeIo();
    const seen: Row[] = [];
    const gh = fakeGh({ rows: seen });
    const claimed: string[] = [];
    const claim = (async (issue: number, label: string) => {
      if (claimed.length > 0) return { claimed: false, refusal: `lease held for issue #${issue}` };
      claimed.push(`${issue} ${label}`);
      return { claimed: true, refusal: null };
    }) as CaseIssueIo["claim"];
    const lease = (run: string): CaseIssueIo["lease"] => async (key) => {
      const taken = await takeCaseLease(store.path, key, { run, loop: "doc" }, { nowMs: T0, alive: living });
      return { taken: taken.taken, holder: taken.holder === null ? null : taken.holder.run };
    };

    const first = await ensureCaseIssue(request, fakeIo({ gh, claim, lease: lease("run-a") }));
    if (first.issue !== null && first.created) seen.push(row(first.issue, FLAKE));
    const before = gh.calls.length;
    const second = await ensureCaseIssue(request, fakeIo({ gh, claim, lease: lease("run-b") }));

    expect(first).toMatchObject({ issue: 412, created: true, claimed: true });
    // Only the lease can produce this: the loser reaches neither GitHub nor
    // the claim, so it is stopped before it can file or adopt anything.
    expect(second).toMatchObject({ issue: null, created: false, claimed: false });
    expect(second.refusal).toContain("run-a");
    expect(gh.calls).toHaveLength(before);
    expect(gh.calls.filter((call) => call.includes("issue create"))).toHaveLength(1);
    expect(claimed).toEqual(["412 doc-wip"]);
  });

  describe("the CLI's wiring", () => {
    const deps = (store: StoreIo, io: CaseIssueIo): CommandDeps & { lines: string[] } => {
      const lines: string[] = [];
      return { io, store, loop: "doc", out: (line) => lines.push(line), err: (line) => lines.push(line), lines };
    };

    it("ensure records the filing and reports the issue", async () => {
      const store = storeIo();
      await seed(store, FLAKE, confirmed());
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      expect(await runEnsure([FLAKE, "--title", "t", "--body", "b"], wired)).toBe(0);
      expect(await caseOf(store, FLAKE)).toMatchObject({ issue: 412, state: "filed" });
      expect(wired.lines.join("\n")).toContain("#412 created and claimed");
    });

    it("ensure exits 3 on a refused claim but still records the issue it created", async () => {
      // The number is this case's for good. Not recording it would send the
      // next `ensure` to the search alone, against an index that may not have
      // caught up — the duplicate `known` exists to prevent.
      const store = storeIo();
      await seed(store, FLAKE, confirmed());
      const wired = deps(store, fakeIo({ gh: fakeGh(), claim: fakeClaim({ claimed: false, refusal: "held" }) }));
      expect(await runEnsure([FLAKE, "--title", "t", "--body", "b"], wired)).toBe(3);
      expect(await caseOf(store, FLAKE)).toMatchObject({ issue: 412 });
    });

    it("ensure exits 1, not 3, when GitHub could not be read", async () => {
      const store = storeIo();
      await seed(store, FLAKE, confirmed());
      const gh = fakeGh({ fail: (args) => (args[1] === "list" ? { ok: false, stdout: "", stderr: "403" } : null) });
      const wired = deps(store, fakeIo({ gh }));
      expect(await runEnsure([FLAKE, "--title", "t", "--body", "b"], wired)).toBe(1);
      expect(await caseOf(store, FLAKE)).toMatchObject({ issue: null });
    });

    it("reject retires the case and names the boundary it was taken as of", async () => {
      const store = storeIo();
      await seed(store, FLAKE, { ...confirmed(), evidence: [seen(104)] });
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      expect(await runReject([FLAKE, "--reason", "#2166 deleted the file from main"], wired)).toBe(0);
      expect(await caseOf(store, FLAKE)).toMatchObject({
        state: "retired",
        rejectedAt: { build: 104, reason: "#2166 deleted the file from main" },
      });
      expect(wired.lines.join("\n")).toContain("rejected as of build 104");
    });

    it("recordRejected enforces the refusal itself, not just the CLI wrapper", async () => {
      // Both it and `rejectedCase` are exported and `gate.ts` writes cases in
      // process, so the invariant cannot live only in `runReject`.
      const store = storeIo();
      await seed(store, "parked:1557", { ...confirmed(), kind: "parked", rule: "src/a.test.ts > flaps" });
      await expect(recordRejected("parked:1557", "why", store)).rejects.toThrow(/nothing could ever lift/);
      expect(await caseOf(store, "parked:1557")).toMatchObject({ state: "confirmed" });
      expect(unrejectable(FLAKE)).toBeUndefined();
      // The guard and the delete sweep must key on one constant, not two.
      expect(UNREJECTABLE_PREFIXES).toContain(CHECK_CASE_PREFIX);
    });

    it("reject refuses a case the scan never re-proposes, so no rejection can be unliftable", async () => {
      // `infra:check:` evidence is written with `build: 0` by
      // `checkIncidents`, the delete sweep skips the prefix and the gate's
      // check merge preserves `...prev` — so a rejected check case could never
      // be lifted, and the gate would report "CI is healthy" through a live
      // outage. `parked:` is rewritten from scratch every poll, so a rejection
      // there is erased rather than honoured.
      const store = storeIo();
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      for (const prefix of UNREJECTABLE_PREFIXES) {
        await expect(runReject([`${prefix}whatever`, "--reason", "not ours"], wired)).rejects.toThrow(
          /nothing could ever lift the rejection/,
        );
      }
      // Refused before the reason is even read, so a mistyped key cannot write.
      await expect(runReject(["parked:1557"], wired)).rejects.toThrow(/nothing could ever lift the rejection/);
    });

    it("reject warns, but does not refuse, when it leaves a coder's ticket parked", async () => {
      const store = storeIo();
      await seed(store, FLAKE, { ...confirmed(), evidence: [seen(104)] });
      await seed(store, "parked:1557", { ...confirmed(), kind: "parked", state: "candidate", rule: "src/a.test.ts > flaps" });
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      expect(await runReject([FLAKE, "--reason", "a ratchet"], wired)).toBe(0);
      expect(wired.lines.join("\n")).toContain("#1557 stay parked");
      expect(await caseOf(store, FLAKE)).toMatchObject({ state: "retired" });
    });

    it("reject refuses a reason that is absent, empty or only whitespace", async () => {
      // AC 3 asks for the reason in the journal. A blank one would leave a
      // case inert with nothing on it saying why, which is worse than a refusal.
      const store = storeIo();
      await seed(store, FLAKE, confirmed());
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      await expect(runReject([FLAKE], wired)).rejects.toThrow(/--reason/);
      await expect(runReject([FLAKE, "--reason", ""], wired)).rejects.toThrow(/non-empty --reason/);
      await expect(runReject([FLAKE, "--reason", "   "], wired)).rejects.toThrow(/non-empty --reason/);
      expect(await caseOf(store, FLAKE)).toMatchObject({ state: "confirmed" });
    });

    it("reject exits 1 on a case the store has lost, writing nothing", async () => {
      const store = storeIo();
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      expect(await runReject([FLAKE, "--reason", "why"], wired)).toBe(1);
      expect(wired.lines.join("\n")).toContain("no case");
      expect(await caseOf(store, FLAKE)).toBeUndefined();
    });

    it("fix-failed validates its argv before it spends an attempt", async () => {
      // Two mistyped invocations must not hand a ticket over with no fix tried.
      const store = storeIo();
      await seed(store, FLAKE, { ...confirmed(), issue: 412, state: "filed" });
      const wired = deps(store, fakeIo({ gh: fakeGh() }));
      await expect(runFixFailed([FLAKE], wired)).rejects.toThrow(/--findings/);
      expect(await caseOf(store, FLAKE)).toMatchObject({ fixAttempts: 0 });
    });

    it("fix-failed counts the first and hands over on the second, claim and all", async () => {
      const store = storeIo();
      await seed(store, FLAKE, { ...confirmed(), issue: 412, state: "filed" });
      const gh = fakeGh({ view: row(412, FLAKE, [CASE_LABEL, "doc-wip"]) });
      const release = fakeRelease();
      const wired = deps(store, fakeIo({ gh, release }));
      expect(await runFixFailed([FLAKE, "--findings", "tried x"], wired)).toBe(0);
      expect(gh.calls).toEqual([]);
      expect(await runFixFailed([FLAKE, "--findings", "tried y"], wired)).toBe(0);
      expect(gh.calls.some((call) => call.includes("--add-label ready-for-agent"))).toBe(true);
      expect(gh.calls.some((call) => call.includes("--remove-label doc-wip"))).toBe(true);
      expect(release.calls).toEqual([412]);
      expect(await caseOf(store, FLAKE)).toMatchObject({ state: "handed-off", fixAttempts: 2 });
    });
  });
});

describe("flagValue", () => {
  it("reads a value and refuses a flag standing in for one", () => {
    expect(flagValue(["--title", "t"], "--title")).toBe("t");
    expect(flagValue(["--title"], "--body")).toBeNull();
    expect(() => flagValue(["--title", "--body", "b"], "--title")).toThrow(/--title needs a value/);
  });
});
