/**
 * The Evals tab's Suggestions screen (#858): merged PRs the live signals say
 * the loops struggled with, ranked by the server as candidates for the test
 * set. The operator judges each by its reasons and adds it through the Test
 * set's own add form, prefilled, so a case is added one way from either screen.
 *
 * The suggestions are a relayed snapshot and the add is the relayed set-add
 * command, so the remote page does all of it. The order is the server's: the
 * page never re-sorts. Every decision is in `evals-model.ts`.
 */
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { EvalSuggestionView } from "../contracts";
import { missingLine, suggestionAddForm, suggestionLabel } from "./evals-model";
import { AddCaseCard } from "./evals-set";
import { Quiet } from "./label";
import { useEvalSuggestions } from "./use-reads";

function SuggestionRow({ suggestion, onChanged, onAdded }: { suggestion: EvalSuggestionView; onChanged: () => void; onAdded: (line: string) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardContent className="space-y-2 px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium">{suggestion.title}</div>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <a href={suggestion.url} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-2 hover:underline">
                {suggestionLabel(suggestion)}
              </a>
              <span>merged {suggestion.mergedAt.slice(0, 10)}</span>
              {suggestion.tickets.length > 0 && <span>tickets {suggestion.tickets.map((ticket) => `#${ticket}`).join(", ")}</span>}
              {/* The score only orders the list; the reasons are what the operator judges. */}
              <span title="Ranking score">score {suggestion.score}</span>
            </div>
          </div>
          <Button size="sm" variant={adding ? "ghost" : "outline"} onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add"}</Button>
        </div>
        <ul className="space-y-1 text-xs">
          {suggestion.reasons.map((reason, index) => (
            <li key={`${reason.signal}-${index}`} className="flex items-start gap-2">
              <Badge variant="outline" className="text-[10px]">{reason.signal}</Badge>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
        {adding && (
          // A successful add holds the PR in the set, so the refresh drops this
          // row and the form's own notice with it: the screen says it instead.
          <AddCaseCard
            view={null}
            onChanged={onChanged}
            onAdded={(id) => onAdded(`Added ${suggestionLabel(suggestion)} as case ${id}. It shows in the Test set.`)}
            initial={suggestionAddForm(suggestion)}
            title="Add this PR as a case"
            done="Added. It shows in the Test set and leaves these suggestions."
          />
        )}
      </CardContent>
    </Card>
  );
}

export function EvalSuggestionsScreen() {
  const { read, refresh } = useEvalSuggestions();
  const [added, setAdded] = useState<string | null>(null);
  if (read.state === "loading") return <Skeleton className="h-64" />;
  const view = read.data;
  const missing = view === null ? null : missingLine(view.missing);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Merged PRs the loops struggled with, most telling first. Add the ones worth replaying to the test set.
      </p>
      {view?.problem && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>The suggestions could not be read</AlertTitle>
          <AlertDescription><p className="font-mono text-xs break-all">{view.problem}</p></AlertDescription>
        </Alert>
      )}
      {read.state === "error" && view === null && <Quiet>{read.message}</Quiet>}
      {added !== null && <p className="text-xs text-status-good">{added}</p>}
      {missing !== null && <p className="text-xs text-status-warn">{missing}</p>}
      {view?.pending === true && <Quiet>Reading the merged PRs and the tracker; the suggestions appear on the next refresh.</Quiet>}
      {view !== null && view.problem === null && view.pending !== true && view.suggestions.length === 0 && (
        <Quiet>No merged PR shows the loops struggling, or every one that does is already in the set.</Quiet>
      )}
      {(view?.suggestions ?? []).map((suggestion) => (
        <SuggestionRow key={`${suggestion.repo}#${suggestion.pr}`} suggestion={suggestion} onChanged={refresh} onAdded={setAdded} />
      ))}
    </div>
  );
}
