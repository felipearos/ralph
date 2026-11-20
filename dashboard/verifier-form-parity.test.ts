// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseProjectConfig, VERIFIER_RULE_KEYS, verifierRules } from "../project-config";
import { formFromView, formProblems, formValues, type VerifierForm } from "./ui/verifier-model";

/**
 * The settings form copies the harness's verifier rule checks because the page
 * may not import the harness. This holds the copy to the original: for each
 * form, a whole config carrying the form's values is refused by
 * `parseProjectConfig` exactly when the form refuses it, and in the same words.
 */
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "loggd", ".ralph", "config.json"), "utf8")) as {
  loops: unknown[];
};

const configText = (form: VerifierForm): string =>
  JSON.stringify({
    ...FIXTURE,
    loops: [...FIXTURE.loops, { name: "sent", role: "verifier" }],
    verifier: {
      productionUrl: "https://loggd.app",
      deploy: { source: "vercel", project: "prj_loggd" },
      sentry: { org: "loggd", project: "web" },
      ...formValues(form),
    },
  });

const DEFAULTS = formFromView(null);
const edit = (patch: Partial<VerifierForm>): VerifierForm => ({ ...DEFAULTS, ...patch });
const revert = (patch: Partial<VerifierForm["revert"]>): VerifierForm => edit({ revert: { ...DEFAULTS.revert, ...patch } });

const CASES: [string, VerifierForm][] = [
  ["the defaults", DEFAULTS],
  ["a valid short window", edit({ windowHours: "6", checkIns: "1, 3, 6", mode: "act" })],
  ["a valid edited revert rule", revert({ rateFactor: "1.5", minEvents: "1", minUsers: "7" })],
  ["one follow box", edit({ follow: { loopPrs: false, humanPrs: true } })],
  ["a zero window", edit({ windowHours: "0", checkIns: "1" })],
  ["a typed window", edit({ windowHours: "a day", checkIns: "1" })],
  ["an empty window", edit({ windowHours: "", checkIns: "1" })],
  ["no check-ins", edit({ checkIns: "" })],
  ["a negative check-in", edit({ checkIns: "1, -6, 24" })],
  ["a typed check-in", edit({ checkIns: "1, six" })],
  ["an empty check-in", edit({ checkIns: "1,, 6" })],
  ["check-ins out of order", edit({ checkIns: "6, 1, 24" })],
  ["a repeated check-in", edit({ checkIns: "1, 1" })],
  ["a check-in past the window", edit({ windowHours: "12", checkIns: "1, 6, 24" })],
  ["a rate factor of 1", revert({ rateFactor: "1" })],
  ["a typed rate factor", revert({ rateFactor: "five" })],
  ["zero min events", revert({ minEvents: "0" })],
  ["fractional min users", revert({ minUsers: "1.5" })],
  ["typed min events", revert({ minEvents: "ten" })],
  ["following nothing", edit({ follow: { loopPrs: false, humanPrs: false } })],
  ["an unknown mode", edit({ mode: "loud" })],
  ["switched off (#789)", edit({ enabled: false })],
  ["switched off with a bad rule", edit({ enabled: false, windowHours: "0", checkIns: "1" })],
];

describe("the verifier form refuses what the config refuses, in its words", () => {
  it.each(CASES)("%s", (_label, form) => {
    const problems = formProblems(form);
    let thrown: string | null = null;
    try {
      parseProjectConfig(configText(form));
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown === null, thrown ?? "accepted").toBe(problems.length === 0);
    for (const problem of problems) expect(thrown).toContain(problem);
  });

  it("covers both an accepted and a refused case", () => {
    expect(CASES.some(([, form]) => formProblems(form).length === 0)).toBe(true);
    expect(CASES.some(([, form]) => formProblems(form).length > 0)).toBe(true);
  });
});

describe("the verifier form edits exactly the schema's rule keys", () => {
  it("has one field per rule key, and no other", () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([...VERIFIER_RULE_KEYS].sort());
    expect(Object.keys(formValues(DEFAULTS)).sort()).toEqual([...VERIFIER_RULE_KEYS].sort());
  });

  it("sends an `enabled` the harness reads back (#789)", () => {
    expect(verifierRules(parseProjectConfig(configText(edit({ enabled: false }))))!.enabled).toBe(false);
    expect(verifierRules(parseProjectConfig(configText(DEFAULTS)))!.enabled).toBe(true);
  });
});
