// @vitest-environment node
import { describe, expect, it } from "vitest";

import { PROJECT_SLEEP_WHY_MAX, type ProjectSleepView } from "../contracts";
import { asleepLine, settleToggle, sleepBody, sleepState, WAKE_BODY, whyHint } from "./project-sleep-model";

const SINCE = "2026-11-05T03:00:00.000Z";
const format = (iso: string) => `<${iso}>`;
const AWAKE: ProjectSleepView = { asleep: false, since: null, why: null, by: null, problem: null };
const ASLEEP: ProjectSleepView = { asleep: true, since: SINCE, why: "deploy freeze", by: "dashboard", problem: null };
const at = new Date(0);

describe("the sleep state", () => {
  it("hides while loading, and on a server without the route", () => {
    expect(sleepState({ state: "loading" })).toEqual({ kind: "hidden" });
    expect(sleepState({ state: "error", message: "not found", status: 404, data: null })).toEqual({ kind: "hidden" });
  });

  it("reads awake and asleep, with the banner's line", () => {
    expect(sleepState({ state: "ready", data: AWAKE, at, snapshotAt: null }, format)).toEqual({ kind: "awake" });
    expect(sleepState({ state: "ready", data: ASLEEP, at, snapshotAt: null }, format)).toEqual({
      kind: "asleep",
      since: SINCE,
      why: "deploy freeze",
      by: "dashboard",
      line: `Asleep since <${SINCE}> — deploy freeze`,
    });
  });

  it("shows the CLI's problem rather than a state it does not know", () => {
    const data = { ...AWAKE, problem: "not a git checkout" };
    expect(sleepState({ state: "ready", data, at, snapshotAt: null })).toEqual({ kind: "unknown", problem: "not a git checkout" });
  });

  it("keeps the last answer through a failed poll, and says why when there is none", () => {
    expect(sleepState({ state: "error", message: "HTTP 500", status: 500, data: ASLEEP }, format)).toMatchObject({ kind: "asleep" });
    expect(sleepState({ state: "error", message: "HTTP 500", status: 500, data: null })).toEqual({ kind: "unknown", problem: "HTTP 500" });
  });
});

describe("the banner's line", () => {
  it("leaves out a reason that was not given", () => {
    expect(asleepLine({ since: SINCE, why: null }, format)).toBe(`Asleep since <${SINCE}>`);
    expect(asleepLine({ since: SINCE, why: "release" }, format)).toBe(`Asleep since <${SINCE}> — release`);
  });
});

describe("the toggle's bodies", () => {
  it("sends a reason folded to one line, and none when blank", () => {
    expect(sleepBody("  release\n day ")).toEqual({ asleep: true, why: "release day" });
    expect(sleepBody("   ")).toEqual({ asleep: true });
    expect(WAKE_BODY).toEqual({ asleep: false });
  });

  it("hints at an overlong reason before the route refuses it", () => {
    expect(whyHint("x".repeat(PROJECT_SLEEP_WHY_MAX))).toBeNull();
    expect(whyHint("x".repeat(PROJECT_SLEEP_WHY_MAX + 1))).toMatch(/under 500/);
  });
});

describe("one toggle's answer", () => {
  it("is ok only when the project is now as asked", () => {
    expect(settleToggle(true, { ok: true, value: ASLEEP })).toEqual({ ok: true });
    expect(settleToggle(false, { ok: true, value: AWAKE })).toEqual({ ok: true });
    expect(settleToggle(true, { ok: true, value: AWAKE })).toEqual({ ok: false, message: "The project is still awake." });
  });

  it("fails on a refusal, an empty answer and a view with a problem", () => {
    const refused = { ok: false as const, error: { kind: "ControlRequestError", message: "'asleep' is required", status: 400 } };
    expect(settleToggle(true, refused)).toEqual({ ok: false, message: "ControlRequestError: 'asleep' is required" });
    expect(settleToggle(true, { ok: true, value: null })).toMatchObject({ ok: false });
    expect(settleToggle(true, { ok: true, value: { ...AWAKE, problem: "no bun" } })).toEqual({ ok: false, message: "no bun" });
  });
});
