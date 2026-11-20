// @vitest-environment node
import { describe, expect, it } from "vitest";

import { VERIFIER_RULE_DEFAULTS } from "../contracts";
import { formFromView, formProblems, rulesFromForm, saveNotice, switchRules, type VerifierForm } from "./verifier-model";

const DEFAULT_FORM: VerifierForm = {
  enabled: true,
  windowHours: "24",
  checkIns: "1, 6, 24",
  trafficFloor: true,
  revert: { rateFactor: "5", minEvents: "10", minUsers: "2" },
  follow: { loopPrs: true, humanPrs: true },
  mode: "observe",
};

const edit = (patch: Partial<VerifierForm>): VerifierForm => ({ ...DEFAULT_FORM, ...patch });
const revert = (patch: Partial<VerifierForm["revert"]>): VerifierForm => edit({ revert: { ...DEFAULT_FORM.revert, ...patch } });

describe("formFromView", () => {
  it("fills every key from the defaults when there is no block", () => {
    expect(formFromView(null)).toEqual(DEFAULT_FORM);
    expect(formFromView({})).toEqual(DEFAULT_FORM);
  });

  it("keeps the keys the block sets and fills the rest, per nested key", () => {
    expect(formFromView({ windowHours: 6, checkIns: [1, 6], revert: { minUsers: 3 }, follow: { humanPrs: false }, mode: "act" })).toEqual({
      ...DEFAULT_FORM,
      windowHours: "6",
      checkIns: "1, 6",
      revert: { rateFactor: "5", minEvents: "10", minUsers: "3" },
      follow: { loopPrs: true, humanPrs: false },
      mode: "act",
    });
  });
});

describe("formProblems", () => {
  it("accepts the defaults", () => {
    expect(formProblems(DEFAULT_FORM)).toEqual([]);
  });

  it("refuses a window that is not a positive number", () => {
    expect(formProblems(edit({ windowHours: "0", checkIns: "1" }))).toEqual(["'verifier.windowHours' must be a positive number; got 0"]);
    expect(formProblems(edit({ windowHours: "abc", checkIns: "1" }))).toEqual(['\'verifier.windowHours\' must be a positive number; got "abc"']);
    expect(formProblems(edit({ windowHours: "", checkIns: "1" }))).toEqual(['\'verifier.windowHours\' must be a positive number; got ""']);
  });

  it("refuses empty, non-positive, unordered and out-of-window check-ins", () => {
    expect(formProblems(edit({ checkIns: " " }))).toEqual(["'verifier.checkIns' must be a non-empty list of hours after the deploy; got []"]);
    expect(formProblems(edit({ checkIns: "1, -2" }))).toEqual(["'verifier.checkIns[1]' must be a positive number; got -2"]);
    expect(formProblems(edit({ checkIns: "1, x" }))).toEqual(['\'verifier.checkIns[1]\' must be a positive number; got "x"']);
    expect(formProblems(edit({ checkIns: "6, 6" }))).toEqual(["'verifier.checkIns[1]' must come after 6: check-ins are strictly ascending; got 6"]);
    expect(formProblems(edit({ checkIns: "1, 48" }))).toEqual(["'verifier.checkIns[1]' must be within the 24-hour window; got 48"]);
  });

  it("refuses a rate factor of 1 or less and a minimum that is not a whole number of at least 1", () => {
    expect(formProblems(revert({ rateFactor: "1" }))).toEqual(["'verifier.revert.rateFactor' must be a number greater than 1; got 1"]);
    expect(formProblems(revert({ minEvents: "0" }))).toEqual(["'verifier.revert.minEvents' must be a whole number of at least 1; got 0"]);
    expect(formProblems(revert({ minUsers: "1.5" }))).toEqual(["'verifier.revert.minUsers' must be a whole number of at least 1; got 1.5"]);
  });

  it("refuses following nothing and an unknown mode", () => {
    expect(formProblems(edit({ follow: { loopPrs: false, humanPrs: false } }))).toEqual(["'verifier.follow' must follow loop PRs, human PRs or both"]);
    expect(formProblems(edit({ mode: "loud" }))).toEqual(["'verifier.mode' must be 'observe', 'report' or 'act'; got \"loud\""]);
  });
});

describe("rulesFromForm", () => {
  it("turns a valid form into the whole rule object", () => {
    expect(rulesFromForm(formFromView(null))).toEqual(VERIFIER_RULE_DEFAULTS);
    expect(rulesFromForm(edit({ windowHours: "12", checkIns: "1,3, 12", revert: { rateFactor: "2.5", minEvents: "4", minUsers: "1" }, mode: "act" }))).toEqual({
      ...VERIFIER_RULE_DEFAULTS,
      windowHours: 12,
      checkIns: [1, 3, 12],
      revert: { rateFactor: 2.5, minEvents: 4, minUsers: 1 },
      mode: "act",
    });
  });

  it("is null while the form has a problem", () => {
    expect(rulesFromForm(edit({ mode: "loud" }))).toBeNull();
  });
});

describe("saveNotice", () => {
  it("links the PR when proposed and carries the reason otherwise", () => {
    expect(saveNotice({ outcome: "proposed", pr: { url: "https://github.com/o/r/pull/9", branch: "b", state: "open" } })).toMatchObject({
      tone: "good",
      url: "https://github.com/o/r/pull/9",
    });
    expect(saveNotice({ outcome: "refused", why: "a PR is open" })).toEqual({ tone: "bad", text: "Not saved: a PR is open" });
    expect(saveNotice({ outcome: "pr-failed", why: "gh failed" }).tone).toBe("warn");
  });
});

describe("switchRules (#789)", () => {
  it("sends the base branch's rules as they stand, nested defaults filled, with only `enabled` changed", () => {
    expect(switchRules({ windowHours: 6, checkIns: [1, 6], revert: { minUsers: 3 } }, false)).toEqual({
      ...VERIFIER_RULE_DEFAULTS,
      windowHours: 6,
      checkIns: [1, 6],
      revert: { ...VERIFIER_RULE_DEFAULTS.revert, minUsers: 3 },
      enabled: false,
    });
    expect(switchRules({ enabled: false }, true)).toEqual({ ...VERIFIER_RULE_DEFAULTS, enabled: true });
  });

  it("sends nothing when the base branch's rules would be refused", () => {
    expect(switchRules({ follow: { loopPrs: false, humanPrs: false } }, false)).toBeNull();
  });
});
