export function usd(value: number): string {
  if (value === 0) return "$0.000";
  if (value > 0 && value < 0.0005) return "<$0.001";
  if (value < 1) return `$${value.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
  if (value < 10_000) return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Math.round(value).toLocaleString()}`;
}

const TOKEN_UNITS = [
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
] as const;

/**
 * Token counts the way the Usage page prints them: `950`, `1.2k`, `48M`,
 * `1.4B`. `exact` keeps one decimal at any size, for chart ticks that must
 * read as the gridline they label (`12.5M`, not `13M`).
 */
export function compactTokens(value: number, { exact = false }: { exact?: boolean } = {}): string {
  // The largest unit the value reaches; bumped below when rounding reaches
  // the next one, so 999,999 reads as 1M rather than 1000k.
  let unit = TOKEN_UNITS.find(([divisor]) => value >= divisor);
  if (unit === undefined) {
    const rounded = Math.round(value);
    if (rounded < 1_000) return String(rounded);
    unit = TOKEN_UNITS[2];
  }
  const decimals = (scaled: number) => (exact || scaled < 10 ? 1 : 0);
  let scaled = value / unit[0];
  if (Number(scaled.toFixed(decimals(scaled))) >= 1_000 && unit !== TOKEN_UNITS[0]) {
    unit = TOKEN_UNITS[TOKEN_UNITS.indexOf(unit) - 1]!;
    scaled = value / unit[0];
  }
  return `${scaled.toFixed(decimals(scaled)).replace(/\.0$/, "")}${unit[1]}`;
}
