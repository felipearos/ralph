/**
 * The Agents page's model-update panel (#851): which agents run an older
 * Claude model than their family's latest, and the operator's answer for each.
 *
 * The answers are `model-updates.ts`'s, through the lineup handler; this view
 * decides nothing. A change applies at the loop's next start — this never
 * restarts a loop — and an unanswered card changes nothing at all.
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelUpdateAnswer, ModelUpdateResult } from "../../lineup/contracts";
import { CommandNotice, useCommand } from "./command";
import type { CommandError } from "./command-model";
import { answerBody, answerMessage, updatePanel, type UpdateCard } from "./model-updates-model";
import { useModelUpdates } from "./use-reads";

const ROUTE = "/api/lineup/updates/answer";

type Outcome = { kind: "done"; text: string } | { kind: "failed"; error: CommandError };

export function ModelUpdatesPanel() {
  const updates = useModelUpdates();
  const answer = useCommand(ROUTE);
  // One outcome per block, so an answer's line stays under its own card.
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const data = updates.read.state === "loading" ? null : updates.read.data;
  const panel = useMemo(() => (data === null ? null : updatePanel(data, Date.now())), [data]);

  // Nothing outdated, a read that failed, or the remote page: no panel at all.
  // The lineup editor in each loop's Settings is still where a model is chosen.
  if (panel === null || (panel.asking.length === 0 && panel.quiet.length === 0)) return null;

  const send = async (card: UpdateCard, choice: ModelUpdateAnswer) => {
    setBusy(card.key);
    const result = await answer.send<ModelUpdateResult>(answerBody(card.agent, choice));
    setBusy(null);
    setOutcomes((current) => ({
      ...current,
      [card.key]: result.ok
        ? { kind: "done", text: result.value === null ? "Recorded." : answerMessage(result.value) }
        : { kind: "failed", error: result.error },
    }));
    if (result.ok) updates.reload();
  };

  const asking = panel.asking.length;
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle>
          {asking > 0
            ? `${asking} ${asking === 1 ? "agent runs" : "agents run"} an older model`
            : "Agents on an older model"}
        </CardTitle>
        <CardDescription>
          Latest per family, as this host's Claude Code resolves it:{" "}
          <span className="font-mono">
            {Object.entries(data!.latest)
              .map(([family, id]) => `${family} → ${id}`)
              .join(" · ")}
          </span>
          . A change applies when the loop next starts; nothing here restarts one.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {panel.asking.map((card) => (
          <AskingCard
            key={card.key}
            card={card}
            busy={busy === card.key}
            disabled={answer.disabled || busy !== null}
            why={answer.why}
            outcome={outcomes[card.key]}
            onAnswer={(choice) => void send(card, choice)}
          />
        ))}
        {panel.quiet.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {panel.quiet.map((card) => (
              <div key={card.key} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{card.name}</span>
                <span className="font-mono text-xs">
                  {card.agent.outdated.map((stage) => `${stage.stage}: ${stage.model}`).join(", ")}
                </span>
                <span>· {card.quiet}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={answer.disabled || busy !== null}
                  title={answer.why ?? undefined}
                  onClick={() => void send(card, "ask")}
                >
                  Ask again
                </Button>
                <OutcomeLine outcome={outcomes[card.key]} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AskingCard({
  card,
  busy,
  disabled,
  why,
  outcome,
  onAnswer,
}: {
  card: UpdateCard;
  busy: boolean;
  disabled: boolean;
  why: string | null;
  outcome: Outcome | undefined;
  onAnswer: (choice: ModelUpdateAnswer) => void;
}) {
  const target = card.targets.join(", ");
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {card.name} <span className="font-normal text-muted-foreground">· {card.kind}</span>
        </span>
        <Badge variant="outline" className="border-amber-500/60 text-amber-600 dark:text-amber-400">
          {card.agent.outdated.length} {card.agent.outdated.length === 1 ? "stage" : "stages"} outdated
        </Badge>
      </div>
      <table className="mt-2 w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 text-left font-normal">Stage</th>
            <th className="py-1 pr-2 text-left font-normal">Now</th>
            <th className="py-1 text-left font-normal">Latest</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {card.agent.outdated.map((stage) => (
            <tr key={stage.stage} className="border-t">
              <td className="py-1 pr-2 font-sans">{stage.stage}</td>
              <td className="py-1 pr-2">{stage.model}</td>
              <td className="py-1 text-emerald-600 dark:text-emerald-400">{stage.latest}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={disabled} title={why ?? undefined} onClick={() => onAnswer("update")}>
          {busy ? "Saving…" : `Update to ${target}`}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} title={why ?? undefined} onClick={() => onAnswer("snooze")}>
          Not now
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={disabled} title={why ?? undefined}>
              Don't ask again
              <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72">
            <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => onAnswer("skip")}>
              <span>Skip {target}</span>
              <span className="text-xs text-muted-foreground">Ask again when a newer model ships</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => onAnswer("pin")}>
              <span>Never for {card.name}</span>
              <span className="text-xs text-muted-foreground">Pin its models; no more questions</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="flex-col items-start gap-0.5" onSelect={() => onAnswer("auto")}>
              <span>Always update {card.name} automatically</span>
              <span className="text-xs text-muted-foreground">Moves now, and at every loop start after a release</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <OutcomeLine outcome={outcome} />
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome | undefined }) {
  if (outcome === undefined) return null;
  if (outcome.kind === "done") return <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{outcome.text}</p>;
  return (
    <div className="mt-2 text-xs text-destructive">
      <CommandNotice error={outcome.error} />
    </div>
  );
}
