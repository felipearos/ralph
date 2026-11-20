/**
 * Sleep project / Wake project, in the project's top bar and in a project
 * tile's right-click menu in the rail, and the strip under the top bar that
 * says the project is asleep. Both read the same store entry
 * (`useProjectSleep`), so the toggle's refresh redraws the strip too.
 *
 * Sleeping asks first, because its effect outlasts the click: every agent
 * finishes its iteration, then waits until someone wakes the project. Waking
 * needs no confirmation; it only lets them go on. Local only, like the route:
 * the remote page reads nothing here and so draws nothing.
 */
import { useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProjectSleepView } from "../contracts";
import { send, useCommand, useCommandAvailability } from "./command";
import { settleToggle, SLEEP_EXPLANATION, sleepBody, sleepState, WAKE_BODY, whyHint } from "./project-sleep-model";
import { useProjectSleep } from "./use-reads";

/**
 * The confirmation a sleep asks for, with its optional reason. Shared by the
 * top bar and a rail tile's menu; it posts to `project` by name, so a tile can
 * put to sleep a project the page is not showing.
 */
export function ProjectSleepDialog({
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { refresh } = useProjectSleep(project);
  const command = useCommand("/api/sleep");
  const [why, setWhy] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const hint = whyHint(why);

  const close = (): void => {
    setFailure(null);
    setWhy("");
    onOpenChange(false);
  };
  const submit = async (): Promise<void> => {
    setFailure(null);
    const result = await command.send<ProjectSleepView>(sleepBody(why), { project });
    // Read again whatever the answer: a failed write may still have landed.
    refresh();
    const settled = settleToggle(true, result);
    if (settled.ok) close();
    else setFailure(settled.message);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !command.pending && (next ? onOpenChange(true) : close())}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Put {project} to sleep?</DialogTitle>
          <DialogDescription>{SLEEP_EXPLANATION}</DialogDescription>
        </DialogHeader>
        <form
          id={`project-sleep-${project}`}
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (hint === null) void submit();
          }}
        >
          <Label htmlFor={`project-sleep-why-${project}`}>Reason (optional)</Label>
          <Input
            id={`project-sleep-why-${project}`}
            value={why}
            placeholder="e.g. deploy freeze until Monday"
            onChange={(event) => setWhy(event.target.value)}
          />
          {hint !== null && <span className="text-xs text-status-warn">{hint}</span>}
          {failure !== null && <span className="text-xs text-status-bad">{failure}</span>}
        </form>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={command.pending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={`project-sleep-${project}`} size="sm" disabled={command.pending || command.disabled || hint !== null}>
            <Moon className="size-3.5" />
            {command.pending ? "Sleeping…" : "Sleep project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Wake `project`, settled to a failure message or null. Needs no confirmation: it only lets the agents go on. */
export async function wakeProject(project: string, refresh: () => void): Promise<string | null> {
  const result = await send<ProjectSleepView>("/api/sleep", WAKE_BODY, { project });
  refresh();
  const settled = settleToggle(false, result);
  return settled.ok ? null : settled.message;
}

export function ProjectSleepToggle({ project }: { project: string }) {
  const { read, refresh } = useProjectSleep(project);
  const state = sleepState(read);
  const { disabled, why } = useCommandAvailability("/api/sleep");
  const [confirming, setConfirming] = useState(false);
  const [waking, setWaking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (state.kind === "hidden") return null;
  if (state.kind === "unknown") {
    return (
      <span className="text-xs text-muted-foreground" title={state.problem}>
        Sleep unreadable
      </span>
    );
  }
  if (state.kind === "asleep") {
    return (
      <span className="flex items-center gap-2">
        {failure !== null && (
          <span className="max-w-64 truncate text-xs text-status-bad" title={failure}>
            {failure}
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={waking || disabled}
          title={why ?? "Let every agent go on with its next iteration"}
          onClick={() => {
            setFailure(null);
            setWaking(true);
            void wakeProject(project, refresh).then((message) => {
              setWaking(false);
              setFailure(message);
            });
          }}
        >
          <Sun className="size-3.5" />
          {waking ? "Waking…" : "Wake project"}
        </Button>
      </span>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        title={why ?? "Pause every agent of the project at its next iteration boundary"}
        onClick={() => {
          setFailure(null);
          setConfirming(true);
        }}
      >
        <Moon className="size-3.5" />
        Sleep project
      </Button>
      <ProjectSleepDialog project={project} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}

/**
 * Sleep project… / Wake project in a rail tile's right-click menu. Mounted only
 * while the menu is open, so the rail does not poll every project's sleep; the
 * read starts when the menu opens. The confirmation and a failed wake are the
 * tile's to show, since the menu closes on a pick and takes this with it.
 */
export function ProjectSleepMenuItems({
  project,
  onSleep,
  onWake,
}: {
  project: string;
  onSleep: () => void;
  onWake: (refresh: () => void) => void;
}) {
  const { read, refresh } = useProjectSleep(project);
  const state = sleepState(read);
  const { disabled, why } = useCommandAvailability("/api/sleep");
  // The remote page reads nothing here and offers nothing: the route is local only.
  if (disabled) return null;
  // A dashboard older than the route answers 404: nothing to offer.
  if (state.kind === "hidden" && read.state !== "loading") return null;
  return (
    <>
      <ContextMenuSeparator />
      {state.kind === "asleep" ? (
        <ContextMenuItem title={state.line} onSelect={() => onWake(refresh)}>
          <Sun />
          Wake project
        </ContextMenuItem>
      ) : (
        <ContextMenuItem
          disabled={state.kind !== "awake"}
          title={state.kind === "unknown" ? state.problem : (why ?? undefined)}
          onSelect={onSleep}
        >
          <Moon />
          {state.kind === "unknown" ? "Sleep unreadable" : state.kind === "hidden" ? "Checking sleep…" : "Sleep project…"}
        </ContextMenuItem>
      )}
    </>
  );
}

/** The strip under the top bar while the project sleeps; nothing otherwise. */
export function ProjectSleepBanner({ project }: { project: string }) {
  const state = sleepState(useProjectSleep(project).read);
  if (state.kind !== "asleep") return null;
  return (
    <div
      role="status"
      aria-label="Project asleep"
      data-sleep-banner
      className="sticky top-12 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-status-info/25 bg-status-info/[0.06] px-4 py-1.5 text-xs backdrop-blur"
      title={state.by === null ? state.since : `${state.since}, by ${state.by}`}
    >
      <span className="inline-flex items-center gap-2 text-foreground">
        <Moon className="size-3.5 text-status-info" />
        {state.line}
      </span>
      <span className="text-muted-foreground">Agents wait before their next iteration until you wake the project.</span>
    </div>
  );
}
