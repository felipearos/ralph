/**
 * The "adding a new agent" guide, beside the Add-agent form.
 *
 * It renders `adding-an-agent.md` from the harness checkout — the file the
 * operator would otherwise have to find and read — with its Loggd examples
 * rewritten for this project and for the name being typed into the form. The
 * dashboard holds no copy of the steps or of either table: what is not in the
 * file does not appear here (`dashboard/guide-model.test.ts`).
 *
 * Read-only, and local-only: the file is on the machine, so the remote
 * dashboard answers its route with LocalOnly and the panel says so.
 */
import { BookOpen, ChevronDown } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { GuideView } from "../contracts";
import { parseGuide, substituteGuide, type GuideTable } from "./guide-model";
import { useAgentGuide } from "./use-reads";

/** `GET /api/agents/guide`, read once: a file in the harness checkout. */
function useGuide(): { view: GuideView | null; failed: string | null } {
  const { read } = useAgentGuide();
  return {
    view: read.state === "ready" ? read.data : null,
    failed: read.state === "error" ? read.message : null,
  };
}

/**
 * One of the guide's tables. Its cells carry inline markdown — `code` above
 * all — and are shown as the file writes them: the panel is a reading of the
 * guide, not a re-authoring of it.
 */
/** A guide section's header; the chevron stands where the old disclosure triangle did, and turns the same way. */
function FoldTrigger({ children }: { children: React.ReactNode }) {
  return (
    <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-sm font-medium">
      <ChevronDown className="size-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-data-[state=open]:rotate-0" />
      <span>{children}</span>
    </CollapsibleTrigger>
  );
}

function GuideMarkdownTable({ table }: { table: GuideTable }) {
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          {table.headers.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map((row, at) => (
          <TableRow key={at}>
            {row.map((cell, column) => (
              <TableCell key={column} className="align-top whitespace-pre-wrap">
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The guide, for the agent being added.
 *
 * `name` is what has been typed into the form, or null while it is empty — in
 * which case the guide keeps its own `<name>` placeholder rather than showing
 * commands with an empty name in them.
 */
export function AgentGuide({ name }: { name: string | null }) {
  const { view, failed } = useGuide();
  if (failed !== null) {
    return (
      <section className="space-y-2 rounded-xl border bg-card p-4" aria-label="Adding an agent">
        <Heading />
        <p className="text-xs text-muted-foreground">The guide is read from the machine's harness checkout: {failed}</p>
      </section>
    );
  }
  if (view === null) {
    return (
      <section className="space-y-2 rounded-xl border bg-card p-4" aria-label="Adding an agent">
        <Heading />
        <p className="text-xs text-muted-foreground">Reading the guide…</p>
      </section>
    );
  }
  const guide = parseGuide(view.markdown);
  const shown = (text: string): string => substituteGuide(text, guide.examples, view.values, name);
  const steps = guide.steps.filter((step) => step.number >= 1 && step.number <= 12);
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Adding an agent">
      <Heading />
      {view.problem !== null && <p className="text-xs text-status-warn">{view.problem}</p>}
      <p className="text-xs text-muted-foreground">
        From <code>adding-an-agent.md</code> in the harness checkout, with this project's values in place of its
        examples{name === null ? " and <name> for the agent you are adding" : ` and ${name} for the new agent`}.
      </p>
      {guide.checklist !== null && (
        <Collapsible className="group rounded-lg border">
          <FoldTrigger>Checklist</FoldTrigger>
          <CollapsibleContent className="overflow-x-auto px-1 pb-2">
            <GuideMarkdownTable table={{ headers: guide.checklist.headers, rows: guide.checklist.rows.map((row) => row.map(shown)) }} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {steps.map((step) => (
        <Collapsible key={step.number} className="group rounded-lg border">
          <FoldTrigger>
            {step.number}. {shown(step.title)}
          </FoldTrigger>
          <CollapsibleContent>
            <pre className="overflow-x-auto px-3 pb-3 text-xs whitespace-pre-wrap text-muted-foreground">{shown(step.body)}</pre>
          </CollapsibleContent>
        </Collapsible>
      ))}
      {guide.troubleshooting !== null && (
        <Collapsible className="group rounded-lg border">
          <FoldTrigger>Troubleshooting</FoldTrigger>
          <CollapsibleContent className="overflow-x-auto px-1 pb-2">
            <GuideMarkdownTable
              table={{ headers: guide.troubleshooting.headers, rows: guide.troubleshooting.rows.map((row) => row.map(shown)) }}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

const Heading = () => (
  <h3 className="flex items-center gap-2 text-sm font-semibold">
    <BookOpen className="size-4 text-muted-foreground" />
    Adding a new agent
  </h3>
);
