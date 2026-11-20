import { describe, expect, it } from "vitest";

import { chileDate, chileDateTime, chileTime, instantMs } from "./chile-time";

describe("chileDate and chileTime", () => {
  it("read a UTC instant as day, month and year, and as 24h time, in Santiago", () => {
    // October is summer time, UTC-3.
    for (const value of ["2026-10-22T19:04:00.000Z", Date.parse("2026-10-22T19:04:00.000Z"), new Date("2026-10-22T19:04:00.000Z")]) {
      expect(chileDate(value)).toBe("22-10-2026");
      expect(chileTime(value)).toBe("16:04");
    }
  });

  it("put a late UTC evening on the Chilean day it fell on", () => {
    expect(chileDate("2026-10-19T02:30:00.000Z")).toBe("18-10-2026");
    expect(chileTime("2026-10-19T02:30:00.000Z")).toBe("23:30");
  });

  it("follow the April change back to UTC-4: the hour before midnight is lived twice", () => {
    // 2026-04-05 00:00 local, clocks go back to 23:00 of the 4th.
    expect(chileDateTime("2026-04-05T02:30:00.000Z")).toBe("04-04-2026 23:30");
    expect(chileDateTime("2026-04-05T03:30:00.000Z")).toBe("04-04-2026 23:30");
    expect(chileDate("2026-04-05T04:30:00.000Z")).toBe("05-04-2026");
    expect(chileTime("2026-04-05T04:30:00.000Z")).toBe("00:30");
  });

  it("follow the September change to UTC-3: midnight skips to one", () => {
    expect(chileDateTime("2026-09-06T03:59:00.000Z")).toBe("05-09-2026 23:59");
    expect(chileTime("2026-09-06T04:00:00.000Z")).toBe("01:00");
    expect(chileDate("2026-09-06T04:00:00.000Z")).toBe("06-09-2026");
  });

  it("show a dash for a missing or unreadable date", () => {
    for (const format of [chileDate, chileTime, chileDateTime]) {
      expect(format(null)).toBe("-");
      expect(format(undefined)).toBe("-");
      expect(format("")).toBe("-");
      expect(format("not a date")).toBe("-");
      expect(format(Number.NaN)).toBe("-");
      expect(format(new Date(Number.NaN))).toBe("-");
    }
  });
});

describe("instantMs", () => {
  it("sorts by the whole instant: two reports on one day order by their time, and a missing one sorts oldest", () => {
    const values = ["2026-10-22T19:04:00.000Z", null, "2026-10-22T12:00:00.000Z", "2026-10-21T23:00:00.000Z"];
    expect([...values].sort((a, b) => instantMs(a) - instantMs(b))).toEqual([null, "2026-10-21T23:00:00.000Z", "2026-10-22T12:00:00.000Z", "2026-10-22T19:04:00.000Z"]);
  });
});
