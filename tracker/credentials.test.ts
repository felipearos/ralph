import { chmodSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scratchDir } from "../test-scratch";

import { credentialPath, readCredential, writeCredential } from "./credentials";

const scratchEnv = () => ({ XDG_CONFIG_HOME: scratchDir("tracker-cred-") });

describe("tracker credentials", () => {
  it("lives under the XDG config home, keyed by project id", () => {
    expect(credentialPath("acme-backoffice", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/ralph/trackers/acme-backoffice.json");
  });

  it("refuses a project id that would leave the directory", () => {
    expect(() => credentialPath("../etc", {})).toThrow(/not a project id/);
    expect(() => credentialPath("a/b", {})).toThrow(/not a project id/);
  });

  it("reports a missing file as not connected", () => {
    const env = scratchEnv();
    expect(readCredential("p", env)).toEqual({ status: "not-connected", path: credentialPath("p", env) });
  });

  it("writes 0600 and reads back", () => {
    const env = scratchEnv();
    const path = writeCredential("p", { kind: "linear", apiKey: "lin_api_x" }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCredential("p", env)).toEqual({ status: "ok", credential: { kind: "linear", apiKey: "lin_api_x" } });
  });

  it("refuses a file other users can read", () => {
    const env = scratchEnv();
    const path = writeCredential("p", { kind: "jira", email: "a@b.c", apiToken: "t" }, env);
    chmodSync(path, 0o644);
    const reading = readCredential("p", env);
    expect(reading.status).toBe("invalid");
    expect(reading.status === "invalid" && reading.problem).toMatch(/chmod 600/);
  });

  it("refuses a malformed or incomplete credential", () => {
    const env = scratchEnv();
    const path = credentialPath("p", env);
    mkdirSync(join(env.XDG_CONFIG_HOME, "ralph", "trackers"), { recursive: true });
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(readCredential("p", env)).toMatchObject({ status: "invalid", problem: expect.stringMatching(/not valid JSON/) });
    writeFileSync(path, JSON.stringify({ kind: "jira", email: "a@b.c" }), { mode: 0o600 });
    expect(readCredential("p", env)).toMatchObject({ status: "invalid", problem: expect.stringMatching(/apiToken/) });
    expect(() => writeCredential("p", { kind: "linear", apiKey: " " }, env)).toThrow(/apiKey/);
  });
});
