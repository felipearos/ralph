/**
 * The quality-vs-cost plot on a finished run's Results (#826). Plain inline SVG: the dashboard
 * carries no chart library, and the model (`qualityCostPlot`) already did every number, so this
 * file only maps its 0..1 fractions to pixels.
 */

import { costLabel, tokensLabel, type QualityCostPlot, type QualityCostPoint } from "./evals-model";

const WIDTH = 640;
const HEIGHT = 240;
const TOP = 12;
const BOTTOM = 40;
const LEFT = 72; // room for the y labels, which name both scales the axis carries
const RIGHT = 136; // room for the arm labels drawn to the right of the furthest mark
// The unknown-cost lane sits left of the axis's 0, so an arm without a cost never reads as the cheapest.
const LANE = 64;

const tooltip = (point: QualityCostPoint): string =>
  [
    point.arm,
    `mean score ${point.quality === null ? "—" : `${point.quality.toFixed(1)}/5`}`,
    `held-out ${point.heldOutLabel ?? "—"}`,
    `cost ${point.costLabel}`,
  ].join(" · ");

const diamond = (x: number, y: number, r: number): string => `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`;

export function QualityCostChart({ plot }: { plot: QualityCostPlot }) {
  const lane = plot.anyUnknownCost ? LANE : 0;
  const x0 = LEFT + lane;
  const x1 = WIDTH - RIGHT;
  const y0 = HEIGHT - BOTTOM;
  const yFor = (fraction: number): number => y0 - fraction * (y0 - TOP);
  const xFor = (cost: number): number => x0 + (cost / plot.xMax) * (x1 - x0);
  const unknownX = LEFT + lane / 2;
  const tickLabel = (value: number): string => (plot.unit === "usd" ? costLabel(value) : tokensLabel(value));
  const plotted = plot.points.filter((point) => point.y !== null || point.heldOutY !== null);
  const unscored = plot.points.filter((point) => point.y === null && point.heldOutY === null);

  return (
    <div className="space-y-1">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        className="max-h-60 text-foreground"
        role="img"
        aria-label={`Quality against cost (${plot.unit === "usd" ? "dollars" : "tokens"}) per arm`}
      >
        {/* Grid and axes */}
        {[0, 0.5, 1].map((fraction) => (
          <line key={fraction} x1={LEFT} x2={x1} y1={yFor(fraction)} y2={yFor(fraction)} className="stroke-border" />
        ))}
        <line x1={x0} x2={x0} y1={TOP} y2={y0} className="stroke-muted-foreground" />
        <line x1={x0} x2={x1} y1={y0} y2={y0} className="stroke-muted-foreground" />
        <g className="fill-muted-foreground text-[11px]">
          <text x={LEFT - 6} y={yFor(0)} dy="0.35em" textAnchor="end">1 · 0%</text>
          <text x={LEFT - 6} y={yFor(1)} dy="0.35em" textAnchor="end">5 · 100%</text>
          <text transform={`translate(12 ${(TOP + y0) / 2}) rotate(-90)`} textAnchor="middle">Quality</text>
          {plot.anyKnownCost && [0, 0.5, 1].map((fraction) => (
            <text key={fraction} x={x0 + fraction * (x1 - x0)} y={y0 + 14} textAnchor="middle">{tickLabel(fraction * plot.xMax)}</text>
          ))}
          <text x={(x0 + x1) / 2} y={HEIGHT - 6} textAnchor="middle">{plot.unit === "usd" ? "Cost ($)" : "Cost (tokens)"}</text>
          {plot.anyUnknownCost && <text x={unknownX} y={y0 + 28} textAnchor="middle">unknown cost</text>}
        </g>
        {plot.anyUnknownCost && <line x1={x0 - 4} x2={x0 - 4} y1={TOP} y2={y0} strokeDasharray="3 3" className="stroke-muted-foreground" />}

        {/* One group per arm: the panel score as a filled circle, the held-out rate as a hollow diamond. */}
        {plotted.map((point) => {
          const x = point.cost === null ? unknownX : xFor(point.cost);
          const labelY = point.y !== null ? yFor(point.y) : yFor(point.heldOutY ?? 0);
          return (
            <g key={point.arm}>
              <title>{tooltip(point)}</title>
              {point.y !== null && point.heldOutY !== null && (
                <line x1={x} x2={x} y1={yFor(point.y)} y2={yFor(point.heldOutY)} className="stroke-muted-foreground" strokeOpacity={0.5} />
              )}
              {point.y !== null && (
                <circle
                  cx={x}
                  cy={yFor(point.y)}
                  className="fill-current stroke-current"
                  // A partial cost is a lower bound: a larger dashed ring says the mark may sit further right.
                  r={point.costPartial ? 6 : 4.5}
                  fillOpacity={point.costPartial ? 0.6 : undefined}
                  strokeDasharray={point.costPartial ? "2 2" : undefined}
                />
              )}
              {point.heldOutY !== null && (
                <path
                  d={diamond(x, yFor(point.heldOutY), 5)}
                  className="fill-background stroke-current"
                  strokeWidth={1.5}
                  strokeDasharray={point.costPartial ? "2 2" : undefined}
                />
              )}
              <text x={x + 9} y={labelY} dy="0.35em" className="fill-current text-[11px]">
                {point.costPartial ? `${point.arm} (≥)` : point.arm}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-muted-foreground">● panel mean score (1–5) · ◇ held-out pass rate (0–100%)</p>
      {unscored.length > 0 && <p className="text-xs text-muted-foreground">not scored: {unscored.map((point) => point.arm).join(", ")}</p>}
    </div>
  );
}
