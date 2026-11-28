/**
 * The sentinel's and verifier's On/Off switch (#789): the control on their
 * sheets, and the line their cards show while the config has them off.
 *
 * Every word is `rules-save-model.ts`'s, which is tested; this file only
 * draws. A switch is a rules save with only `enabled` changed, sent through
 * the sheet's own command, so it lands exactly where a rules save does.
 */
import { Power } from "lucide-react";

import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { CommandNotice } from "./command";
import type { CommandError } from "./command-model";
import type { AgentSwitch, RulesOwner, SaveNotice } from "./rules-save-model";
import { agentSwitch } from "./rules-save-model";
import { isRemote } from "./api";
import { useSentinelRules, useVerifierRules } from "./use-reads";

export type SwitchState = { kind: "idle" } | { kind: "saving" } | { kind: "done"; notice: SaveNotice } | { kind: "refused"; error: CommandError };

const NOTICE_TONE: Record<SaveNotice["tone"], string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-muted-foreground",
  neutral: "text-muted-foreground",
};

export function AgentSwitchControl({
  owner,
  state,
  progress,
  disabled,
  title,
  onSwitch,
}: {
  owner: RulesOwner;
  state: AgentSwitch;
  progress: SwitchState;
  /** No switch can be sent: no block, a busy save, or a route the page cannot reach. */
  disabled: boolean;
  title?: string;
  onSwitch: (enabled: boolean) => void;
}) {
  const id = `${owner}-enabled`;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor={id} className="inline-flex items-center gap-1.5">
          <Power className="size-3.5" />
          {owner === "sentinel" ? "Sentinel" : "Verifier"}
        </Label>
        <ToggleGroup
          id={id}
          type="single"
          size="sm"
          className="inline-flex border p-0.5"
          aria-label={`${owner} on or off`}
          value={state.on ? "on" : "off"}
          disabled={disabled || progress.kind === "saving"}
          title={title}
          // Radix reports "" when the active item is clicked again: nothing changes then.
          onValueChange={(value) => {
            if (value === "on" && !state.on) onSwitch(true);
            else if (value === "off" && state.on) onSwitch(false);
          }}
        >
          <ToggleGroupItem
            value="on"
            className="h-auto py-1 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-status-good/15 data-[state=on]:text-status-good"
          >
            On
          </ToggleGroupItem>
          <ToggleGroupItem
            value="off"
            className="h-auto py-1 text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-status-warn/15 data-[state=on]:text-status-warn"
          >
            Off
          </ToggleGroupItem>
        </ToggleGroup>
        {progress.kind === "saving" && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>
      <p className="text-xs text-muted-foreground">{state.hint}</p>
      {progress.kind === "done" && (
        <p className={cn("text-xs", NOTICE_TONE[progress.notice.tone])}>
          {progress.notice.text}{" "}
          {progress.notice.url && (
            <a className="underline" href={progress.notice.url} target="_blank" rel="noreferrer">
              Open the PR
            </a>
          )}
        </p>
      )}
      {progress.kind === "refused" && (
        <div className={cn("text-xs", NOTICE_TONE.bad)}>
          Not switched: <CommandNotice error={progress.error} />
        </div>
      )}
    </section>
  );
}

function OffLine({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p className="inline-flex items-center gap-1.5 text-sm text-status-warn">
      <Power className="size-3.5" />
      {text}
    </p>
  );
}

/**
 * Each reads the base branch's rules, which is what the gate re-reads; one hook apiece, so neither is conditional.
 * The rules-only read skips the open-PR lookup: the line never shows it, and it is a `gh` call on every cold load (#65).
 */
function SentinelOff() {
  const read = useSentinelRules().read;
  const view = read.state === "loading" ? null : read.data;
  return <OffLine text={view === null ? null : agentSwitch(view.rules, "sentinel", view.configChanges, view.baseBranch).card} />;
}

function VerifierOff() {
  const read = useVerifierRules().read;
  const view = read.state === "loading" ? null : read.data;
  return <OffLine text={view === null ? null : agentSwitch(view.rules, "verifier", view.configChanges, view.baseBranch).card} />;
}

/**
 * The card's `Off: disabled in config` line, for a sentinel or verifier loop.
 * Local only: the rules read is a local route, as the sheets are.
 */
export function ConfigOffNote({ role }: { role: string }) {
  if (isRemote()) return null;
  if (role === "sentinel") return <SentinelOff />;
  if (role === "verifier") return <VerifierOff />;
  return null;
}
