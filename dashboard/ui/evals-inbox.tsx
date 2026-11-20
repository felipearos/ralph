/**
 * The Evals tab's Inbox screen (#872): eval runs an agent or a person
 * recommended, waiting for the operator. Each row says what it runs, why,
 * who asked and when, and what it would use; Start starts it and Dismiss
 * drops it. Nothing here starts by itself: only a Start click does.
 *
 * The inbox is a relayed snapshot and start and dismiss are relayed commands,
 * so the remote page does all of it. The order is the server's (oldest
 * first): the page never re-sorts. The usage estimate is in `evals-model.ts`.
 */
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvalInboxRowView, EvalInboxWriteResult, EvalsView } from "../contracts";
import { CommandNotice, useCommand } from "./command";
import { inboxCost } from "./evals-model";
import { Quiet } from "./label";
import { useEvalInbox, useEvals } from "./use-reads";

/** A write's answer as the row's notice: the transport error, the CLI's refusal verbatim, or `done` (given the answer). */
function writeNotice(
  result: Awaited<ReturnType<ReturnType<typeof useCommand>["send"]>>,
  refused: string,
  done: (value: EvalInboxWriteResult | null) => string,
): React.ReactNode {
  if (!result.ok) return <CommandNotice error={result.error} />;
  const value = result.value as EvalInboxWriteResult | null;
  if (value !== null && !value.ok) return <span>{refused}: {value.why}</span>;
  return <span className="text-status-good">{done(value)}</span>;
}

/** Start one entry: the only way anything in the inbox runs. */
function StartAction({ row, onChanged, onNotice }: { row: EvalInboxRowView; onChanged: () => void; onNotice: (notice: React.ReactNode) => void }) {
  const start = useCommand("/api/evals/inbox/start");

  const submit = async (): Promise<void> => {
    onNotice(null);
    const result = await start.send<EvalInboxWriteResult>({ entry: row.id });
    onChanged();
    // A queued remote start answers null: the run has no id until the machine takes it.
    onNotice(writeNotice(result, "Not started", (value) =>
      value?.ok && value.run !== undefined ? `Started ${value.run}. It shows in Runs as its trials run.` : "Started. It shows in Runs as its trials run."));
  };

  return (
    <Button size="sm" disabled={start.disabled || start.pending} title={start.why ?? undefined} onClick={() => void submit()}>
      {start.queued ? "Waiting for the machine…" : start.pending ? "Starting…" : "Start"}
    </Button>
  );
}

function DismissAction({ row, onChanged, onNotice }: { row: EvalInboxRowView; onChanged: () => void; onNotice: (notice: React.ReactNode) => void }) {
  const dismiss = useCommand("/api/evals/inbox/dismiss");

  const submit = async (): Promise<void> => {
    onNotice(null);
    const result = await dismiss.send<EvalInboxWriteResult>({ entry: row.id });
    onChanged();
    onNotice(writeNotice(result, "Not dismissed", () => "Dismissed. It leaves the inbox."));
  };

  return (
    <Button size="sm" variant="ghost" disabled={dismiss.disabled || dismiss.pending} title={dismiss.why ?? undefined} onClick={() => void submit()}>
      {dismiss.queued ? "Waiting for the machine…" : dismiss.pending ? "Dismissing…" : "Dismiss"}
    </Button>
  );
}

function InboxRow({ row, history, onChanged }: { row: EvalInboxRowView; history: EvalsView["history"] | null; onChanged: () => void }) {
  const [notice, setNotice] = useState<React.ReactNode>(null);
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{row.source}</div>
        <div className="text-xs text-muted-foreground">
          arms {row.arms.join(", ")}{row.repeats > 0 ? ` · ${row.repeats} repeat${row.repeats === 1 ? "" : "s"} if they disagree` : ""}
        </div>
      </TableCell>
      <TableCell className="max-w-80 align-top text-xs whitespace-normal">{row.reason}</TableCell>
      <TableCell className="align-top text-xs">
        <div className="flex items-center gap-1.5">
          <span>{row.recommendedBy.name}</span>
          <Badge variant="outline" className="text-[10px]">{row.recommendedBy.kind}</Badge>
        </div>
        <div className="text-muted-foreground">{row.addedAt.slice(0, 16).replace("T", " ")}</div>
      </TableCell>
      <TableCell className="max-w-64 align-top text-xs whitespace-normal text-muted-foreground">{inboxCost(row.trials, history)}</TableCell>
      <TableCell className="align-top">
        <div className="flex justify-end gap-1">
          <StartAction row={row} onChanged={onChanged} onNotice={setNotice} />
          <DismissAction row={row} onChanged={onChanged} onNotice={setNotice} />
        </div>
        {notice !== null && <div className="mt-1 text-right text-xs">{notice}</div>}
      </TableCell>
    </TableRow>
  );
}

export function EvalInboxScreen() {
  const { read, refresh } = useEvalInbox();
  const { read: evalsRead, refresh: refreshEvals } = useEvals();
  if (read.state === "loading") return <Skeleton className="h-64" />;
  const view = read.data;
  // The usage estimate needs the runs' medians; before they are in, a row says it has none.
  const history = evalsRead.state === "loading" ? null : evalsRead.data?.history ?? null;
  // A started entry leaves the inbox and appears in Runs, so both are read again.
  const changed = () => { refresh(); refreshEvals(); };
  const entries = view?.entries ?? [];
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Runs recommended by an agent or a person, waiting for you to start or dismiss them.</p>
      {view?.problem && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>The inbox could not be read</AlertTitle>
          <AlertDescription><p className="font-mono text-xs break-all">{view.problem}</p></AlertDescription>
        </Alert>
      )}
      {read.state === "error" && view === null && <Quiet>{read.message}</Quiet>}
      {view !== null && view.problem === null && entries.length === 0 && (
        <Quiet>Nothing waiting. Agents and the Run screen's Add to inbox put runs here; nothing here starts by itself.</Quiet>
      )}
      {entries.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Runs</TableHead>
              <TableHead>Why</TableHead>
              <TableHead>Recommended by</TableHead>
              <TableHead>Expected usage</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((row) => <InboxRow key={row.id} row={row} history={history} onChanged={changed} />)}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
