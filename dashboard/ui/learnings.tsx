/**
 * The learnings panel (#201): what the loops already know, for this project
 * and for Ralph itself — which entries keep biting, and whether anybody is
 * fixing them.
 *
 * Kept quiet on purpose: one line per entry (title, sightings, ticket), the
 * only colour a count that keeps recurring. An entry opens in place to its
 * Workaround, the line an operator came for; the rest of its fields sit behind
 * "details". The one write is File ticket, which asks the harness to file the
 * entry now (`POST /api/learnings/file`); the files themselves are only ever
 * edited by the journal publisher. Every decision is in `learnings-model.ts`;
 * this file only draws.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";

import type { Dashboard, LearningFiledView } from "../contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useCommand } from "./command";
import { noticeText } from "./command-model";
import { Quiet } from "./label";
import {
  filingOutcome,
  fixLabel,
  learningsPanel,
  learningsSummary,
  listedFixed,
  listedItems,
  nothingLearned,
  inlinePieces,
  type FilingOutcome,
  type LearningItem,
  type LearningsFilter,
  type LearningsPanelView,
} from "./learnings-model";

const FILE_ROUTE = "/api/learnings/file";

/** An entry's text with its `code` and **bold** drawn, never as injected HTML. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlinePieces(text).map((piece, index) =>
        piece.kind === "code" ? (
          <code key={index} className="rounded-sm bg-muted/60 px-1 font-mono text-[0.85em]">
            {piece.text}
          </code>
        ) : piece.kind === "bold" ? (
          <strong key={index} className="font-semibold">
            {piece.text}
          </strong>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}

const LINK = "text-status-info underline-offset-2 hover:underline";

/** The row's last column: the ticket, "queued", "operator", or nothing. */
function FixCell({ item, filed }: { item: LearningItem; filed: FilingOutcome | null }) {
  if (filed?.kind === "filed") {
    return (
      <a href={filed.href} target="_blank" rel="noreferrer" className={LINK}>
        {filed.label}
      </a>
    );
  }
  if (filed?.kind === "queued") return <>queued</>;
  if (item.fix.kind === "ticket" && item.fix.href !== null) {
    return (
      <a href={item.fix.href} target="_blank" rel="noreferrer" className={LINK}>
        {item.fix.label}
      </a>
    );
  }
  return <>{fixLabel(item.fix)}</>;
}

/**
 * File ticket: shown only where the harness can act on it (not the remote
 * page) and only on an entry with no ticket yet. After it answers, the entry
 * keeps the outcome until the next snapshot carries the new Fix line.
 */
function FileTicket({ item, filed, onFiled }: { item: LearningItem; filed: FilingOutcome | null; onFiled: (outcome: FilingOutcome) => void }) {
  const command = useCommand(FILE_ROUTE);
  if (command.disabled || !item.fileable || item.slug === null || filed?.kind === "filed" || filed?.kind === "queued") return null;
  const file = async () => {
    const result = await command.send<LearningFiledView>({ slug: item.slug, scope: item.scope });
    if (!result.ok) {
      if (result.error.kind !== "Aborted") onFiled({ kind: "problem", text: noticeText(result.error) });
      return;
    }
    if (result.value !== null) onFiled(filingOutcome(result.value));
  };
  return (
    <button type="button" className={cn(LINK, "disabled:opacity-60")} disabled={command.pending} onClick={() => void file()}>
      {command.pending ? "Filing…" : "File ticket"}
    </button>
  );
}

function Entry({ item }: { item: LearningItem }) {
  const [details, setDetails] = useState(false);
  const [filed, setFiled] = useState<FilingOutcome | null>(null);
  const more = [
    ["Seen", item.seen],
    ["Fix", item.fixText],
    ["Change", item.change],
    ["Verify", item.verify],
  ].filter((field): field is [string, string] => field[1] !== null);
  return (
    <Collapsible className="group border-t">
      <CollapsibleTrigger className="flex w-full items-baseline gap-3 py-2 text-left">
        <ChevronRight className="size-3.5 shrink-0 self-center text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1 truncate text-sm group-data-[state=open]:font-medium group-data-[state=open]:whitespace-normal">
          <Inline text={item.title} />
        </span>
        <span
          className={cn("w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground", item.hot && "font-semibold text-status-bad")}
          title={item.lastSeen === null ? undefined : `last seen ${item.lastSeen}`}
        >
          {item.seenCount > 1 ? `×${item.seenCount}` : ""}
        </span>
        {/* A ticket link here would nest an <a> in the trigger's button; the open entry carries the link instead. */}
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
          {filed?.kind === "filed" ? filed.label : filed?.kind === "queued" ? "queued" : fixLabel(item.fix)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-3 pl-6.5 text-sm">
        {item.workaround !== null && (
          <p className="mb-1.5">
            <Inline text={item.workaround} />
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {item.date !== null && <span>{item.date}</span>}
          {(item.fix.kind === "ticket" || filed?.kind === "filed") && (
            <span>
              Ticket <FixCell item={item} filed={filed} />
            </span>
          )}
          {more.length > 0 && (
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setDetails((open) => !open)}>
              {details ? "hide details" : "details"}
            </button>
          )}
          {item.href !== null && (
            <a href={item.href} target="_blank" rel="noreferrer" className={LINK}>
              Open in GitHub ↗
            </a>
          )}
          <FileTicket item={item} filed={filed} onFiled={setFiled} />
        </div>
        {filed?.kind === "problem" && <p className="mt-1.5 text-xs text-status-bad">Not filed: {filed.text}</p>}
        {filed?.kind === "queued" && (
          <p className="mt-1.5 text-xs text-muted-foreground">Published as queued: GitHub did not take the issue, so the next loop startup files it.</p>
        )}
        {details && (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {more.map(([label, text]) => (
              <p key={label}>
                <span className="font-medium text-foreground">{label}:</span> <Inline text={text} />
              </p>
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

const TABS: { value: LearningsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "project", label: "Project" },
  { value: "harness", label: "Harness" },
];

function Body({ panel, filter }: { panel: LearningsPanelView; filter: LearningsFilter }) {
  const items = listedItems(panel, filter);
  const fixed = listedFixed(panel, filter);
  return (
    <>
      {items.length > 0 && (
        <div>
          {items.map((item) => (
            <Entry key={item.key} item={item} />
          ))}
        </div>
      )}
      {fixed.length > 0 && (
        <Collapsible className="group border-t pt-2">
          <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            {fixed.length} fixed
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 divide-y text-sm">
              {fixed.map((row, index) => (
                <li key={`${row.scope}:${index}`} className="flex gap-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <Inline text={row.problem} />
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.fixedBy}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}

export function LearningsPanel({ data }: { data: Dashboard }) {
  const [filter, setFilter] = useState<LearningsFilter>("all");
  const panel = learningsPanel(data);
  if (panel === null) return null;
  const empty = nothingLearned(panel);
  const summary = learningsSummary(panel, filter);
  const counts = (value: LearningsFilter) => learningsSummary(panel, value).open;
  const tabs = TABS.filter((tab) => tab.value === "all" || panel.rows.some((row) => row.scope === tab.value));
  return (
    <Card className="gap-3 py-5 shadow-none">
      <CardHeader className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5">
        <CardTitle className="text-sm">Learnings</CardTitle>
        {!empty && (
          <span className="text-xs text-muted-foreground">
            {summary.open} open · {summary.fixed} fixed
          </span>
        )}
        {!empty && tabs.length > 2 && (
          <div className="ml-auto flex gap-3 text-xs" role="tablist" aria-label="Which file">
            {tabs.map((tab) => (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={filter === tab.value}
                className={cn(
                  "text-muted-foreground hover:text-foreground",
                  filter === tab.value && "text-foreground underline underline-offset-4",
                )}
                onClick={() => setFilter(tab.value)}
              >
                {tab.label} {counts(tab.value)}
              </button>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="px-5">
        {empty ? (
          <Quiet>Nothing has been learned yet. Loops write here when a block has a systemic cause.</Quiet>
        ) : (
          <Body panel={panel} filter={filter} />
        )}
      </CardContent>
    </Card>
  );
}
