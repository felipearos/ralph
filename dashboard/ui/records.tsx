/**
 * The loop records the observer reads beside presence: claimed tickets, the
 * machine-wide ownership map, the loop's journal, its token usage, and the
 * runner failure recorded for its run.
 *
 * Every one of them keeps the API's distinction between unknown and empty: a
 * `null` is a source that could not be read and says so, never an empty list
 * or a zero that would read as a quiet, healthy loop.
 */
import { CircleAlert } from "lucide-react";

import type {
  ClaimView,
  Dashboard,
  JournalEntryView,
  RunnerFailureProjection,
  TokenUsage as TokenCounts,
  UsageView,
} from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { IssueLink, Quiet } from "./label";
import { compactTokens } from "./usage";

/* ------------------------------------------------------------- primitives */

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE_TINT: Record<Tone, string> = {
  good: "border-status-good/30 bg-status-good/10 text-status-good",
  warn: "border-status-warn/30 bg-status-warn/10 text-status-warn",
  bad: "border-status-bad/30 bg-status-bad/10 text-status-bad",
  neutral: "border-border bg-muted/40 text-muted-foreground",
};

const STATUS_TONE: Record<string, Tone> = {
  active: "good",
  expired: "neutral",
  unknown: "warn",
  contested: "bad",
};

function StatusChip({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("capitalize", TONE_TINT[STATUS_TONE[status] ?? "neutral"])}>
      {status}
    </Badge>
  );
}

const localTime = (iso: string): string => new Date(iso).toLocaleString();

/* ----------------------------------------------------------------- claims */

/** A claim's expiry means something only while it is active; the others say what they are. */
export function expiry(claim: ClaimView): string {
  if (claim.status === "active" && claim.expiresAt) return `expires ${new Date(claim.expiresAt).toLocaleTimeString()}`;
  if (claim.status === "expired" && claim.expiresAt) return `expired ${new Date(claim.expiresAt).toLocaleTimeString()}`;
  return "expiry unknown";
}

/** Where a claim's evidence comes from: the lease, the label, or both. */
function evidence(claim: ClaimView): string {
  const label = claim.labeled === null ? "label unknown" : claim.labeled ? "labeled" : "no label";
  return claim.leased ? `leased · ${label}` : label;
}

/** The tickets one loop claims. */
export function ClaimsList({ claims, repoUrl }: { claims: ClaimView[]; repoUrl: string | null }) {
  if (claims.length === 0) return <Quiet>No claimed tickets.</Quiet>;
  return (
    <ul className="divide-y">
      {claims.map((claim) => (
        <li key={`${claim.issue}-${claim.loop}`} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-mono text-xs">
              <IssueLink repoUrl={repoUrl} issue={claim.issue} />
            </span>
            <StatusChip status={claim.status} />
            <span className="text-xs text-muted-foreground" title={claim.expiresAt ? localTime(claim.expiresAt) : undefined}>
              {expiry(claim)}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">{evidence(claim)}</span>
          </div>
          {claim.title && <p className="truncate text-sm text-muted-foreground">{claim.title}</p>}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- ownership */

/**
 * Every claimed or in-flight ticket on the machine and the loop that owns it.
 * A contested ticket — two loops contending for it — is the row to look for.
 */
export function Ownership({
  ownership,
  repoUrls,
}: {
  ownership: Dashboard["ownership"];
  repoUrls: Record<string, string | null>;
}) {
  const blind = Object.entries(ownership.sources)
    .filter(([, health]) => health !== "ok")
    .map(([source]) => source);
  // Every loop works one repo; any loop's link is the ticket's.
  const repoUrl = Object.values(repoUrls).find((url) => url !== null) ?? null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Ownership</h2>
        <p className="text-sm text-muted-foreground">
          Claimed and in-flight tickets across every loop on this machine, and which loop owns each.
        </p>
      </div>
      {blind.length > 0 && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>Unavailable: {blind.join(", ")}</AlertTitle>
          <AlertDescription>Claims that source would confirm show as unknown.</AlertDescription>
        </Alert>
      )}
      {ownership.issues.length === 0 ? (
        <Quiet>No claimed or in-flight tickets.</Quiet>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20">Issue</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Claims</TableHead>
                <TableHead>Working</TableHead>
                <TableHead className="w-full">Title</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ownership.issues.map((entry) => (
                <TableRow key={entry.issue} className={cn(entry.status === "contested" && "bg-status-bad/[0.04]")}>
                  <TableCell className="font-mono text-xs">
                    <IssueLink repoUrl={repoUrl} issue={entry.issue} />
                  </TableCell>
                  <TableCell>{entry.owner ?? <span className="text-muted-foreground">none</span>}</TableCell>
                  <TableCell>
                    <StatusChip status={entry.status} />
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    {entry.claims.map((claim) => `${claim.loop} (${claim.status})`).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{entry.working.join(", ") || "—"}</TableCell>
                  <TableCell className="max-w-0 truncate" title={entry.title ?? undefined}>
                    {entry.title ?? <span className="text-muted-foreground">title unknown</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/** Reconciliation rows for loop records that resolve to no roster loop. */
export function unattributedRows(unattributed: Dashboard["unattributed"]): { kind: string; path: string; detail: string }[] {
  return unattributed.map((item) => ({
    kind: "unattributed",
    path: item.worktree,
    detail: item.owner ? `record owned by ${item.owner}` : item.stateProblem ? `record ${item.stateProblem}` : "owner unknown",
  }));
}

/* ---------------------------------------------------------------- journal */

/** The loop's own recent journal entries, newest first. */
export function JournalList({ journal, repoUrl }: { journal: JournalEntryView[] | null; repoUrl: string | null }) {
  if (journal === null) return <Quiet>Unknown: the journal could not be read.</Quiet>;
  if (journal.length === 0) return <Quiet>No entries signed by this loop.</Quiet>;
  return (
    <ul className="divide-y">
      {journal.map((entry) => (
        <li key={entry.name} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">
              {entry.issue === null ? "no ticket" : <IssueLink repoUrl={repoUrl} issue={entry.issue} />}
            </span>
            <span>{entry.outcome ?? "no outcome recorded"}</span>
            {entry.at && (
              <span className="ml-auto tabular-nums" title={localTime(entry.at)}>
                {new Date(entry.at).toLocaleDateString()}
              </span>
            )}
          </div>
          <p className="truncate text-sm" title={entry.title ?? entry.name}>
            {entry.title ?? <span className="font-mono text-xs text-muted-foreground">{entry.name}</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- tokens */

const inOut = (usage: TokenCounts): string =>
  `${compactTokens(usage.inputTotal)} in · ${compactTokens(usage.output)} out`;

/** The run's token usage and how full the model's context is. Null is unknown, never zero. */
export function TokenUsage({ usage }: { usage: UsageView | null }) {
  if (usage === null) return <Quiet>Unknown: no usage is attributed to this loop's run.</Quiet>;
  const { context } = usage;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
          <span>
            {compactTokens(context.tokens)}
            {context.window !== null && <span className="text-muted-foreground"> / {compactTokens(context.window)}</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {context.percent === null ? "window unknown" : `${context.percent}% of context`}
          </span>
        </div>
        {context.percent !== null && <Progress value={Math.min(100, context.percent)} className="h-1.5" />}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Run</dt>
          <dd className="mt-0.5 truncate tabular-nums">
            {usage.run === null ? (
              <span className="text-muted-foreground">unknown</span>
            ) : (
              `${inOut(usage.run.usage)} · ${usage.run.steps} steps`
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Iteration</dt>
          <dd className="mt-0.5 truncate tabular-nums">
            {inOut(usage.iteration.usage)} · {usage.iteration.turns} turns
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Model</dt>
          <dd className="mt-0.5 truncate font-mono text-[13px]">
            {context.model ?? <span className="text-muted-foreground">unknown</span>}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Session</dt>
          <dd className="mt-0.5 truncate font-mono text-[13px]" title={usage.session}>
            {usage.session}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/* --------------------------------------------------------- runner failure */

/**
 * The runner failure recorded for the run, when there is one. `none` is only a
 * readable record for a run that did not fail, so it and `unknown` render as a
 * quiet line, never as a clean bill of health.
 */
export function RunnerFailure({
  failure,
  repoUrl,
  compact = false,
}: {
  failure: RunnerFailureProjection;
  repoUrl: string | null;
  compact?: boolean;
}) {
  if (failure.state !== "failed" || failure.reason === null) {
    if (compact) return null;
    return (
      <Quiet>{failure.state === "none" ? "None recorded for this run." : "Unknown: no readable record for this run."}</Quiet>
    );
  }
  const reason = failure.reason;
  return (
    <Alert variant={failure.current ? "destructive" : "default"} className={cn("bg-transparent", compact && "px-3 py-2")}>
      <CircleAlert />
      <AlertTitle className="line-clamp-none">
        <span className="flex flex-wrap items-center gap-2">
          {failure.current ? "Runner failure" : "Earlier runner failure"}
          <Badge variant="outline" className="font-mono font-normal">
            {reason.kind}
          </Badge>
          <span className="font-mono text-xs font-normal text-muted-foreground">{reason.stage}</span>
          {reason.iteration !== null && (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">iteration {reason.iteration}</span>
          )}
          {reason.visibility === "post-hoc" && (
            <span className="text-xs font-normal text-muted-foreground">found after the run</span>
          )}
        </span>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p className={cn(compact && "line-clamp-2")}>{reason.summary}</p>
        {!failure.current && <p className="text-xs text-muted-foreground">The loop carried on past it.</p>}
        {!compact && (
          <>
            {reason.evidence.length > 0 && (
              <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {reason.evidence.join("\n")}
              </pre>
            )}
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {(reason.runner || reason.model) && (
                <span className="font-mono">{[reason.runner, reason.model].filter(Boolean).join(" · ")}</span>
              )}
              <span>exit {reason.exitCode}</span>
              {reason.issue !== null && (
                <span className="font-mono">
                  <IssueLink repoUrl={repoUrl} issue={reason.issue} />
                </span>
              )}
              <span className="tabular-nums">{localTime(reason.at)}</span>
            </p>
            {reason.note && <p className="text-xs text-muted-foreground">{reason.note}</p>}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
