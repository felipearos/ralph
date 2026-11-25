// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ClaudeAccountsTargetView, ClaudeAccountView } from "../contracts";
import {
  accountOptions,
  choiceLine,
  ENV,
  formChanged,
  formFromTarget,
  INHERIT,
  limitOptions,
  NEXT_ANY,
  requestFromForm,
  unregistered,
} from "./claude-accounts-model";

const account = (name: string, email: string | null = null): ClaudeAccountView => ({
  name,
  configDir: `/home/dev/.claude-${name}`,
  loggedIn: true,
  email,
  organization: null,
  limitedUntil: null,
});
const A = account("acme-a", "a@example.org");
const B = account("acme-b");
const C = account("acme-c");
const TWO = [A, B];
const THREE = [A, B, C];
const run = { verdict: "run" as const, account: "acme-a", detail: "" };
const target = (rule: ClaudeAccountsTargetView["rule"], source: ClaudeAccountsTargetView["source"]): ClaudeAccountsTargetView => ({ rule, source, choice: run });

describe("the dropdown options", () => {
  it("offers inheriting first, then each account with who it is", () => {
    expect(accountOptions(TWO, false).map((option) => option.value)).toEqual([INHERIT, "acme-a", "acme-b"]);
    expect(accountOptions(TWO, true).map((option) => option.value)).toEqual([INHERIT, ENV, "acme-a", "acme-b"]);
    expect(accountOptions(TWO, false)[1]!.label).toBe("acme-a · a@example.org");
  });

  it("offers waiting, switching to each other account, any of them, and stopping", () => {
    expect(limitOptions(TWO, "acme-a").map((option) => option.value)).toEqual(["wait", "next:acme-b", "stop"]);
    expect(limitOptions(THREE, "acme-a").map((option) => option.value)).toEqual(["wait", "next:acme-b", "next:acme-c", NEXT_ANY, "stop"]);
  });
});

describe("a row's form", () => {
  it("shows a rule from the committed config as the inherited choice", () => {
    expect(formFromTarget(target({ use: ["acme-a"], onLimit: "wait" }, "config"), false, false, TWO)).toEqual({ account: INHERIT, onLimit: "wait" });
    expect(formFromTarget(target({ use: ["acme-a"], onLimit: "stop" }, "override-project"), true, false, TWO)).toEqual({ account: INHERIT, onLimit: "wait" });
  });

  it("reads this host's override back into the dropdowns", () => {
    expect(formFromTarget(target({ use: ["acme-a"], onLimit: "stop" }, "override-project"), false, false, TWO)).toEqual({ account: "acme-a", onLimit: "stop" });
    expect(formFromTarget(target({ use: ["acme-b", "acme-a"], onLimit: "next" }, "override"), true, true, TWO)).toEqual({ account: "acme-b", onLimit: "next:acme-a" });
    expect(formFromTarget(target({ use: ["acme-a", "acme-c", "acme-b"], onLimit: "next" }, "override"), true, true, THREE)).toEqual({
      account: "acme-a",
      onLimit: NEXT_ANY,
    });
    expect(formFromTarget(target(null, "override"), true, true, TWO)).toEqual({ account: ENV, onLimit: "wait" });
  });

  it("turns a pick into the request that writes it", () => {
    expect(requestFromForm("*", { account: INHERIT, onLimit: "wait" }, TWO)).toEqual({ action: "unassign", target: "*" });
    expect(requestFromForm("ralph", { account: ENV, onLimit: "wait" }, TWO)).toEqual({ action: "assign-env", target: "ralph" });
    expect(requestFromForm("ralph", { account: "acme-a", onLimit: "stop" }, TWO)).toEqual({ action: "assign", target: "ralph", use: ["acme-a"], onLimit: "stop" });
    expect(requestFromForm("*", { account: "acme-b", onLimit: "next:acme-a" }, TWO)).toEqual({ action: "assign", target: "*", use: ["acme-b", "acme-a"], onLimit: "next" });
    expect(requestFromForm("*", { account: "acme-c", onLimit: NEXT_ANY }, THREE)).toEqual({
      action: "assign",
      target: "*",
      use: ["acme-c", "acme-a", "acme-b"],
      onLimit: "next",
    });
  });

  it("round-trips every option through the request and back", () => {
    for (const primary of THREE) {
      for (const option of limitOptions(THREE, primary.name)) {
        const form = { account: primary.name, onLimit: option.value };
        const request = requestFromForm("ralph", form, THREE);
        if (request.action !== "assign") throw new Error("expected an assign");
        expect(formFromTarget(target({ use: request.use, onLimit: request.onLimit }, "override"), true, true, THREE)).toEqual(form);
      }
    }
  });

  it("counts a limit change only once an account is picked", () => {
    expect(formChanged({ account: INHERIT, onLimit: "wait" }, { account: INHERIT, onLimit: "stop" })).toBe(false);
    expect(formChanged({ account: "acme-a", onLimit: "wait" }, { account: "acme-a", onLimit: "stop" })).toBe(true);
    expect(formChanged({ account: INHERIT, onLimit: "wait" }, { account: "acme-a", onLimit: "wait" })).toBe(true);
  });
});

describe("what a row runs on now", () => {
  const format = (iso: string) => `<${iso}>`;
  it("says the account, the wait and the stop with its reset", () => {
    expect(choiceLine({ verdict: "default", account: null, detail: "" }, format)).toEqual({ text: "Runs on this machine's default account", tone: "neutral" });
    expect(choiceLine({ verdict: "run", account: "acme-a", detail: "" }, format)).toEqual({ text: "Runs on acme-a", tone: "good" });
    expect(choiceLine({ verdict: "wait", account: "acme-a", detail: "waiting for acme-a to reset at 2026-11-25T15:00:00Z" }, format)).toEqual({
      text: "Waiting for acme-a until <2026-11-25T15:00:00Z>",
      tone: "warn",
    });
    expect(choiceLine({ verdict: "stop", account: "acme-a", detail: "acme-a is at its usage limit until 2026-11-25T15:00:00Z and onLimit is stop" }, format).tone).toBe("bad");
  });
});

describe("found accounts", () => {
  it("lists only the unregistered ones", () => {
    const found = { configDir: "/x", suggestedName: "x", loggedIn: true, email: null, organization: null };
    expect(unregistered([{ ...found, registeredAs: "x" }, { ...found, configDir: "/y", registeredAs: null }]).map((entry) => entry.configDir)).toEqual(["/y"]);
  });
});
