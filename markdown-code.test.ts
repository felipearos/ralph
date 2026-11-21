import { describe, expect, it } from "vitest";

import { withoutCode } from "./markdown-code";

describe("withoutCode", () => {
  it("removes single and multi-backtick spans, leaving the prose around them", () => {
    expect(withoutCode("a `AND-1` b ``AND-2`` c ```AND-3``` d")).toBe("a  b  c  d");
    expect(withoutCode("a ``x ` y`` b")).toBe("a  b");
  });

  it("leaves an unmatched backtick run as prose", () => {
    expect(withoutCode("a ``AND-1` b")).toBe("a ``AND-1` b");
  });

  it("closes a fence only on a bare marker of the same character, at least as long", () => {
    expect(withoutCode("before\n```\n```js\nAND-1\n~~~\nAND-2\n````  \nafter")).toBe("before\n\nafter");
    expect(withoutCode("before\n~~~~\nAND-1\n~~~\nAND-2\n")).toBe("before\n");
  });

  it("treats an unclosed fence as running to the end", () => {
    expect(withoutCode("before\n```\nAND-1\nAND-2")).toBe("before\n");
  });

  it("reads null and undefined as an empty body", () => {
    expect(withoutCode(null)).toBe("");
    expect(withoutCode(undefined)).toBe("");
  });
});
