import { useMemo, useState } from "react";

import type { DailySpendView } from "../contracts";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { localDay, niceCeil, SPEND_RANGES, spendOverview, type SpendDay, type SpendMetric, type SpendRange } from "./spend-model";
import { ProviderMark, providerColor, Segmented, Tile } from "./usage-parts";
import { compactTokens, usd } from "./usage-format";
import { providerBrand } from "./usagebar-brand";

/*
 * The Spend panel: UsageBar's cost dashboard laid out in this page's own
 * cards — a range switch, the total with each provider's share, daily bars by
 * cost or tokens, token figures, and a breakdown by model or by day.
 */

const CHART_HEIGHT = 168;
const MAX_MODELS = 12;
const MAX_DAYS = 12;

const pct = (fraction: number): string => `${(Number.isFinite(fraction) ? fraction * 100 : 0).toFixed(1)}%`;

/** `Nov 4`, read as a calendar date so no time zone moves it. */
function dayText(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const heading = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

function DailyBars({ days, providers, metric }: { days: SpendDay[]; providers: string[]; metric: SpendMetric }) {
  const valuesOf = (day: SpendDay) => (metric === "cost" ? day.cost : day.tokens);
  const peak = Math.max(0, ...days.map((day) => valuesOf(day).reduce((sum, value) => sum + value, 0)));
  const top = niceCeil(peak);
  const tick = (value: number) => (metric === "cost" ? usd(value) : compactTokens(value, { exact: true }));
  const labelled = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);
  return (
    <div className="flex gap-2">
      <div
        className="flex min-w-12 flex-col justify-between text-right text-[10px] text-muted-foreground tabular-nums"
        style={{ height: CHART_HEIGHT }}
      >
        <span>{tick(top)}</span>
        <span>{tick(top / 2)}</span>
        <span>{tick(0)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex items-end gap-px border-b" style={{ height: CHART_HEIGHT }}>
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed" />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed" />
          {days.map((day) => {
            const values = valuesOf(day);
            const total = values.reduce((sum, value) => sum + value, 0);
            return (
              <Tooltip key={day.date}>
                <TooltipTrigger asChild>
                  <div className="relative flex h-full min-w-0 flex-1 flex-col-reverse hover:bg-muted/60">
                    {providers.map((provider, index) => {
                      const value = values[index] ?? 0;
                      if (value <= 0) return null;
                      return (
                        <div
                          key={provider}
                          className="w-full"
                          style={{ height: `${(value / top) * 100}%`, backgroundColor: providerColor(provider) }}
                        />
                      );
                    })}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="flex-col items-start gap-0.5">
                  <span className="font-medium">
                    {dayText(day.date)} · {tick(total)}
                  </span>
                  {providers.map((provider, index) =>
                    (values[index] ?? 0) > 0 ? (
                      <span key={provider} className="tabular-nums">
                        {providerBrand(provider).name} {tick(values[index] ?? 0)}
                      </span>
                    ) : null,
                  )}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <div className="mt-1 flex text-[10px] text-muted-foreground">
          {days.map((day, index) => (
            <span
              key={day.date}
              className={cn(
                "min-w-0 flex-1 whitespace-nowrap",
                index === days.length - 1 && days.length > 1 ? "text-right" : index > 0 && "text-center",
              )}
            >
              {labelled.has(index) ? dayText(day.date) : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const RANGE_OPTIONS = SPEND_RANGES.map((option) => ({
  value: String(option.days) as `${SpendRange}`,
  label: option.days === 1 ? "Today" : `${option.days} days`,
}));

/**
 * The Spend panel for one scope's daily series: this project's, every
 * project's, or the machine's.
 */
export function SpendPanel({
  daily,
  generatedAt,
  scopeLabel,
  caption = "Reported cost",
  captionNote = "As the loops' runners reported it.",
  estimate = false,
}: {
  daily: DailySpendView[];
  generatedAt: string;
  scopeLabel: string;
  caption?: string;
  captionNote?: string;
  /** The figures are list-price estimates (UsageBar's), so the total carries its asterisk. */
  estimate?: boolean;
}) {
  const [range, setRange] = useState<SpendRange>(30);
  const [metric, setMetric] = useState<SpendMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "day">("model");
  const today = localDay(generatedAt);
  const ov = useMemo(() => spendOverview(daily, range, today), [daily, range, today]);
  const providers = ov.providers.map((provider) => provider.provider);
  const observed = ov.cacheRead + ov.input + ov.cacheWrite;
  const activeDayCount = Math.max(1, ov.activeDays.length);

  return (
    <Card className="gap-5 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Spend</CardTitle>
        <CardDescription>{scopeLabel}</CardDescription>
        <CardAction>
          <Segmented
            label="Spend range"
            options={RANGE_OPTIONS}
            value={String(range) as `${SpendRange}`}
            onChange={(value) => setRange(Number(value) as SpendRange)}
          />
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5 px-5">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="space-y-4">
            <div>
              <div className={heading}>{caption}</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                {usd(ov.costUsd)}
                {estimate && <span className="text-muted-foreground">*</span>}
              </div>
              <div className="text-xs text-muted-foreground">{captionNote}</div>
            </div>
            {ov.providers.length === 0 && <p className="text-sm text-muted-foreground">Nothing ran in this range.</p>}
            {ov.providers.map((provider) => {
              const share = ov.costUsd > 0 ? provider.costUsd / ov.costUsd : 0;
              return (
                <div key={provider.provider} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <ProviderMark provider={provider.provider} />
                    <span className="flex-1 font-medium">{providerBrand(provider.provider).name}</span>
                    <span className="tabular-nums">{provider.priced ? usd(provider.costUsd) : "—"}</span>
                  </div>
                  <div
                    role="meter"
                    aria-label={`${providerBrand(provider.provider).name} share of cost`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(share * 100)}
                    className="h-1.5 overflow-hidden rounded-full bg-muted"
                  >
                    <div className="h-full rounded-full" style={{ width: `${share * 100}%`, backgroundColor: providerColor(provider.provider) }} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {provider.priced ? `${pct(share)} of cost` : "No cost reported"} · {compactTokens(provider.tokens)} tokens
                  </div>
                </div>
              );
            })}
          </div>

          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h3 className={cn(heading, "flex-1")}>{metric === "cost" ? "Daily cost" : "Daily tokens"}</h3>
              {ov.providers.map((provider) => (
                <span key={provider.provider} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(provider.provider) }} />
                  {providerBrand(provider.provider).name}
                </span>
              ))}
              <Segmented
                label="Chart metric"
                options={[
                  { value: "cost", label: "Cost" },
                  { value: "tokens", label: "Tokens" },
                ]}
                value={metric}
                onChange={setMetric}
              />
            </div>
            <DailyBars days={ov.days} providers={providers} metric={metric} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Processed tokens" value={compactTokens(ov.tokens)} hint={`${compactTokens(Math.round(ov.tokens / activeDayCount))} per active day`} />
          <Tile label="Cached input" value={compactTokens(ov.cacheRead)} hint={`${pct(observed > 0 ? ov.cacheRead / observed : 0)} of observed input`} />
          <Tile label="Uncached input" value={compactTokens(ov.input)} hint={`${compactTokens(ov.cacheWrite)} cache writes`} />
          <Tile label="Output" value={compactTokens(ov.output)} hint={`${pct(ov.tokens > 0 ? ov.output / ov.tokens : 0)} of processed`} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className={heading}>Breakdown</h3>
            <Segmented
              label="Breakdown"
              options={[
                { value: "model", label: "By model" },
                { value: "day", label: "By day" },
              ]}
              value={breakdown}
              onChange={setBreakdown}
            />
          </div>
          <div className="-mx-5 overflow-x-auto border-t">
            {breakdown === "model" ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-5">Model</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="pr-5 text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ov.models.slice(0, MAX_MODELS).map((model) => (
                    <TableRow key={`${model.provider}:${model.model}`}>
                      <TableCell className="pl-5">
                        <span className="flex items-center gap-2">
                          <ProviderMark provider={model.provider} className="size-3.5" />
                          <span className="font-mono text-xs">{model.model}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {model.costUsd === null ? (
                          <span className="text-xs text-muted-foreground" title="No cost was reported for this model">
                            not reported
                          </span>
                        ) : (
                          usd(model.costUsd)
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                        {model.costUsd === null ? "—" : pct(ov.costUsd > 0 ? model.costUsd / ov.costUsd : 0)}
                      </TableCell>
                      <TableCell className="pr-5 text-right text-xs tabular-nums">{compactTokens(model.tokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-5">Day</TableHead>
                    {ov.providers.map((provider) => (
                      <TableHead key={provider.provider} className="text-right">
                        {providerBrand(provider.provider).name}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="pr-5 text-right">Tokens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ov.activeDays.slice(0, MAX_DAYS).map((day) => (
                    <TableRow key={day.date}>
                      <TableCell className="pl-5">{dayText(day.date)}</TableCell>
                      {ov.providers.map((provider, index) => (
                        <TableCell key={provider.provider} className="text-right text-xs text-muted-foreground tabular-nums">
                          {provider.priced ? usd(day.cost[index] ?? 0) : `${compactTokens(day.tokens[index] ?? 0)} tok`}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-medium tabular-nums">{usd(day.totalCost)}</TableCell>
                      <TableCell className="pr-5 text-right text-xs tabular-nums">{compactTokens(day.totalTokens)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          {breakdown === "model" && ov.models.length > MAX_MODELS && (
            <p className="text-xs text-muted-foreground">+{ov.models.length - MAX_MODELS} more models</p>
          )}
          {breakdown === "day" && ov.activeDays.length > MAX_DAYS && (
            <p className="text-xs text-muted-foreground">+{ov.activeDays.length - MAX_DAYS} earlier active days</p>
          )}
          {breakdown === "day" && ov.activeDays.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing ran in this range.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
