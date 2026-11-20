/**
 * The Labels page: every label the project's loops claim, park, finish and
 * triage with, which loops need each, and whether the repository has it — then
 * the repository's labels no loop needs.
 *
 * Read-only. A missing label is shown with the command that creates it, the
 * same remedy `preflight`'s `loop-labels` check gives; nothing here creates
 * one. Every decision is in `labels-model.ts`; this file only draws.
 */
import { CircleAlert, CircleCheck, CircleHelp, RotateCw } from "lucide-react";

import type { ProjectLabelView } from "../contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { isRemote } from "./api";
import { Quiet } from "./label";
import { LOCAL_ONLY } from "./remote-model";
import { createCommand, labelHref, labelsPage, swatch } from "./labels-model";
import { useLabels } from "./use-reads";

function Swatch({ color }: { color: string | null }) {
  const fill = swatch(color);
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-full border"
      style={fill === null ? undefined : { backgroundColor: fill, borderColor: fill }}
    />
  );
}

function Presence({ onRepo }: { onRepo: boolean | null }) {
  if (onRepo === true) return <CircleCheck className="size-4 shrink-0 text-status-good" aria-label="on the repository" />;
  if (onRepo === false) return <CircleAlert className="size-4 shrink-0 text-status-bad" aria-label="missing from the repository" />;
  return <CircleHelp className="size-4 shrink-0 text-muted-foreground" aria-label="unknown" />;
}

function Row({ label, repo }: { label: ProjectLabelView; repo: string | null }) {
  const href = labelHref(repo, label.name);
  return (
    <li className="space-y-1 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Presence onRepo={label.onRepo} />
        <Swatch color={label.color} />
        {href === null || label.onRepo === false ? (
          <span className="font-mono text-sm">{label.name}</span>
        ) : (
          <a href={href} target="_blank" rel="noreferrer" className="font-mono text-sm underline-offset-4 hover:underline">
            {label.name}
          </a>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {label.usedBy.map((user) => (
            <Badge key={user.loop} variant="outline" className="font-mono text-[11px]" title={user.role}>
              {user.loop}
            </Badge>
          ))}
        </span>
      </div>
      {label.description !== null && <p className="pl-11 text-xs text-muted-foreground">{label.description}</p>}
      {label.onRepo === false && (
        <p className="pl-11 text-xs text-status-bad">
          Missing — the preflight refuses these loops a start. <code className="font-mono">{createCommand(repo, label.name)}</code>
        </p>
      )}
    </li>
  );
}

export function LabelsPage() {
  // The remote dashboard does not relay this read: it runs a `bun` per loop.
  if (isRemote()) return <Quiet>{LOCAL_ONLY}</Quiet>;
  return <LabelsList />;
}

/**
 * `GET /api/labels` through the shared Query layer: on mount, a minute after
 * each read settles (`labelsRead` in `reads.ts`), and on Refresh. Not every
 * five seconds like the agents feed: each read is a `bun` per loop and a
 * GitHub call, and labels change when an operator changes them. Refresh is
 * disabled while a read is in flight; the store never stacks a second on one.
 * An error after a good read keeps the labels on screen.
 */
function LabelsList() {
  const { read, refresh, busy } = useLabels();
  if (read.state === "loading") return <Skeleton className="h-64" />;
  const view = read.data;
  // Not loading and no data can only be a first read that failed.
  if (view === null) {
    const why = read.state === "error" ? read.message : "no answer";
    return <Quiet>The labels could not be read ({why}). They are read on the machine running the loops.</Quiet>;
  }
  // A minute between polls is long to look at stale labels without knowing.
  const stale = read.state === "error" ? read.message : null;
  const page = labelsPage(view);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          The labels this project's loops need — each loop's preflight, and the frontier labels every coder reads —
          checked against{" "}
          <span className="font-mono">{view.repo ?? "the repository"}</span>.
        </p>
        <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={refresh}>
          <RotateCw className="size-3.5" />
          Refresh
        </Button>
      </div>
      {stale !== null && <p className="text-xs text-status-warn">The last refresh failed ({stale}); these are the labels from the read before it.</p>}
      {view.problems.map((problem) => (
        <p key={problem} className="text-xs text-status-warn">
          {problem}
        </p>
      ))}
      <Card className="gap-4 py-5 shadow-none">
        <CardHeader className="px-5">
          <CardTitle className="text-sm">
            Needed by the loops
            <Badge variant="secondary" className="ml-2 tabular-nums">
              {page.needed.length}
            </Badge>
            {page.missing > 0 && (
              <Badge variant="outline" className="ml-2 text-status-bad tabular-nums">
                {page.missing} missing
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5">
          {page.needed.length === 0 ? (
            <Quiet>No loop's labels could be read.</Quiet>
          ) : (
            <ul className="divide-y">
              {page.needed.map((label) => (
                <Row key={label.name} label={label} repo={view.repo} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {page.other.length > 0 && (
        <Card className="gap-4 py-5 shadow-none">
          <CardHeader className="px-5">
            <CardTitle className="text-sm">
              Other labels on the repository, needed by no loop
              <Badge variant="secondary" className="ml-2 tabular-nums">
                {page.other.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5">
            <ul className="divide-y">
              {page.other.map((label) => (
                <Row key={label.name} label={label} repo={view.repo} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
