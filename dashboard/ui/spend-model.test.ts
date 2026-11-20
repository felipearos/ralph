import { describe, expect, it } from "vitest";

import type { DailySpendView } from "../contracts";
import { niceCeil, providerOf, shiftDay, spendOverview } from "./spend-model";

const tokens = (output: number) => ({ input: 1, output, cacheRead: 10, cacheWrite: 2 });

const DAILY: DailySpendView[] = [
  { date: "2026-08-10", models: [{ model: "claude-opus-5", costUsd: 100, tokens: tokens(1) }] },
  {
    date: "2026-11-02",
    models: [
      { model: "claude-opus-5", costUsd: 4, tokens: tokens(100) },
      { model: "codex/gpt-5.6-terra", costUsd: null, tokens: tokens(500) },
    ],
  },
  {
    date: "2026-11-04",
    models: [
      { model: "claude-sonnet-5", costUsd: 1.5, tokens: tokens(50) },
      { model: "opencode-go/glm-5.3", costUsd: 0.5, tokens: tokens(20) },
    ],
  },
];

describe("providerOf", () => {
  it("keys a model by the provider UsageBar names it under", () => {
    expect(providerOf("claude-opus-5")).toBe("claude");
    expect(providerOf("codex/gpt-5.6-terra")).toBe("codex");
    expect(providerOf("opencode-go/glm-5.3")).toBe("opencodego");
    expect(providerOf("unknown")).toBe("other");
  });
});

describe("shiftDay", () => {
  it("moves on the calendar, across month ends", () => {
    expect(shiftDay("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftDay("2026-11-04", -6)).toBe("2026-10-29");
  });
});

describe("spendOverview", () => {
  it("folds only the range's days, every date present and zero where nothing ran", () => {
    const week = spendOverview(DAILY, 7, "2026-11-04");
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(week.costUsd).toBe(6);
    // Highest cost first; Codex last, tokens without a cost.
    expect(week.providers.map((p) => [p.provider, p.costUsd, p.priced])).toEqual([
      ["claude", 5.5, true],
      ["opencodego", 0.5, true],
      ["codex", 0, false],
    ]);
    expect(week.activeDays.map((day) => day.date)).toEqual(["2026-11-04", "2026-11-02"]);
    expect(week.days.at(-1)!.cost).toEqual([1.5, 0.5, 0]);
    expect(week.models.find((model) => model.model === "codex/gpt-5.6-terra")).toMatchObject({ costUsd: null, tokens: 513 });
    expect(week.output).toBe(670);
  });

  it("reaches back ninety days for the longest range, and only today for the shortest", () => {
    expect(spendOverview(DAILY, 90, "2026-11-04").costUsd).toBe(106);
    expect(spendOverview(DAILY, 1, "2026-11-04")).toMatchObject({ costUsd: 2, days: [{ date: "2026-11-04" }] });
  });
});

describe("an empty provider", () => {
  it("is left out: a $0 run with no model split has nothing to show", () => {
    const daily: DailySpendView[] = [
      {
        date: "2026-11-04",
        models: [
          { model: "claude-opus-5", costUsd: 2, tokens: tokens(10) },
          { model: "unknown", costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    ];
    const view = spendOverview(daily, 7, "2026-11-04");
    expect(view.providers.map((provider) => provider.provider)).toEqual(["claude"]);
    expect(view.models.map((model) => model.model)).toEqual(["claude-opus-5"]);
    expect(view.days.at(-1)!.cost).toEqual([2]);
  });
});

describe("niceCeil", () => {
  it("rounds an axis up to a readable step", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(7.3)).toBe(10);
    expect(niceCeil(180)).toBe(200);
    expect(niceCeil(2_300_000)).toBe(2_500_000);
  });
});
