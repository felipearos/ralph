// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SENTINEL_RULE_DEFAULTS } from "../contracts";
import { formFromView, formProblems, rulesFromForm, saveNotice, switchRules, type SentinelForm } from "./sentinel-form-model";

const DEFAULT_FORM: SentinelForm = {
  enabled: true,
  lookbackHours: "24",
  minEvents: "10",
  minUsers: "2",
  maxPerDay: "5",
  mode: "observe",
};

const edit = (patch: Partial<SentinelForm>): SentinelForm => ({ ...DEFAULT_FORM, ...patch });

describe("formFromView", () => {
  it("fills every key from the defaults when there is no block", () => {
    expect(formFromView(null)).toEqual(DEFAULT_FORM);
    expect(formFromView({})).toEqual(DEFAULT_FORM);
  });

  it("keeps the keys the block sets and fills the rest", () => {
    expect(formFromView({ lookbackHours: 6, minUsers: 3, mode: "file" })).toEqual({ ...DEFAULT_FORM, lookbackHours: "6", minUsers: "3", mode: "file" });
  });
});

describe("formProblems", () => {
  it("accepts the defaults", () => {
    expect(formProblems(DEFAULT_FORM)).toEqual([]);
  });

  it("refuses a lookback that is not a positive number", () => {
    expect(formProblems(edit({ lookbackHours: "0" }))).toEqual(["'sentinel.lookbackHours' must be a positive number; got 0"]);
    expect(formProblems(edit({ lookbackHours: "abc" }))).toEqual(['\'sentinel.lookbackHours\' must be a positive number; got "abc"']);
    expect(formProblems(edit({ lookbackHours: "" }))).toEqual(['\'sentinel.lookbackHours\' must be a positive number; got ""']);
    expect(formProblems(edit({ lookbackHours: "1.5" }))).toEqual([]);
  });

  it("refuses a bar or cap that is not a whole number of at least 1", () => {
    expect(formProblems(edit({ minEvents: "0" }))).toEqual(["'sentinel.minEvents' must be a whole number of at least 1; got 0"]);
    expect(formProblems(edit({ minUsers: "1.5" }))).toEqual(["'sentinel.minUsers' must be a whole number of at least 1; got 1.5"]);
    expect(formProblems(edit({ maxPerDay: "many" }))).toEqual(['\'sentinel.maxPerDay\' must be a whole number of at least 1; got "many"']);
  });

  it("refuses an unknown mode", () => {
    expect(formProblems(edit({ mode: "act" }))).toEqual(["'sentinel.mode' must be 'observe' or 'file'; got \"act\""]);
  });
});

describe("rulesFromForm", () => {
  it("turns a valid form into the whole rule object", () => {
    expect(rulesFromForm(formFromView(null))).toEqual(SENTINEL_RULE_DEFAULTS);
    expect(rulesFromForm(edit({ lookbackHours: "12", minEvents: "4", minUsers: "1", maxPerDay: "3", mode: "file" }))).toEqual({
      enabled: true,
      lookbackHours: 12,
      minEvents: 4,
      minUsers: 1,
      maxPerDay: 3,
      mode: "file",
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

  it("names the sentinel when the rules were committed", () => {
    const committed = saveNotice({ outcome: "committed", commit: { branch: "main", sha: "0123456789abcdef", subject: "s" } });
    expect(committed).toEqual({ tone: "good", text: "Saved to main (0123456). The sentinel picks it up on its next poll." });
  });
});

describe("switchRules (#789)", () => {
  it("sends the base branch's rules as they stand, every default spelled, with only `enabled` changed", () => {
    expect(switchRules({ lookbackHours: 6, mode: "file" }, false)).toEqual({ ...SENTINEL_RULE_DEFAULTS, lookbackHours: 6, mode: "file", enabled: false });
    expect(switchRules({ enabled: false, minUsers: 4 }, true)).toEqual({ ...SENTINEL_RULE_DEFAULTS, minUsers: 4, enabled: true });
    expect(switchRules(null, false)).toEqual({ ...SENTINEL_RULE_DEFAULTS, enabled: false });
  });

  it("sends nothing when the base branch's rules would be refused", () => {
    expect(switchRules({ maxPerDay: 0 }, false)).toBeNull();
  });

  it("is seeded from the base branch's `enabled`, on when absent", () => {
    expect(formFromView({ enabled: false }).enabled).toBe(false);
    expect(formFromView({}).enabled).toBe(true);
  });
});
