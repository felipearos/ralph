// @vitest-environment node
import { describe, expect, it } from "vitest";

import { initialOutput, MAX_LINES, parseOutputEvent, reduceOutput, type OutputState } from "./output-model";

const apply = (state: OutputState, ...events: Parameters<typeof reduceOutput>[1][]): OutputState =>
  events.reduce(reduceOutput, state);

describe("reduceOutput", () => {
  it("appends whole lines after a reset and clears them on the next", () => {
    const shown = apply(
      initialOutput,
      { type: "event", event: { kind: "reset", log: "iter-1.log", reason: null } },
      { type: "event", event: { kind: "append", text: "one\ntwo\n" } },
      { type: "event", event: { kind: "append", text: "three\n" } },
    );
    expect(shown).toMatchObject({ connection: "open", log: "iter-1.log", lines: ["one", "two", "three"] });

    const next = reduceOutput(shown, { type: "event", event: { kind: "reset", log: "iter-2.log", reason: null } });
    expect(next).toMatchObject({ log: "iter-2.log", lines: [] });
  });

  it("keeps a reset's reason for an empty pane", () => {
    const empty = reduceOutput(initialOutput, {
      type: "event",
      event: { kind: "reset", log: null, reason: "No iteration log yet" },
    });
    expect(empty).toMatchObject({ log: null, reason: "No iteration log yet", lines: [] });
  });

  it("drops shown output when it is withheld", () => {
    const withheld = apply(
      initialOutput,
      { type: "event", event: { kind: "reset", log: "iter-1.log", reason: null } },
      { type: "event", event: { kind: "append", text: "one\n" } },
      { type: "event", event: { kind: "withheld", reason: "no patterns" } },
    );
    expect(withheld).toMatchObject({ lines: [], withheld: "no patterns" });
  });

  it("keeps a bounded tail", () => {
    const text = Array.from({ length: MAX_LINES + 10 }, (_, index) => `line ${index}`).join("\n") + "\n";
    const state = reduceOutput(initialOutput, { type: "event", event: { kind: "append", text } });
    expect(state.lines).toHaveLength(MAX_LINES);
    expect(state.lines.at(-1)).toBe(`line ${MAX_LINES + 9}`);
  });

  it("tracks the connection without touching what is shown", () => {
    const shown = reduceOutput(initialOutput, { type: "event", event: { kind: "append", text: "one\n" } });
    expect(reduceOutput(shown, { type: "connection", connection: "reconnecting" })).toMatchObject({
      connection: "reconnecting",
      lines: ["one"],
    });
  });
});

describe("parseOutputEvent", () => {
  it("accepts the three kinds and nothing else", () => {
    expect(parseOutputEvent('{"kind":"append","text":"x\\n"}')).toEqual({ kind: "append", text: "x\n" });
    expect(parseOutputEvent('{"kind":"other"}')).toBeNull();
    expect(parseOutputEvent("not json")).toBeNull();
  });
});
