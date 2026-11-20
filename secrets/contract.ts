/**
 * The behaviour every `SecretSource` owes the loops (felipearos/ralph#759), as
 * one suite each source's test file runs against its own setup: the fake,
 * Doppler through a fake process, and the environment. A new secrets manager
 * is done when it passes this.
 *
 * Only outcomes are asserted (what a read returns), never how a source got
 * there. A source that cannot produce an outcome at all — the environment has
 * no "transient failure" — says so in its setup, and those tests are skipped
 * by name rather than quietly passing.
 */
import { describe, expect, it } from "vitest";

import type { SecretSource } from "./source";

export interface SecretArrangement {
  /** Names stored, with their exact values. */
  stored: Record<string, string>;
  /** Names whose read fails transiently (outage, locked keyring, timeout). */
  unread: string[];
}

export interface SecretSourceContractSetup {
  kind: string;
  /** False for a source that cannot tell a failed read from a missing one. */
  supportsUnread: boolean;
  /** A source holding `arrangement`; every other name is missing. */
  make(arrangement: SecretArrangement): SecretSource | Promise<SecretSource>;
}

/** A value with the edges a careless source would trim: spaces, a tab, an inner newline. */
export const AWKWARD_VALUE = "  tok_3n\tv=a\nb  ";

const OTHER_VALUE = "sk_live_other_secret_value";

export function secretSourceContract(name: string, setup: SecretSourceContractSetup): void {
  const make = async (arrangement: Partial<SecretArrangement>): Promise<SecretSource> =>
    setup.make({ stored: {}, unread: [], ...structuredClone(arrangement) });

  describe(`SecretSource contract: ${name}`, () => {
    it("names its kind", async () => {
      expect((await make({})).kind).toBe(setup.kind);
    });

    it("returns a stored value", async () => {
      const source = await make({ stored: { API_TOKEN: "tok_123" } });
      expect(await source.read("API_TOKEN")).toEqual({ kind: "value", value: "tok_123" });
    });

    it("returns a value verbatim, inner whitespace and edges kept", async () => {
      const source = await make({ stored: { API_TOKEN: AWKWARD_VALUE } });
      expect(await source.read("API_TOKEN")).toEqual({ kind: "value", value: AWKWARD_VALUE });
    });

    it("answers absent for a name it does not hold", async () => {
      const source = await make({ stored: { API_TOKEN: "tok_123" } });
      expect(await source.read("NOT_STORED")).toEqual({ kind: "absent" });
    });

    it("reads each name on its own", async () => {
      const source = await make({ stored: { ONE: "first", TWO: "second" } });
      expect(await source.read("TWO")).toEqual({ kind: "value", value: "second" });
      expect(await source.read("ONE")).toEqual({ kind: "value", value: "first" });
    });

    it.skipIf(!setup.supportsUnread)("answers unread, with a one-line reason, for a transient failure", async () => {
      const source = await make({ unread: ["API_TOKEN"] });
      const read = await source.read("API_TOKEN");
      if (read.kind !== "unread") throw new Error(`not unread: ${JSON.stringify(read)}`);
      expect(read.why.trim()).not.toBe("");
      expect(read.why).not.toContain("\n");
    });

    it.skipIf(!setup.supportsUnread)("never puts another secret's value in an unread's reason", async () => {
      const source = await make({ stored: { OTHER: OTHER_VALUE }, unread: ["API_TOKEN"] });
      expect(await source.read("OTHER")).toEqual({ kind: "value", value: OTHER_VALUE });
      const read = await source.read("API_TOKEN");
      expect(read.kind).toBe("unread");
      expect(JSON.stringify(read)).not.toContain(OTHER_VALUE);
    });

    it.skipIf(!setup.supportsUnread)("keeps an unread name from failing the names beside it", async () => {
      const source = await make({ stored: { OTHER: OTHER_VALUE }, unread: ["API_TOKEN"] });
      expect((await source.read("API_TOKEN")).kind).toBe("unread");
      expect(await source.read("OTHER")).toEqual({ kind: "value", value: OTHER_VALUE });
      expect(await source.read("MISSING")).toEqual({ kind: "absent" });
    });
  });
}
