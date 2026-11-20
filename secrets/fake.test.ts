import { describe, expect, it } from "vitest";

import { secretSourceContract } from "./contract";
import { createFakeSecretSource } from "./fake";
import type { SecretRead } from "./source";

secretSourceContract("fake", {
  kind: "fake",
  supportsUnread: true,
  make: ({ stored, unread }) =>
    createFakeSecretSource({
      ...Object.fromEntries(Object.entries(stored).map(([name, value]): [string, SecretRead] => [name, { kind: "value", value }])),
      ...Object.fromEntries(unread.map((name): [string, SecretRead] => [name, { kind: "unread", why: "keyring locked" }])),
    }),
});

describe("fake secret source", () => {
  it("changes its answer when told to, as a keyring unlocking would", async () => {
    const source = createFakeSecretSource({ TOKEN: { kind: "unread", why: "keyring locked" } });
    expect(await source.read("TOKEN")).toEqual({ kind: "unread", why: "keyring locked" });
    source.set("TOKEN", { kind: "value", value: "tok" });
    expect(await source.read("TOKEN")).toEqual({ kind: "value", value: "tok" });
  });

  it("logs every name read, repeats included", async () => {
    const source = createFakeSecretSource();
    await source.read("A");
    await source.read("B");
    await source.read("A");
    expect(source.reads).toEqual(["A", "B", "A"]);
  });

  it("does not let a caller mutate its answers", async () => {
    const seed: Record<string, SecretRead> = { TOKEN: { kind: "value", value: "tok" } };
    const source = createFakeSecretSource(seed);
    const read = await source.read("TOKEN");
    if (read.kind === "value") read.value = "changed";
    seed.TOKEN = { kind: "absent" };
    expect(await source.read("TOKEN")).toEqual({ kind: "value", value: "tok" });
  });
});
