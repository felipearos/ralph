import { describe, expect, it } from "vitest";

import { compactTokens, usd } from "./usage-format";

describe("usd", () => {
  it("uses cents below ten dollars and mills below one dollar", () => {
    expect(usd(4.428)).toBe("$4.43");
    expect(usd(0.3214)).toBe("$0.321");
    expect(usd(0)).toBe("$0.000");
    expect(usd(0.0004)).toBe("<$0.001");
  });

  it("keeps larger totals compact", () => {
    expect(usd(14.428)).toBe("$14.43");
    expect(usd(10_428)).toBe("$10,428");
  });
});

describe("compactTokens", () => {
  it("keeps a decimal below ten of a unit and drops it above", () => {
    expect(compactTokens(950)).toBe("950");
    expect(compactTokens(1_234)).toBe("1.2k");
    expect(compactTokens(48_400_000)).toBe("48M");
    expect(compactTokens(1_400_000_000)).toBe("1.4B");
  });

  it("moves up a unit rather than print a thousand of one", () => {
    expect(compactTokens(999.6)).toBe("1k");
    expect(compactTokens(999_999)).toBe("1M");
  });

  it("keeps the decimal a chart tick needs", () => {
    expect(compactTokens(12_500_000, { exact: true })).toBe("12.5M");
    expect(compactTokens(25_000, { exact: true })).toBe("25k");
  });
});
