/**
 * The Evals tab's Proposals screen (#874): what the improver proposed from a
 * finished run, and where each proposal stands — its subset run, its full-set
 * run and the verdict that settled it. Nothing here starts a run: a proposal's
 * subset run waits in the Inbox for a Start click.
 *
 * The proposals are a relayed snapshot, so the remote page shows them too. The
 * rationale and the analyst's answers arrive only from a project that relays
 * eval patches, so a row without them says nothing about them. The order is
 * the server's (newest first): the page never re-sorts. Labels are in
 * `evals-model.ts`.
 *
 * A passed proposal has one action, Open PR (#875): a command request that
 * opens a PR against ralph with the change and its evidence. A person merges
 * it there; nothing on this page merges or applies anything. A test-set
 * proposal (#878) never opens a PR: it is confirmed on the Test set screen.
 */
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { EvalOpenPrResult, EvalProposalRowView } from "../contracts";
import { CommandNotice, useCommand } from "./command";
import { proposalLabel, proposalOpensPr, proposalStatus, proposalVerdictSummary, type ProposalTone } from "./evals-model";
import { Quiet } from "./label";
import { useEvalProposals } from "./use-reads";

const TONE_CLASS: Record<ProposalTone, string> = {
  good: "text-status-good",
  bad: "text-status-bad",
  neutral: "",
};

/** A run link: a button, because the Runs screen is a tab of this page, not a route. */
function RunLink({ label, id, onOpenRun }: { label: string; id: string; onOpenRun: (id: string) => void }) {
  return (
    <div>
      <span className="text-muted-foreground">{label} </span>
      <button type="button" className="font-mono underline underline-offset-2 hover:text-foreground" onClick={() => onOpenRun(id)}>{id}</button>
    </div>
  );
}

/**
 * Open PR (#875), shown on a passed proposal only. The machine re-checks the
 * verdict before it opens anything, so a stale row is refused there, not here.
 */
function OpenPr({ proposal }: { proposal: string }) {
  const open = useCommand("/api/evals/proposals/open-pr");
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const send = async (): Promise<void> => {
    const result = await open.send<EvalOpenPrResult>({ proposal });
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value === null) setNotice(<span>Waiting for the machine…</span>);
    else if (!result.value.ok) setNotice(<span className="text-status-warn">{result.value.why}</span>);
    else {
      const pr = result.value;
      setNotice(
        <span>
          {pr.kind === "opened" ? "Opened " : "Already open: "}
          <a href={pr.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">PR #{pr.number}</a>
          {" — a person merges it."}
        </span>,
      );
    }
  };
  return (
    <div className="space-y-1">
      <Button variant="outline" size="xs" disabled={open.disabled || open.pending} title={open.why ?? "Opens a PR against ralph with this change and its evidence; it is never merged for you."} onClick={() => void send()}>
        {open.queued ? "Waiting for the machine…" : open.pending ? "Opening…" : "Open PR"}
      </Button>
      {notice !== null && <div className="text-xs">{notice}</div>}
    </div>
  );
}

function ProposalRow({ row, onOpenRun }: { row: EvalProposalRowView; onOpenRun: (id: string) => void }) {
  const status = proposalStatus(row.status, row.kind);
  const verdict = proposalVerdictSummary(row.verdict);
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="font-medium">{proposalLabel(row)}</div>
        {row.target !== undefined && <div className="text-xs">{row.target}</div>}
        <div className="text-xs text-muted-foreground">{row.createdAt.slice(0, 16).replace("T", " ")}</div>
      </TableCell>
      <TableCell className="align-top">
        <Badge variant="outline" className={cn("text-[10px]", TONE_CLASS[status.tone])}>{status.label}</Badge>
      </TableCell>
      <TableCell className="max-w-96 space-y-1.5 align-top text-xs whitespace-normal">
        {row.reason !== null && <p>{row.reason}</p>}
        {verdict !== null && (
          <div>
            <div className={cn("font-medium", row.verdict!.pass ? "text-status-good" : "text-status-bad")}>{verdict.headline}</div>
            <ul className="space-y-0.5">
              {verdict.conditions.map((condition, index) => (
                <li key={index} className={cn(!condition.pass && "text-status-warn")}>{condition.label}</li>
              ))}
            </ul>
          </div>
        )}
        {row.rationale !== undefined && <p className="text-muted-foreground">{row.rationale}</p>}
        {row.answers !== undefined && row.answers.length > 0 && (
          <ul className="space-y-0.5">
            {row.answers.map((answer, index) => (
              <li key={index}>
                <Badge variant="outline" className="mr-2 text-[10px]">{answer.knob} → {answer.target}</Badge>
                {answer.change}
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="align-top text-xs">
        <RunLink label="From" id={row.run} onOpenRun={onOpenRun} />
        {row.runs.subset !== null && <RunLink label="Subset" id={row.runs.subset} onOpenRun={onOpenRun} />}
        {row.runs.full !== null && <RunLink label="Full set" id={row.runs.full} onOpenRun={onOpenRun} />}
      </TableCell>
      <TableCell className="align-top">
        {proposalOpensPr(row) && <OpenPr proposal={row.id} />}
      </TableCell>
    </TableRow>
  );
}

export function EvalProposalsScreen({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const { read } = useEvalProposals();
  if (read.state === "loading") return <Skeleton className="h-64" />;
  const view = read.data;
  const proposals = view?.proposals ?? [];
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">What the improver proposed from a run, and the runs and verdict that settle each proposal.</p>
      {view?.problem && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>The proposals could not be read</AlertTitle>
          <AlertDescription><p className="font-mono text-xs break-all">{view.problem}</p></AlertDescription>
        </Alert>
      )}
      {read.state === "error" && view === null && <Quiet>{read.message}</Quiet>}
      {view !== null && view.problem === null && proposals.length === 0 && (
        <Quiet>No proposals yet: Propose improvement on a finished run's card starts one.</Quiet>
      )}
      {view?.problem === null && proposals.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Proposal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Why and verdict</TableHead>
              <TableHead>Runs</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposals.map((row) => <ProposalRow key={row.id} row={row} onOpenRun={onOpenRun} />)}
          </TableBody>
        </Table>
      )}
      {view?.problem === null && view.problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {view.problems.map((problem, index) => <li key={index} className="font-mono break-all">{problem}</li>)}
        </ul>
      )}
    </div>
  );
}
