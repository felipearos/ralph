/**
 * The triage panel (#147): what is waiting in the triager's intake, what it
 * has decided lately, and how much it has written.
 *
 * Read-only, and absent entirely on a project with no triager. Every decision
 * it makes is in `triage-model.ts` — this file only draws.
 */
import type { Dashboard } from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { IssueLink, Quiet } from "./label";
import { bucketTone, triagePanel, triageWaiting, type TriagerRow } from "./triage-model";

/** The units one triager has decided, newest first. */
function Units({ row, repoUrl }: { row: TriagerRow; repoUrl: string | null }) {
  if (row.units.length === 0) return <Quiet>No units applied yet.</Quiet>;
  return (
    <ul className="divide-y">
      {row.units.map((unit) => (
        <li key={unit.issue} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
          <span className="font-mono text-xs">
            <IssueLink repoUrl={repoUrl} issue={unit.issue} />
          </span>
          <span className="text-muted-foreground">{unit.outcome ?? "no outcome recorded"}</span>
          {unit.at && (
            <span
              className="ml-auto text-xs tabular-nums text-muted-foreground"
              title={new Date(unit.at).toLocaleString()}
            >
              {new Date(unit.at).toLocaleDateString()}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The writes line.
 *
 * The cap is labelled as the per-plan cap it is, not as an hourly budget:
 * nothing in the harness limits a triager by the hour, and a bare `14 / 30`
 * would read as one. An unconfigured cap is left out rather than guessed —
 * this dashboard's environment is not necessarily the triager's.
 */
function Writes({ row }: { row: TriagerRow }) {
  if (row.writesLastHour === null) {
    return <Quiet>Writes in the last hour: unknown — the apply ledgers could not be read.</Quiet>;
  }
  return (
    <p className="text-sm">
      <span className="text-2xl font-semibold tabular-nums tracking-tight">{row.writesLastHour}</span>{" "}
      <span className="text-muted-foreground">
        writes in the last hour
        {row.maxWrites !== null && ` · ${row.maxWrites} mutations is the cap on any one plan`}
      </span>
    </p>
  );
}

export function TriagePanel({ data, repoUrls }: { data: Dashboard; repoUrls: Record<string, string | null> }) {
  const panel = triagePanel(data);
  if (panel === null) return null;
  const waiting = triageWaiting(panel);
  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Triage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 px-5">
        {panel.buckets === null ? (
          <Quiet>The intake is unknown: the frontier could not be read.</Quiet>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
              {panel.buckets.map((row) => (
                <div key={row.bucket} className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "text-2xl font-semibold tabular-nums tracking-tight",
                      bucketTone(row) === "info" && "text-status-info",
                    )}
                  >
                    {row.count}
                  </span>
                  <span className="text-sm text-muted-foreground">{row.bucket}</span>
                  {row.next && (
                    <Badge variant="outline" className="text-[10px] uppercase">
                      next
                    </Badge>
                  )}
                </div>
              ))}
            </div>
            {/* UNTRIAGED is a second view of the routing bucket, not a fifth
                bucket, so it sits on its own line and says so. It is routing
                BEFORE the triager's eligibility fence and so the larger of the
                two: calling them the same tickets would make the smaller
                number look like a bug. */}
            <p className="text-sm text-muted-foreground">
              {waiting} waiting in the intake
              {panel.untriaged !== null &&
                ` · ${panel.untriaged} untriaged (the routing bucket before the triager's eligibility fence)`}
            </p>
          </div>
        )}
        {panel.triagers.map((row) => (
          <div key={row.loop} className="space-y-2">
            <p className="font-mono text-xs text-muted-foreground">{row.loop}</p>
            <Writes row={row} />
            <Units row={row} repoUrl={repoUrls[row.loop] ?? null} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
