/**
 * The Following panel (felipearos/ralph#569): what the verifier is following
 * into production, read from its watch store and nothing else.
 *
 * Absent entirely on a project with no verifier, and no network call — the
 * read is already on the `Dashboard` by the time this draws. Every decision
 * it makes is in `following-model.ts`; this file only draws.
 */
import { CircleAlert } from "lucide-react";

import type { DashboardOverview } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { followingPanel } from "./following-model";
import { issueHref } from "./issue-link";
import { PullLink, Quiet } from "./label";

/** A section heading with its count, in the weight the other panels use. */
const Section = ({ title, count, children }: { title: string; count: number; children: React.ReactNode }) => (
  <div className="space-y-2">
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {title} · <span className="tabular-nums">{count}</span>
    </p>
    {count === 0 ? <Quiet>None.</Quiet> : children}
  </div>
);

/**
 * The ticket as the CLI spelt it, linked where the tracker allows. Not
 * `IssueLink`: that re-spells the number with the page's prefix, and the
 * store already carries the reference the verifier itself used.
 */
function Ticket({ repoUrl, ticket, ticketRef }: { repoUrl: string | null; ticket: number; ticketRef: string }) {
  const href = issueHref(repoUrl, ticket);
  if (href === null) return <>{ticketRef}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      {ticketRef}
    </a>
  );
}

const ROW = "flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0";

export function FollowingPanel({ data, repoUrls }: { data: DashboardOverview; repoUrls: Record<string, string | null> }) {
  // The poll's own clock, as the backlog uses, so "overdue by" agrees with the
  // read rather than drifting with however long the tab has been open.
  const panel = followingPanel(data, new Date(data.generatedAt));
  if (panel === null) return null;
  // Every loop works one repo; any loop's link is the ticket's.
  const repoUrl = Object.values(repoUrls).find((url) => url !== null) ?? null;
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Following</CardTitle>
        {panel.readAt !== null && (
          <span className="text-xs text-muted-foreground" title={panel.readAt}>
            read {new Date(panel.readAt).toLocaleTimeString()}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        {panel.problem !== null ? (
          <Alert className="bg-transparent">
            <CircleAlert className="text-status-warn" />
            <AlertTitle>What the verifier is following could not be read</AlertTitle>
            <AlertDescription>
              <p className="font-mono text-xs break-all">{panel.problem}</p>
            </AlertDescription>
          </Alert>
        ) : panel.empty !== null ? (
          <Quiet>{panel.empty}</Quiet>
        ) : (
          <>
            <Section title="in progress" count={panel.inProgress.length}>
              <ul className="divide-y">
                {panel.inProgress.map((row) => (
                  <li key={row.key} className={ROW}>
                    <span className="font-mono text-xs">
                      <Ticket repoUrl={repoUrl} ticket={row.ticket} ticketRef={row.ticketRef} /> ·{" "}
                      <PullLink repoUrl={repoUrl} pr={row.pr} />
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {row.mode}
                    </Badge>
                    <span className="text-xs text-muted-foreground">round {row.round}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{row.checkIns} check-ins</span>
                    {row.next !== null && (
                      <span
                        className={cn("ml-auto text-xs tabular-nums", row.next.overdue ? "text-status-warn" : "text-muted-foreground")}
                        title={row.next.dueAt}
                      >
                        next {row.next.label} · {row.next.relative}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="finished" count={panel.finished.length}>
              <ul className="divide-y">
                {panel.finished.map((row) => (
                  <li key={row.key} className={ROW}>
                    <span className="font-mono text-xs">
                      <Ticket repoUrl={repoUrl} ticket={row.ticket} ticketRef={row.ticketRef} /> ·{" "}
                      <PullLink repoUrl={repoUrl} pr={row.pr} />
                    </span>
                    <span className="font-medium">{row.verdict ?? "no verdict recorded"}</span>
                    {row.reason !== null && <span className="text-muted-foreground">{row.reason}</span>}
                    {row.note !== null && <span className="text-xs text-status-warn">{row.note}</span>}
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="would have acted" count={panel.wouldHaveActed.length}>
              <ul className="divide-y">
                {panel.wouldHaveActed.map((row) => (
                  <li key={row.key} className={ROW}>
                    <span className="font-mono text-xs">
                      <Ticket repoUrl={repoUrl} ticket={row.ticket} ticketRef={row.ticketRef} /> ·{" "}
                      <PullLink repoUrl={repoUrl} pr={row.pr} />
                    </span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {row.verdict}
                    </Badge>
                    <span className="text-muted-foreground">{row.reason}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{row.where}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="not verifiable live" count={panel.notVerifiableLive.length}>
              <ul className="divide-y">
                {panel.notVerifiableLive.map((row) => (
                  <li key={row.key} className={ROW}>
                    <span className="font-mono text-xs">
                      <Ticket repoUrl={repoUrl} ticket={row.ticket} ticketRef={row.ticketRef} />
                    </span>
                    <span>{row.criterion}</span>
                    {row.detail !== null && <span className="text-muted-foreground">{row.detail}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
