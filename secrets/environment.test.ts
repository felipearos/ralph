import { describe, expect, it } from "vitest";

import { secretSourceContract } from "./contract";
import { environmentSource, secretSourceFor } from "./source";

secretSourceContract("environment", {
  kind: "environment",
  // A launcher that failed to export a secret looks exactly like one never
  // given it, so the environment has no transient failure to arrange.
  supportsUnread: false,
  make: ({ stored }) => environmentSource({ ...stored }),
});

describe("environment secret source", () => {
  it("reads a blank value as absent", async () => {
    const source = environmentSource({ EMPTY: "", BLANK: "  \n\t" });
    expect(await source.read("EMPTY")).toEqual({ kind: "absent" });
    expect(await source.read("BLANK")).toEqual({ kind: "absent" });
  });

  it("is what a manager-less runner reads through", async () => {
    const source = secretSourceFor("none", { TOKEN: "tok" });
    expect(source.kind).toBe("environment");
    expect(await source.read("TOKEN")).toEqual({ kind: "value", value: "tok" });
  });

  it("gives Doppler to the doppler runner", () => {
    expect(secretSourceFor("doppler", { RALPH_SECRETS_PROJECT: "p", RALPH_SECRETS_CONFIG: "c" }).kind).toBe("doppler");
  });
});
