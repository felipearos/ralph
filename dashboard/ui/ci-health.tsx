/**
 * The CI health panel (felipearos/ralph#160): what the ci-doctor knows about
 * CI, read from its store and nothing else.
 *
 * Read-only, absent entirely on a project with no ci-doctor, and no network
 * call of any kind — the read is already on the `Dashboard` by the time this
 * draws. Every decision it makes is in `ci-health-model.ts`; this file only
 * draws.
 */
import type { CiCaseView, CiParkedView, Dashboard } from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  anyWaits,
  attentionSummary,
  caseTone,
  caseWord,
  ciHealthPanel,
  ciStrip,
  ciTrend,
  costParts,
  incidentTone,
  stateWord,
  subjectOf,
  testName,
  trendState,
  waitCell,
  waitTone,
  type CiStripTile,
  type CiTrendView,
} from "./ci-health-model";
import { IssueLink, PullLink, Quiet } from "./label";

const TONE_TEXT = {
  good: "text-status-good",
  bad: "text-status-bad",
  warn: "text-status-warn",
  neutral: "text-foreground",
} as const;

/** A section heading, in the weight the other panels use for one. */
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="space-y-2">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
    {children}
  </div>
);

/** A timestamp as a local date-time, with the raw instant in the title. */
const When = ({ at }: { at: string }) => (
  <span title={at} className="tabular-nums">
    {new Date(at).toLocaleString()}
  </span>
);

/**
 * Only the tones that ask for attention tint the frame — the same classes the
 * controls' notices use — so a green main does not compete with a red one.
 */
const TONE_FRAME: Partial<Record<CiStripTile["tone"], string>> = {
  warn: "border-status-warn/25 bg-status-warn/[0.04]",
  bad: "border-status-bad/25 bg-status-bad/[0.04]",
};

/** The four answers across the top of the panel; `ciStrip` decides them all. */
function Strip({ tiles }: { tiles: CiStripTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.key} className={cn("min-w-0 rounded-lg border p-3", TONE_FRAME[tile.tone])}>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{tile.label}</p>
          <p className="mt-1 flex items-baseline gap-1.5">
            <span
              className={cn("text-2xl font-semibold tabular-nums tracking-tight", TONE_TEXT[tile.tone])}
              title={tile.title ?? undefined}
            >
              {tile.value}
            </span>
            {tile.unit !== null && <span className="text-xs text-muted-foreground">{tile.unit}</span>}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={tile.detail}>
            {tile.detail}
          </p>
        </div>
      ))}
    </div>
  );
}

/** A pill, for the table's kind and state: the shared Badge is a bare label. */
const PILL = "rounded-full border px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal";

/**
 * The flake table: one row per case, worst first, as the reader ordered them.
 *
 * A case that has taken main down carries a red bar on its left edge, because
 * `caseTone` makes it the row an operator must act on whatever else it cost,
 * and a tinted number in the middle of a row is easy to read past.
 */
function Cases({ cases, more, repoUrl }: { cases: CiCaseView[]; more: number; repoUrl: string | null }) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Test</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Ticket</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((entry) => {
            const test = testName(entry.subject);
            const cost = costParts(entry);
            return (
              <TableRow key={entry.key}>
                <TableCell
                  className={cn(
                    "max-w-[24rem]",
                    caseTone(entry) === "bad" && "shadow-[inset_2px_0_0_var(--status-bad)]",
                  )}
                  title={entry.subject}
                >
                  <p className="truncate text-sm font-medium">{test.name}</p>
                  {test.path !== null && (
                    <p className="truncate font-mono text-xs text-muted-foreground">{test.path}</p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn(
                      PILL,
                      entry.kind === "regression"
                        ? "border-status-bad/40 bg-status-bad/[0.06] text-status-bad"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {entry.kind}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  <span className="text-sm font-semibold text-foreground">{cost.reds}</span> {cost.redsWords} ·{" "}
                  <span className={cn(cost.mainTone === "bad" && "font-semibold text-status-bad")}>{cost.main}</span> ·{" "}
                  {cost.dequeues}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Badge variant="outline" className={cn(PILL, "border-border text-muted-foreground")}>
                    {stateWord(entry.state)}
                  </Badge>
                  {entry.heldBy !== null && (
                    <Badge variant="outline" className="ml-2 text-[10px] uppercase">
                      {entry.heldBy}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.issue !== null && <IssueLink repoUrl={repoUrl} issue={entry.issue} />}
                  {entry.pr !== null && (
                    <>
                      {entry.issue !== null && " · "}
                      <PullLink repoUrl={repoUrl} pr={entry.pr} />
                    </>
                  )}
                  {entry.issue === null && entry.pr === null && <span className="text-muted-foreground">not filed</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {more > 0 && <Quiet>+{more} more, by what they have cost.</Quiet>}
    </>
  );
}

/**
 * One parked ticket.
 *
 * The ticket's title and the loop whose `-blocked` it wears are not on disk —
 * `ci-doctor/gate.ts` rebuilds those from a GitHub search every poll, and this
 * panel makes no network call — so the row is the issue link, the flake it was
 * parked on, and whether it has been unparked before.
 */
function Parked({ entry, repoUrl }: { entry: CiParkedView; repoUrl: string | null }) {
  const last = entry.unparks[0] ?? null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
      <span className="font-mono text-xs">
        <IssueLink repoUrl={repoUrl} issue={entry.issue} />
      </span>
      <span className="text-muted-foreground">{stateWord(entry.state)}</span>
      {entry.rule !== null && (
        <span className="max-w-[20rem] truncate font-mono text-xs" title={entry.rule}>
          {subjectOf(entry.rule)}
        </span>
      )}
      {entry.heldBy !== null && (
        <Badge variant="outline" className="text-[10px] uppercase">
          {entry.heldBy}
        </Badge>
      )}
      {last === null ? (
        <span className="ml-auto text-xs text-muted-foreground">never unparked</span>
      ) : (
        <span className="ml-auto text-xs text-muted-foreground">unparked {entry.unparks.length}×</span>
      )}
    </li>
  );
}

/**
 * The 14-day trend of the doctor's own success measure (#163): known-flake
 * reds per day, and the worst parked-ticket count that day.
 *
 * Two bars a day on ONE scale, because the eye compares their heights whatever
 * the caption says. Drawn as divs rather than with a chart library: fourteen
 * days of two counters is a shape, not a visualisation, and the panel must
 * render with no client JavaScript.
 *
 * Every day is a focusable column whose popover carries its exact numbers on
 * hover, keyboard focus or tap, so the chart does not have to be readable to
 * the pixel. The heights, the ticks, the axis labels, the popover wording and
 * which side it opens on, and the choice between the chart and either of its
 * two empty sentences are all `ciTrend`'s in `ci-health-model.ts`; this draws
 * them.
 */
function Trend({ trend }: { trend: CiTrendView }) {
  const state = trendState(trend);
  if (state === "unrecorded") {
    return <Quiet>The doctor has recorded no days here yet.</Quiet>;
  }
  if (state === "quiet") {
    return <Quiet>No known-flake reds and no parked tickets in the last 14 days.</Quiet>;
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <LegendSwatch tone="bg-status-bad/70">Known-flake reds</LegendSwatch>
          <LegendSwatch tone="bg-status-warn/70">Tickets parked on a flake</LegendSwatch>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <TrendFigure label="Reds · 14 d" value={trend.reds} tone="text-status-bad" />
          <TrendFigure label="Parked · worst day" value={trend.parkedPeak} tone="text-status-warn" />
          <TrendFigure label="Reds · today" value={trend.todayReds} tone="text-foreground" />
        </div>
      </div>
      <div className="flex gap-2">
        {/* The y-axis: each label sits at its value's own height on the shared scale. */}
        <div className="relative h-28 w-6 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground" aria-hidden="true">
          {trend.ticks.map((tick) => (
            <span key={tick} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(tick / trend.peak) * 100}%` }}>
              {tick}
            </span>
          ))}
        </div>
        <div className="relative h-28 flex-1">
          {trend.ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden="true"
              className={cn("absolute inset-x-0 border-t border-border", tick === 0 ? "border-solid" : "border-dashed")}
              style={{ bottom: `${(tick / trend.peak) * 100}%` }}
            />
          ))}
          {/*
            The bars are the role="img"; the focusable day columns are a
            sibling layer over them, because an img's children are
            presentational and a focusable thing inside one is unreachable to
            a screen reader.
          */}
          <div className="absolute inset-0 flex items-end gap-1" role="img" aria-label="known-flake reds and parked tickets per day, last 14 days">
            {trend.bars.map((bar) => (
              <div
                key={bar.day}
                className={cn(
                  "flex h-full flex-1 items-end justify-center gap-px rounded-sm px-0.5",
                  bar.today && "bg-foreground/[0.04] ring-1 ring-inset ring-border",
                )}
              >
                <div className="w-1/2 rounded-t-sm bg-status-bad/70" style={{ height: `${bar.redHeight}%` }} />
                <div className="w-1/2 rounded-t-sm bg-status-warn/70" style={{ height: `${bar.parkedHeight}%` }} />
              </div>
            ))}
          </div>
          <div className="absolute inset-0 flex gap-1">
            {trend.bars.map((bar) => (
              <div
                key={bar.day}
                tabIndex={0}
                aria-label={bar.detail.aria}
                className="group relative h-full flex-1 rounded-sm outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div
                  className={cn(
                    "pointer-events-none absolute top-1 z-10 hidden whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md group-hover:block group-focus:block",
                    bar.flip ? "right-full mr-1" : "left-full ml-1",
                  )}
                >
                  <p className="font-medium">{bar.detail.label}</p>
                  <p className="tabular-nums text-status-bad">{bar.detail.reds}</p>
                  <p className="tabular-nums text-status-warn">{bar.detail.parked}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex gap-2" aria-hidden="true">
        <div className="w-6 shrink-0" />
        <div className="flex flex-1 gap-1 text-[10px] text-muted-foreground">
          {trend.bars.map((bar) => (
            <span
              key={bar.day}
              className={cn("flex-1 whitespace-nowrap text-center", bar.today && "font-semibold text-foreground")}
            >
              {bar.axisLabel}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A legend entry: the series' own swatch, then its name. */
const LegendSwatch = ({ tone, children }: { tone: string; children: string }) => (
  <span className="flex items-center gap-1.5">
    <span className={cn("size-[9px] rounded-[3px]", tone)} aria-hidden="true" />
    {children}
  </span>
);

/** One of the header's figures: the number large, what it counts under it. */
const TrendFigure = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
  <div className="text-right">
    <p className={cn("text-lg font-semibold leading-tight tabular-nums", tone)}>{value}</p>
    <p className="text-[10px] text-muted-foreground">{label}</p>
  </div>
);

/** One wait cell: the day's median large, the week's under it. */
const Wait = ({
  title,
  day,
  week,
}: {
  title: string;
  day: { minutes: number | null; iterations: number };
  week: { minutes: number | null; iterations: number };
}) => {
  const cell = waitCell(day, week);
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="flex items-baseline gap-1.5" title={cell.title}>
        {cell.figure !== null && (
          <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", TONE_TEXT[waitTone(day.minutes)])}>
            {cell.figure}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{cell.unit}</span>
      </p>
      <p className="text-xs tabular-nums text-muted-foreground">{cell.week}</p>
    </div>
  );
};

/**
 * A parked ticket's unpark history, drawn rather than hidden in a `title`.
 *
 * The issue names the history as its own thing, and a tooltip is unreachable on
 * touch, unselectable and unprintable. The diagnosis is shown past its
 * `<kind>:` prefix, as every other subject in this panel is.
 */
function Unparks({ entry }: { entry: CiParkedView }) {
  if (entry.unparks.length === 0) return null;
  return (
    <ul className="space-y-0.5 pl-4 text-xs text-muted-foreground">
      {entry.unparks.map((unpark, index) => (
        <li key={`${unpark.at}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
          <When at={unpark.at} />
          <span className="max-w-[20rem] truncate font-mono" title={unpark.diagnosis}>
            {subjectOf(unpark.diagnosis)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One of the panel's cards, in the weight every other dashboard card has. */
const PanelCard = ({
  title,
  action,
  actionTitle,
  children,
}: {
  title: string;
  action?: string | null;
  actionTitle?: string;
  children: React.ReactNode;
}) => (
  <Card className="gap-4 py-5 shadow-none">
    <CardHeader className="px-5">
      <CardTitle className="text-sm">{title}</CardTitle>
      {action != null && (
        <CardAction className="text-xs tabular-nums text-muted-foreground" title={actionTitle}>
          {action}
        </CardAction>
      )}
    </CardHeader>
    <CardContent className="space-y-5 px-5">{children}</CardContent>
  </Card>
);

/**
 * The panel, as one card per question an operator asks of CI: what needs
 * attention, what it costs, and how it has gone — under the strip that
 * answers the four questions asked before any of those.
 */
export function CiHealthPanel({ data, repoUrls }: { data: Dashboard; repoUrls: Record<string, string | null> }) {
  const panel = ciHealthPanel(data);
  if (panel === null) return null;
  // Every loop works one repo; any loop's link is the ticket's.
  const repoUrl = Object.values(repoUrls).find((url) => url !== null) ?? null;
  const health = panel.health;
  const attention =
    health === null
      ? null
      : attentionSummary({
          incidents: health.incidents.length,
          cases: health.cases.length + panel.moreCases,
          parked: health.parked.length,
        });
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">CI health</h2>
        {/* Every other project-scoped panel dates its picture; this is the one
            read taken fresh on every poll, so saying when is cheap and the
            operator should not have to assume it. */}
        {panel.readAt !== null && (
          <span className="text-xs text-muted-foreground" title={panel.readAt}>
            read {new Date(panel.readAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {health === null ? (
        <PanelCard title="CI health">
          <Quiet>CI health is unknown: {panel.problem ?? "the store could not be read."}</Quiet>
        </PanelCard>
      ) : (
        <>
          {/* The base branch's own section is gone: its colour, its age
              and its build are the strip's first tile. So is the retries
              section: the strip's last tile carries the count, the cap and
              whether the figure is today's (`ciStrip` says why that matters). */}
          <Strip tiles={ciStrip(health, Date.now())} />

          {/* Absent rather than empty when there is nothing to act on: a card
              titled "Needs attention" with nothing in it would ask for
              attention anyway. `attentionSummary` is null exactly then. */}
          {attention !== null && (
            <PanelCard title="Needs attention" action={attention}>
              {health.incidents.length > 0 && (
                <Section title="open infra incidents">
                  <ul className="divide-y">
                    {health.incidents.map((entry) => (
                      <li key={entry.key} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm first:pt-0 last:pb-0">
                        <span className={cn("font-mono text-xs", TONE_TEXT[incidentTone(entry)])}>{entry.subject}</span>
                        <span className="text-muted-foreground">{stateWord(entry.state)}</span>
                        {/* An incident starts no iteration, so a notification is
                            the whole of the doctor's response to it: whether one
                            went out is the first thing worth knowing. */}
                        <span className={cn("text-xs", entry.notified ? "text-muted-foreground" : TONE_TEXT.warn)}>
                          {entry.notified ? "reported" : "not reported yet"}
                        </span>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                          {entry.redBuilds} reds/72h
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {health.cases.length > 0 && (
                <Section title="flakes and regressions">
                  <Cases cases={health.cases} more={panel.moreCases} repoUrl={repoUrl} />
                </Section>
              )}

              {health.parked.length > 0 && (
                <Section title="tickets parked on a flake">
                  <ul className="divide-y">
                    {health.parked.map((entry) => (
                      <li key={entry.issue} className="py-2 first:pt-0 last:pb-0">
                        <ul>
                          <Parked entry={entry} repoUrl={repoUrl} />
                        </ul>
                        <Unparks entry={entry} />
                      </li>
                    ))}
                  </ul>
                </Section>
              )}
            </PanelCard>
          )}

          <PanelCard title="What it costs">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
              {/* The figure and what it IS, in one breath. It is reds × median
                  BUILD time, because nothing persists a per-job duration, so it
                  over-states a flake in a short job inside a long build; printing
                  the number without that sentence would read as measured. */}
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">CI time lost · 24h</p>
                {health.lostTime.reds === 0 ? (
                  // The good case, and it must not read as instrumentation
                  // failure: there is no estimate because there is nothing to
                  // estimate.
                  <Quiet>No known-flake reds in the last 24 hours.</Quiet>
                ) : health.lostTime.minutes === null ? (
                  <Quiet>
                    {health.lostTime.reds} known-flake reds in 24 h, but no red build in the window could be timed, so
                    there is no estimate.
                  </Quiet>
                ) : (
                  <>
                    <p className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-semibold tabular-nums tracking-tight">
                        {health.lostTime.minutes}
                      </span>
                      <span className="text-xs text-muted-foreground">min</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      estimated lost to {health.lostTime.reds} known-flake reds in 24 h · from the median build time (
                      {health.lostTime.medianBuildMinutes} min), not job time
                    </p>
                  </>
                )}
              </div>

              {/* What an iteration spends WAITING, which is the other half of
                  what a flake costs: the estimate beside it is CI's time, these
                  are the loops'. Computed from the coders' own wait logs, so a
                  project whose loops have opened no PR has nothing here and
                  that is not a fault. */}
              {anyWaits(health.waits) ? (
                <>
                  <Wait
                    title="Loops waiting on CI"
                    day={{ minutes: health.waits.day.ciMinutes, iterations: health.waits.day.ciIterations }}
                    week={{ minutes: health.waits.week.ciMinutes, iterations: health.waits.week.ciIterations }}
                  />
                  <Wait
                    title="Waiting on the queue"
                    day={{ minutes: health.waits.day.queueMinutes, iterations: health.waits.day.queueIterations }}
                    week={{ minutes: health.waits.week.queueMinutes, iterations: health.waits.week.queueIterations }}
                  />
                </>
              ) : (
                <div className="sm:col-span-2">
                  <Quiet>No iteration has waited on CI or on the queue in the last 7 days.</Quiet>
                </div>
              )}
            </div>
            {/* The unreadable list is named rather than swallowed — "no waits"
                and "nobody looked" are different answers and only one of them
                is good news. */}
            {health.waits.unreadable.length > 0 && (
              <Quiet>
                {health.waits.unreadable.length} worktree
                {health.waits.unreadable.length === 1 ? "" : "s"} could not be read, so these medians are
                incomplete: {health.waits.unreadable.join(", ")}
              </Quiet>
            )}
          </PanelCard>

          {/* The ticket's own success measure, both halves of it, as the
              14-day trend it asks for. It sits after the estimate above
              because that is 24 hours and this is the fortnight around it:
              one bad day beside the shape it belongs to. */}
          <PanelCard title="History" action="14 days">
            <Section title="known-flake reds and parked tickets">
              <Trend trend={ciTrend(health.metrics)} />
            </Section>

            {health.reverts.length > 0 && (
              <Section title="reverts">
                <ul className="divide-y">
                  {health.reverts.map((entry) => (
                    <li
                      key={entry.culprit}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0"
                    >
                      <span className="font-mono text-xs" title={entry.culprit}>
                        {entry.culprit.slice(0, 7)}
                      </span>
                      <span className={cn(entry.state === "abandoned" ? TONE_TEXT.warn : "text-muted-foreground")}>
                        {entry.state}
                      </span>
                      <span className="font-mono text-xs">
                        <IssueLink repoUrl={repoUrl} issue={entry.issue} />
                        {entry.pr !== null && (
                          <>
                            {" · "}
                            <PullLink repoUrl={repoUrl} pr={entry.pr} />
                          </>
                        )}
                      </span>
                      {entry.forwardIssue !== null && (
                        <span className="ml-auto font-mono text-xs text-muted-foreground">
                          forward fix <IssueLink repoUrl={repoUrl} issue={entry.forwardIssue} />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </PanelCard>
        </>
      )}

      {/* Outside the ternary above, because WHO the doctors are is true
          whether or not the store could be read. What each one holds is not:
          `caseWord` is told whether the read happened, so an unread store
          says "case unknown" rather than "holding no case". */}
      <PanelCard title="The doctors">
        <ul className="space-y-1">
          {panel.doctors.map((row) => (
            <li key={row.loop} className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{row.loop}</span>
              <span className={cn("truncate", row.case === null && "text-muted-foreground")} title={row.case?.key}>
                {caseWord(row.case, health !== null)}
              </span>
            </li>
          ))}
        </ul>
      </PanelCard>
    </div>
  );
}

/**
 * The CI health page. The panel draws nothing for a project with no ci-doctor,
 * which is right among the Agents page's other panels but would leave its own
 * page blank, so here that case says why.
 */
export function CiHealthPage({ data, repoUrls }: { data: Dashboard; repoUrls: Record<string, string | null> }) {
  if (ciHealthPanel(data) === null) {
    return (
      <Card className="gap-4 py-5 shadow-none">
        <CardHeader className="px-5">
          <CardTitle className="text-sm">CI health</CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          <Quiet>This project runs no ci-doctor, so nothing reads its CI. Add one from the Agents page to see it here.</Quiet>
        </CardContent>
      </Card>
    );
  }
  return <CiHealthPanel data={data} repoUrls={repoUrls} />;
}
