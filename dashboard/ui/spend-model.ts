/**
 * The Spend panel's numbers, folded from the usage report's daily series for
 * one range: UsageBar's cost dashboard (`costOverview` in its GNOME
 * extension), over the costs the loops' runners reported rather than list
 * prices. Pure: the date the range ends on is an argument.
 */
import type { DailySpendView, ModelSpendView } from "../contracts";

export type SpendRange = 1 | 7 | 30 | 90;
export type SpendMetric = "cost" | "tokens";

export const SPEND_RANGES: readonly { days: SpendRange; label: string }[] = [
  { days: 1, label: "TODAY" },
  { days: 7, label: "7 DAYS" },
  { days: 30, label: "30 DAYS" },
  { days: 90, label: "90 DAYS" },
];

/**
 * The provider a model's spend belongs to, keyed as UsageBar keys its
 * providers so the brand table names and colours it. A delegated runner books
 * `provider/model`; a Claude run books the bare model name.
 */
export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash).replace(/-/g, "");
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gpt") || /^o\d/.test(model)) return "codex";
  if (model.startsWith("gemini")) return "gemini";
  return "other";
}

/** Every token a model's entry counts: input, output and both cache directions. */
export const totalTokens = (model: ModelSpendView): number =>
  model.tokens.input + model.tokens.output + model.tokens.cacheRead + model.tokens.cacheWrite;

/**
 * The calendar date of an instant in this page's time zone, `YYYY-MM-DD`.
 * The server buckets days in the host's zone (`usage.ts`'s `localDay`, which
 * the page may not import); the page is the operator's own on that host, so
 * the two agree.
 */
export function localDay(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface SpendProvider {
  provider: string;
  costUsd: number;
  /** False when nothing this provider ran in the range reported a cost (Codex). */
  priced: boolean;
  tokens: number;
}

export interface SpendDay {
  date: string;
  /** Per provider, in `providers` order. */
  cost: number[];
  tokens: number[];
  totalCost: number;
  totalTokens: number;
}

export interface SpendModel {
  provider: string;
  model: string;
  costUsd: number | null;
  tokens: number;
}

export interface SpendOverview {
  range: SpendRange;
  costUsd: number;
  tokens: number;
  /** Highest cost first, then highest tokens. */
  providers: SpendProvider[];
  /** Every date of the range, oldest first, zero where nothing ran. */
  days: SpendDay[];
  /** Days that ran anything, newest first: the Day breakdown. */
  activeDays: SpendDay[];
  models: SpendModel[];
  cacheRead: number;
  input: number;
  cacheWrite: number;
  output: number;
}

/** `YYYY-MM-DD` shifted by whole days, on the calendar rather than the clock. */
export function shiftDay(date: string, by: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + by));
  return shifted.toISOString().slice(0, 10);
}

export function spendOverview(daily: readonly DailySpendView[], range: SpendRange, today: string): SpendOverview {
  const first = shiftDay(today, -(range - 1));
  const inRange = daily.filter((day) => day.date >= first && day.date <= today);

  const providers = new Map<string, SpendProvider>();
  const models = new Map<string, SpendModel>();
  const totals = { cacheRead: 0, input: 0, cacheWrite: 0, output: 0 };
  for (const day of inRange) {
    for (const entry of day.models) {
      const provider = providerOf(entry.model);
      const tally = providers.get(provider) ?? { provider, costUsd: 0, priced: false, tokens: 0 };
      if (entry.costUsd !== null) {
        tally.costUsd += entry.costUsd;
        tally.priced = true;
      }
      tally.tokens += totalTokens(entry);
      providers.set(provider, tally);

      const key = `${provider}\u0000${entry.model}`;
      const model = models.get(key) ?? { provider, model: entry.model, costUsd: null, tokens: 0 };
      if (entry.costUsd !== null) model.costUsd = (model.costUsd ?? 0) + entry.costUsd;
      model.tokens += totalTokens(entry);
      models.set(key, model);

      totals.cacheRead += entry.tokens.cacheRead;
      totals.input += entry.tokens.input;
      totals.cacheWrite += entry.tokens.cacheWrite;
      totals.output += entry.tokens.output;
    }
  }
  // A provider with neither cost nor tokens in the range (a $0 run booked
  // with no model split) has nothing to show.
  const order = [...providers.values()]
    .filter((provider) => provider.costUsd > 0 || provider.tokens > 0)
    .sort((left, right) => right.costUsd - left.costUsd || right.tokens - left.tokens);
  const index = new Map(order.map((provider, position) => [provider.provider, position]));

  const byDate = new Map(inRange.map((day) => [day.date, day]));
  const days: SpendDay[] = [];
  for (let offset = 0; offset < range; offset += 1) {
    const date = shiftDay(first, offset);
    const cost = order.map(() => 0);
    const tokens = order.map(() => 0);
    for (const entry of byDate.get(date)?.models ?? []) {
      const position = index.get(providerOf(entry.model));
      if (position === undefined) continue;
      cost[position]! += entry.costUsd ?? 0;
      tokens[position]! += totalTokens(entry);
    }
    days.push({
      date,
      cost,
      tokens,
      totalCost: cost.reduce((sum, value) => sum + value, 0),
      totalTokens: tokens.reduce((sum, value) => sum + value, 0),
    });
  }

  return {
    range,
    costUsd: order.reduce((sum, provider) => sum + provider.costUsd, 0),
    tokens: order.reduce((sum, provider) => sum + provider.tokens, 0),
    providers: order,
    days,
    activeDays: days.filter((day) => day.totalTokens > 0 || day.totalCost > 0).reverse(),
    models: [...models.values()].filter((model) => (model.costUsd ?? 0) > 0 || model.tokens > 0).sort(
      (left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0) || right.tokens - left.tokens,
    ),
    ...totals,
  };
}

/** An axis maximum rounded up to 1, 2, 2.5 or 5 × 10ⁿ, as UsageBar's chart rounds it. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}
