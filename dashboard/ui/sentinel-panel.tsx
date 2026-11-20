/**
 * The Sentinel panel (felipearos/ralph#685): what the sentinel has seen in the
 * error reporter, read from its issue store through `GET /api/sentinel`.
 *
 * Absent entirely on a project with no sentinel loop. The read is a relayed
 * snapshot, so the remote page draws it too. Every decision it makes is in
 * `sentinel-model.ts`; this file only draws.
 */
import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Quiet } from "./label";
import { sentinelPanel, type SentinelRow } from "./sentinel-model";
import { useSentinelPanel } from "./use-reads";

/** A section heading with its count, in the weight the other panels use. */
const Section = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (
  <div className="space-y-2">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {title} · <span className="tabular-nums">{count}</span>
    </p>
    {count === 0 ? <Quiet>None.</Quiet> : children}
  </div>
);

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0";

const External = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
    {children}
  </a>
);

function IssueLine({ row }: { row: SentinelRow }) {
  return (
    <li className={ROW}>
      <span className="font-medium">{row.sentryUrl !== null ? <External href={row.sentryUrl}>{row.title}</External> : row.title}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{row.counts}</span>
      {row.ticket !== null && (
        <span className="font-mono text-xs">
          {row.ticket.href !== null ? <External href={row.ticket.href}>{row.ticket.label}</External> : row.ticket.label}
        </span>
      )}
      {row.attempts !== null && <span className="text-xs text-status-warn">{row.attempts}</span>}
      {row.regressed !== null && (
        <Badge variant="outline" className="text-[10px]">
          {row.regressed}
        </Badge>
      )}
      <span className="ml-auto text-xs text-muted-foreground" title={row.updatedAt}>
        {row.updated}
      </span>
    </li>
  );
}

export function SentinelPanel({ repoUrls }: { repoUrls: Record<string, string | null> }) {
  const { read } = useSentinelPanel();
  // A failed poll after a good one keeps the last answer; only a first failure has nothing to draw.
  const data = read.state === "loading" ? null : read.data;
  // Nothing until a read answers, and nothing on a first failure either: the
  // read is asked on every project, and with no answer nobody knows whether
  // this one has a sentinel at all. A failure after a good read keeps it.
  if (data === null) return null;
  // Every loop works one repo; any loop's link is the ticket's.
  const repoUrl = Object.values(repoUrls).find((url) => url !== null) ?? null;
  const panel = sentinelPanel(data, new Date(), repoUrl);
  if (panel === null) return null;
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Sentinel</CardTitle>
        {(panel.headline !== null || panel.cap !== null) && (
          <div className="flex flex-wrap items-baseline gap-x-3 text-xs text-muted-foreground">
            {panel.headline !== null && <span className="text-status-warn">{panel.headline}</span>}
            {panel.cap !== null && <span className="tabular-nums">{panel.cap}</span>}
            {panel.capAlert !== null && <span className="font-medium text-status-warn">{panel.capAlert}</span>}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        {panel.problem !== null ? (
          <Alert className="bg-transparent">
            <CircleAlert className="text-status-warn" />
            <AlertTitle>What the sentinel has seen could not be read</AlertTitle>
            <AlertDescription>
              <p className="font-mono text-xs break-all">{panel.problem}</p>
            </AlertDescription>
          </Alert>
        ) : panel.empty !== null ? (
          <Quiet>{panel.empty}</Quiet>
        ) : (
          <>
            {panel.groups.map((group) => (
              <Section key={group.state} title={group.label} count={group.rows.length}>
                <ul className="divide-y">
                  {group.rows.map((row) => (
                    <IssueLine key={row.key} row={row} />
                  ))}
                </ul>
              </Section>
            ))}
            {panel.wouldHaveFiled.length > 0 && (
              <Section title="Would have filed" count={panel.wouldHaveFiled.length}>
                <ul className="divide-y">
                  {panel.wouldHaveFiled.map((row) => (
                    <li key={row.key} className={ROW}>
                      <span>{row.sentryUrl !== null ? <External href={row.sentryUrl}>{row.text}</External> : row.text}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
