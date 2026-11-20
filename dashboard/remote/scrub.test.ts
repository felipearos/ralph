// @vitest-environment node
/**
 * The scrub on its own: the local rewrites with a pass-through redactor, then
 * the harness's real one, and the fail-closed answers.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bunPath } from "../fixtures";
import { subprocessSuite } from "../../test-timeouts";
import { processRedactor, scrub, scrubAll, SCRUBBED, type Redactor } from "./scrub";

subprocessSuite("runs the harness redactor under bun");

const identity: Redactor = async (lines) => [...lines];
const HOME = "/home/operator";
const clean = async (value: unknown, redact: Redactor = identity): Promise<unknown> => {
  const result = await scrub(value, { redact, home: HOME });
  if (!result.ok) throw new Error(result.detail);
  return result.value;
};

describe("the local rewrites", () => {
  it("scrubs every string under a deny-listed key and keeps counts", async () => {
    expect(
      await clean({
        githubToken: "abc",
        client_secret: "abc",
        Password: "abc",
        authorization: "Bearer abc",
        cookies: ["a=1", "b=2"],
        "api-key": "abc",
        apiKey: { value: "abc", rotatedAt: 3 },
        tokens: 1200,
        unpricedTokens: 0,
        usage: { tokens: { input: 1, output: 2 } },
        note: "a token is mentioned here",
      }),
    ).toEqual({
      githubToken: SCRUBBED,
      client_secret: SCRUBBED,
      Password: SCRUBBED,
      authorization: SCRUBBED,
      cookies: [SCRUBBED, SCRUBBED],
      "api-key": SCRUBBED,
      apiKey: { value: SCRUBBED, rotatedAt: 3 },
      tokens: 1200,
      unpricedTokens: 0,
      usage: { tokens: { input: 1, output: 2 } },
      note: "a token is mentioned here",
    });
  });

  it("strips URL userinfo and leaves the rest of the URL", async () => {
    expect(
      await clean([
        "https://felipe:ghp_secret@github.com/felipearos/loggd",
        "clone https://x-access-token:abc@github.com/o/r.git failed",
        "https://github.com/o/r/issues/1@2",
        "git@github.com:o/r.git",
      ]),
    ).toEqual([
      "https://github.com/felipearos/loggd",
      "clone https://github.com/o/r.git failed",
      "https://github.com/o/r/issues/1@2",
      "git@github.com:o/r.git",
    ]);
  });

  it("rewrites $HOME as a path, wherever it is, and never a sibling's", async () => {
    expect(
      await clean([HOME, `${HOME}/loggd/wt-ralph`, `see ${HOME}/x.log, line 2`, "/home/operator2/x", `file://${HOME}/x`, "/home/operatorx"]),
    ).toEqual(["~", "~/loggd/wt-ralph", "see ~/x.log, line 2", "/home/operator2/x", "file://~/x", "/home/operatorx"]);
  });

  it("returns a copy, keeps non-strings, and leaves the input alone", async () => {
    const input = { a: [1, true, null, { b: `${HOME}/c` }], d: "multi\nline\n" };
    const snapshot = structuredClone(input);
    expect(await clean(input)).toEqual({ a: [1, true, null, { b: "~/c" }], d: "multi\nline\n" });
    expect(input).toEqual(snapshot);
  });
});

describe("the redactor", () => {
  it("is handed each leaf's lines, and its answer is put back leaf by leaf", async () => {
    const seen: string[][] = [];
    const upper: Redactor = async (lines) => {
      seen.push([...lines]);
      return lines.map((line) => line.toUpperCase());
    };
    const result = await scrubAll([{ a: "x\ny", b: "" }, ["z"]], { redact: upper, home: HOME });
    expect(seen).toEqual([["x", "y", "", "z"]]);
    expect(result).toEqual({ ok: true, value: [{ a: "X\nY", b: "" }, ["Z"]] });
  });

  it("is not run for documents with no text", async () => {
    const never: Redactor = async () => {
      throw new Error("ran");
    };
    expect(await scrubAll([{ a: 1 }, null], { redact: never, home: HOME })).toEqual({ ok: true, value: [{ a: 1 }, null] });
  });

  it("fails closed on a wrong line count or a rejection, returning no value", async () => {
    for (const redact of [async (lines: readonly string[]) => [...lines, "extra"], async () => Promise.reject(new Error("gone"))] as Redactor[]) {
      const result = await scrub({ a: "x" }, { redact, home: HOME });
      expect(result).toMatchObject({ ok: false, error: "redactor-degraded" });
      expect("value" in result).toBe(false);
    }
  });

  it("is the harness's own filter by default, and keeps the JSON valid", async () => {
    const redact = processRedactor({ ralphHome: join(__dirname, "..", ".."), bunPath: bunPath() });
    const key = `sk-ant-api03-${"q".repeat(24)}`;
    expect(
      await clean({ line: `401 for ${key}`, quoted: `"${key}"\nnext`, jwt: "eyJhbGciOi.eyJzdWIiOi.c2ln" }, redact),
    ).toEqual({ line: "401 for [redacted:anthropic-key]", quoted: '"[redacted:anthropic-key]"\nnext', jwt: "[redacted:jwt]" });
  });
});
