/**
 * The verifier's rules: how long it watches a merge, when it checks in, what
 * counts as a regression and what it may do about one.
 *
 * A form over `GET /api/agents/verifier` and `POST /api/agents/verifier`, the
 * latter sent through the command module. A save never writes a working
 * tree: the config is edited by `project-config.ts --set-verifier` and
 * committed onto the base branch, where the verifier reads it on its next
 * poll — or, when the project asks for PRs (`configChanges: "pr"`) or that
 * push is refused, opened as a PR that applies once merged (#787). The form's
 * checks are `verifier-model.ts`'s copy of the harness's, so Save is only
 * offered for rules the save would accept.
 */
import { useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Info, RotateCcw, TriangleAlert } from "lucide-react";

import { VERIFIER_MODES, type ProposeVerifierResult, type VerifierMode } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formFromView, formProblems, rulesFromForm, saveNotice, switchRules, type SaveNotice, type VerifierForm } from "./verifier-model";
import { agentSwitch, rulesSaveCopy, switchNotice } from "./rules-save-model";
import { AgentSwitchControl, type SwitchState } from "./agent-switch";
import { CommandNotice, LocalOnlyNote, useCommand } from "./command";
import type { CommandError } from "./command-model";
import { useVerifier, useRulesOnlyRefresh } from "./use-reads";

const MODE_HINTS: Record<VerifierMode, string> = {
  observe: "Records each verdict and acts on none of them.",
  report: "Files tickets; a revert verdict becomes a high-priority ticket.",
  act: "Acts on verdicts, including reverting a merge that broke production.",
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

export function VerifierSettings() {
  // The read goes through the store (#614); the proposal goes through the command module (#621).
  const verifier = useVerifier();
  // The agent card's Off line reads the rules alone (#65); a save re-reads it too.
  const refreshCard = useRulesOnlyRefresh("verifier");
  const read = verifier.read.state === "loading" ? null : verifier.read.data;
  // Only a read that never landed replaces the form: a failed re-read after a save keeps it.
  const loadError = verifier.read.state === "error" && verifier.read.data === null ? verifier.read.message : null;
  const [draft, setDraft] = useState<VerifierForm | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [switching, setSwitching] = useState<SwitchState>({ kind: "idle" });
  const proposing = useCommand("/api/agents/verifier");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    if (read) setDraft(formFromView(read.rules));
  }, [read]);

  if (loadError) {
    return (
      <Alert variant="destructive" className="bg-transparent">
        <CircleAlert />
        <AlertTitle>The verifier's rules could not be read</AlertTitle>
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
  const copy = rulesSaveCopy(read.configChanges, read.baseBranch, "verifier");
  const power = agentSwitch(read.rules, "verifier", read.configChanges, read.baseBranch);
  const edit = (next: VerifierForm) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };
  const editRevert = (patch: Partial<VerifierForm["revert"]>) => edit({ ...draft, revert: { ...draft.revert, ...patch } });
  const editFollow = (patch: Partial<VerifierForm["follow"]>) => edit({ ...draft, follow: { ...draft.follow, ...patch } });

  const commit = async () => {
    const rules = rulesFromForm(draft);
    if (rules === null) return;
    setSave({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeVerifierResult>>({ rules });
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not saved: the save answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: saveNotice(body as ProposeVerifierResult) });
    // Re-read, so committed rules show as the base branch's, and a PR just
    // opened shows as pending so the next save is not offered as if none were.
    if (body.outcome !== "refused") {
      verifier.reload();
      refreshCard();
    }
  };

  // The switch saves at once (#789), through the same route as the rules: the
  // base branch's rules with only `enabled` changed, never the form's draft.
  const flip = async (enabled: boolean) => {
    const rules = switchRules(read.rules, enabled);
    if (rules === null) {
      setSwitching({ kind: "done", notice: { tone: "bad", text: "Not switched: the verifier rules on " + read.baseBranch + " would be refused; fix them first" } });
      return;
    }
    setSwitching({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeVerifierResult>>({ rules });
    if (!result.ok) {
      setSwitching(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSwitching({ kind: "done", notice: { tone: "bad", text: "Not switched: the save answered nothing" } });
      return;
    }
    setSwitching({ kind: "done", notice: switchNotice(body as ProposeVerifierResult, "verifier", enabled) });
    if (body.outcome !== "refused") {
      verifier.reload();
      refreshCard();
    }
  };

  return (
    <div className="space-y-6">
      <AgentSwitchControl
        owner="verifier"
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
          <AlertTitle>No verifier block yet</AlertTitle>
          <AlertDescription>
            <p>
              Set the verifier's production URL, deploy source and Sentry project in{" "}
              <span className="font-mono">.ralph/config.json</span> on <span className="font-mono">{read.baseBranch}</span>{" "}
              first. Until then this form shows the defaults.
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
        <h3 className="text-sm font-medium">What it follows</h3>
        <label className="flex cursor-pointer items-center gap-3">
          <Checkbox checked={draft.follow.loopPrs} onCheckedChange={(checked) => editFollow({ loopPrs: checked === true })} />
          <span className="text-sm">Follow loop PRs</span>
        </label>
        <label className="flex cursor-pointer items-center gap-3">
          <Checkbox checked={draft.follow.humanPrs} onCheckedChange={(checked) => editFollow({ humanPrs: checked === true })} />
          <span className="text-sm">Follow human PRs</span>
        </label>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="verifier-window"
          label="Window hours"
          hint="How long it watches a merge after the deploy."
          value={draft.windowHours}
          onChange={(windowHours) => edit({ ...draft, windowHours })}
        />
        <div className="space-y-1.5">
          <Label htmlFor="verifier-check-ins">Check-ins</Label>
          <Input
            id="verifier-check-ins"
            className="max-w-60 font-mono"
            value={draft.checkIns}
            placeholder="1, 6, 24"
            onChange={(event) => edit({ ...draft, checkIns: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">Hours after the deploy, comma-separated, within the window.</p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">When a merge is a regression</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField
            id="verifier-rate-factor"
            label="Rate factor"
            hint="An issue is new when its rate rises this many times, above 1."
            value={draft.revert.rateFactor}
            onChange={(rateFactor) => editRevert({ rateFactor })}
          />
          <NumberField
            id="verifier-min-events"
            label="Min events"
            hint="Events that put a new issue over the revert bar."
            value={draft.revert.minEvents}
            onChange={(minEvents) => editRevert({ minEvents })}
          />
          <NumberField
            id="verifier-min-users"
            label="Min users"
            hint="Or users, whichever is reached first."
            value={draft.revert.minUsers}
            onChange={(minUsers) => editRevert({ minUsers })}
          />
        </div>
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox className="mt-0.5" checked={draft.trafficFloor} onCheckedChange={(checked) => edit({ ...draft, trafficFloor: checked === true })} />
          <span className="space-y-1">
            <span className="block text-sm">Traffic floor</span>
            <span className="block text-xs text-muted-foreground">
              A merge nobody exercised ends unexercised, not verified.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-1.5">
        <Label htmlFor="verifier-mode">Mode</Label>
        <Select value={draft.mode} onValueChange={(mode) => edit({ ...draft, mode })}>
          <SelectTrigger id="verifier-mode" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VERIFIER_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {mode}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{MODE_HINTS[draft.mode as VerifierMode] ?? ""}</p>
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
        {/* Without a block the proposal is refused for its missing production settings, which the form cannot set. */}
        <Button
          size="sm"
          disabled={!read.configured || problems.length > 0 || save.kind === "saving" || switching.kind === "saving" || proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? copy.busy : copy.button}
        </Button>
        <LocalOnlyNote route="/api/agents/verifier" />
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
