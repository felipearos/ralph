// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseProjectConfig, SENTINEL_RULE_KEYS, sentinelRules } from "../project-config";
import { formFromView, formProblems, formValues, type SentinelForm } from "./ui/sentinel-form-model";

/**
 * The sentinel rules form copies the harness's rule checks because the page
 * may not import the harness. This holds the copy to the original: for each
 * form, a whole config carrying the form's values is refused by
 * `parseProjectConfig` exactly when the form refuses it, and in the same words.
 * It also pins the form's fields to the schema's rule keys, so a rule added to
 * the config is not silently left out of the form (or the reverse).
 */
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "loggd", ".ralph", "config.json"), "utf8")) as {
  loops: unknown[];
};

const configText = (form: SentinelForm): string =>
  JSON.stringify({
    ...FIXTURE,
    loops: [...FIXTURE.loops, { name: "sent", role: "sentinel" }],
    sentinel: { reporter: { kind: "sentry", org: "acme", project: "web" }, ...formValues(form) },
  });

const DEFAULTS = formFromView(null);
const edit = (patch: Partial<SentinelForm>): SentinelForm => ({ ...DEFAULTS, ...patch });

const CASES: [string, SentinelForm][] = [
  ["the defaults", DEFAULTS],
  ["a valid edited set", edit({ lookbackHours: "6", minEvents: "1", minUsers: "7", maxPerDay: "5", mode: "file" })],
  ["a fractional lookback", edit({ lookbackHours: "1.5" })],
  ["a zero lookback", edit({ lookbackHours: "0" })],
  ["a negative lookback", edit({ lookbackHours: "-1" })],
  ["a typed lookback", edit({ lookbackHours: "a day" })],
  ["an empty lookback", edit({ lookbackHours: "" })],
  ["zero min events", edit({ minEvents: "0" })],
  ["one min event", edit({ minEvents: "1" })],
  ["fractional min events", edit({ minEvents: "2.5" })],
  ["zero min users", edit({ minUsers: "0" })],
  ["typed min users", edit({ minUsers: "two" })],
  ["zero per day", edit({ maxPerDay: "0" })],
  ["five per day", edit({ maxPerDay: "5" })],
  ["observe mode", edit({ mode: "observe" })],
  ["file mode", edit({ mode: "file" })],
  ["an unknown mode", edit({ mode: "act" })],
  ["switched off (#789)", edit({ enabled: false })],
  ["switched off in file mode", edit({ enabled: false, mode: "file" })],
  ["switched off with a bad rule", edit({ enabled: false, maxPerDay: "0" })],
  ["several problems at once", edit({ lookbackHours: "0", maxPerDay: "-2", mode: "loud" })],
];

describe("the sentinel form refuses what the config refuses, in its words", () => {
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

describe("the sentinel form edits exactly the schema's rule keys", () => {
  it("has one field per rule key, and no other", () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([...SENTINEL_RULE_KEYS].sort());
    expect(Object.keys(formValues(DEFAULTS)).sort()).toEqual([...SENTINEL_RULE_KEYS].sort());
  });
});

describe("the sentinel form's switch reads `enabled` as the harness does (#789)", () => {
  const harnessEnabled = (form: SentinelForm): boolean => sentinelRules(parseProjectConfig(configText(form)))!.enabled;

  it("sends what the harness reads back", () => {
    expect(harnessEnabled(edit({ enabled: false }))).toBe(false);
    expect(harnessEnabled(edit({ enabled: true }))).toBe(true);
  });

  it("seeds on from a block with no `enabled`, as the harness defaults it", () => {
    expect(formFromView({}).enabled).toBe(true);
    expect(sentinelRules(parseProjectConfig(JSON.stringify({ ...FIXTURE, loops: [...FIXTURE.loops, { name: "sent", role: "sentinel" }], sentinel: { reporter: { kind: "sentry", org: "acme", project: "web" } } })))!.enabled).toBe(true);
  });
});
