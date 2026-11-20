/**
 * The sentinel's rules: how far back it looks, how loud a production error
 * must be before it counts, how many tickets it may file a day, and whether it
 * files them at all.
 *
 * A form over `GET /api/agents/sentinel` and `POST /api/agents/sentinel`, the
 * latter sent through the command module. A save never writes a working
 * tree: the config is edited by `project-config.ts --set-sentinel` and
 * committed onto the base branch, where the sentinel reads it on its next
 * poll — or, when the project asks for PRs (`configChanges: "pr"`) or that
 * push is refused, opened as a PR that applies once merged (#787). The form's
 * checks are `sentinel-form-model.ts`'s copy of the harness's, so Save is only
 * offered for rules the save would accept.
 */
import { useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Info, RotateCcw, TriangleAlert } from "lucide-react";

import { SENTINEL_MODES, type ProposeSentinelResult, type SentinelMode } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formFromView, formProblems, rulesFromForm, saveNotice, switchRules, type SaveNotice, type SentinelForm } from "./sentinel-form-model";
import { agentSwitch, rulesSaveCopy, switchNotice } from "./rules-save-model";
import { AgentSwitchControl, type SwitchState } from "./agent-switch";
import { CommandNotice, LocalOnlyNote, useCommand } from "./command";
import type { CommandError } from "./command-model";
import { useSentinel } from "./use-reads";

const MODE_HINTS: Record<SentinelMode, string> = {
  observe: "Drafts a ticket for each issue over the bar and files nothing.",
  file: "Files ready-for-human tickets, up to the daily cap.",
};

const NOTICE_TONE: Record<SaveNotice["tone"], string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "done"; notice: SaveNotice } | { kind: "refused"; error: CommandError };

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" className="max-w-40 font-mono" value={value} onChange={(event) => onChange(event.target.value)} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function SentinelSettings() {
  // The read goes through the store; the proposal goes through the command module, as the verifier's form does.
  const sentinel = useSentinel();
  const read = sentinel.read.state === "loading" ? null : sentinel.read.data;
  // Only a read that never landed replaces the form: a failed re-read after a save keeps it.
  const loadError = sentinel.read.state === "error" && sentinel.read.data === null ? sentinel.read.message : null;
  const [draft, setDraft] = useState<SentinelForm | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [switching, setSwitching] = useState<SwitchState>({ kind: "idle" });
  const proposing = useCommand("/api/agents/sentinel");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    if (read) setDraft(formFromView(read.rules));
  }, [read]);

  if (loadError) {
    return (
      <Alert variant="destructive" className="bg-transparent">
        <CircleAlert />
        <AlertTitle>The sentinel's rules could not be read</AlertTitle>
        <AlertDescription>
          <p className="whitespace-pre-wrap">{loadError}</p>
        </AlertDescription>
      </Alert>
    );
  }

  if (!read || !draft) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const problems = formProblems(draft);
  const copy = rulesSaveCopy(read.configChanges, read.baseBranch, "sentinel");
  const power = agentSwitch(read.rules, "sentinel", read.configChanges, read.baseBranch);
  const edit = (next: SentinelForm) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };

  const commit = async () => {
    const rules = rulesFromForm(draft);
    if (rules === null) return;
    setSave({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeSentinelResult>>({ rules });
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not saved: the save answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: saveNotice(body as ProposeSentinelResult) });
    // Re-read, so committed rules show as the base branch's, and a PR just
    // opened shows as pending so the next save is not offered as if none were.
    if (body.outcome !== "refused") sentinel.reload();
  };

  // The switch saves at once (#789), through the same route as the rules: the
  // base branch's rules with only `enabled` changed, never the form's draft.
  const flip = async (enabled: boolean) => {
    const rules = switchRules(read.rules, enabled);
    if (rules === null) {
      setSwitching({ kind: "done", notice: { tone: "bad", text: "Not switched: the sentinel rules on " + read.baseBranch + " would be refused; fix them first" } });
      return;
    }
    setSwitching({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeSentinelResult>>({ rules });
    if (!result.ok) {
      setSwitching(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSwitching({ kind: "done", notice: { tone: "bad", text: "Not switched: the save answered nothing" } });
      return;
    }
    setSwitching({ kind: "done", notice: switchNotice(body as ProposeSentinelResult, "sentinel", enabled) });
    if (body.outcome !== "refused") sentinel.reload();
  };

  return (
    <div className="space-y-6">
      <AgentSwitchControl
        owner="sentinel"
        state={power}
        progress={switching}
        // Without a block there is nothing to switch: the save would be refused for the missing block.
        disabled={!read.configured || save.kind === "saving" || proposing.disabled}
        title={proposing.why ?? undefined}
        onSwitch={flip}
      />

      {!read.configured && (
        <Alert className="bg-transparent">
          <TriangleAlert />
          <AlertTitle>No sentinel block yet</AlertTitle>
          <AlertDescription>
            <p>
              Add the sentinel's reporter (its Sentry org and project) to <span className="font-mono">.ralph/config.json</span> on{" "}
              <span className="font-mono">{read.baseBranch}</span> by hand first: this form cannot set where the sentinel looks.
              Until then it shows the defaults and cannot propose them.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {read.pending && (
        <Alert className="bg-transparent">
          <Info />
          <AlertTitle>A rules PR is already open</AlertTitle>
          <AlertDescription>
            <a className="inline-flex items-center gap-1 underline" href={read.pending.url} target="_blank" rel="noreferrer">
              {read.pending.url}
              <ExternalLink className="size-3" />
            </a>
            <p>The form shows the rules on {read.baseBranch}, not the PR's.</p>
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-medium">What counts as an incident</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            id="sentinel-lookback"
            label="Lookback hours"
            hint="How far back it reads the reporter's issues."
            value={draft.lookbackHours}
            onChange={(lookbackHours) => edit({ ...draft, lookbackHours })}
          />
          <NumberField
            id="sentinel-min-events"
            label="Min events"
            hint="Events in the lookback that put an issue over the bar."
            value={draft.minEvents}
            onChange={(minEvents) => edit({ ...draft, minEvents })}
          />
          <NumberField
            id="sentinel-min-users"
            label="Min users"
            hint="Users it must have reached as well."
            value={draft.minUsers}
            onChange={(minUsers) => edit({ ...draft, minUsers })}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">What it may do</h3>
        <NumberField
          id="sentinel-max-per-day"
          label="Max per day"
          hint="Tickets it files in a day (UTC) before it stops and alerts."
          value={draft.maxPerDay}
          onChange={(maxPerDay) => edit({ ...draft, maxPerDay })}
        />
        <div className="space-y-1.5">
          <Label htmlFor="sentinel-mode">Mode</Label>
          <Select value={draft.mode} onValueChange={(mode) => edit({ ...draft, mode })}>
            <SelectTrigger id="sentinel-mode" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SENTINEL_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {mode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{MODE_HINTS[draft.mode as SentinelMode] ?? ""}</p>
        </div>
      </section>

      {problems.length > 0 && (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>These rules would be refused</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <p>{copy.hint}</p>
      </div>

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-3">
        {/* Without a block the proposal is refused for its missing reporter, which the form cannot set. */}
        <Button
          size="sm"
          disabled={!read.configured || problems.length > 0 || save.kind === "saving" || switching.kind === "saving" || proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? copy.busy : copy.button}
        </Button>
        <LocalOnlyNote route="/api/agents/sentinel" />
        <Button
          size="sm"
          variant="ghost"
          disabled={save.kind === "saving"}
          onClick={() => {
            setDraft(formFromView(read.rules));
            setSave({ kind: "idle" });
          }}
        >
          <RotateCcw />
          Reset
        </Button>
        {save.kind === "done" && (
          <span className={cn("ml-auto text-xs", NOTICE_TONE[save.notice.tone])}>
            {save.notice.text}{" "}
            {save.notice.url && (
              <a className="underline" href={save.notice.url} target="_blank" rel="noreferrer">
                Open the PR
              </a>
            )}
          </span>
        )}
        {save.kind === "refused" && (
          // A div, not a span: the refusal's problems are a list.
          <div className={cn("ml-auto text-xs", NOTICE_TONE.bad)}>
            Not saved: <CommandNotice error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}
