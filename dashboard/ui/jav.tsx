/**
 * Jav, difficulty routing: whether loops pick by difficulty label, which
 * labels the triager applies, and which loop takes which label.
 *
 * A form over `GET /api/jav` and `POST /api/jav/save`. Edits are made to a
 * client-side copy through `jav-model.ts`; the save goes through the command
 * module and is judged by `jav.ts`, whose problem list is shown in full when
 * it refuses.
 */
import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";

import type { JavConfigView, JavSaveResult, JavView } from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DEFAULT_ROUTE,
  addLabel,
  idleLoops,
  labelHint,
  needsTriager,
  removeLabel,
  sameConfig,
  setEnabled,
  strandedLabels,
  toggleRoute,
} from "./jav-model";
import { CommandNotice, LocalOnlyNote, useCommand } from "./command";
import type { CommandError } from "./command-model";
import { useJav } from "./use-reads";

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "failed"; problems: string[] }
  | { kind: "refused"; error: CommandError };

/**
 * `intake` is what the routing page cannot work out for itself: how many ready
 * tickets carry no difficulty label, and which loops could label them. Both
 * come from the dashboard feed the caller already polls — `jav.ts` knows the
 * roster but not the backlog, so asking it would need a tracker census per
 * page open.
 */
export function JavSettings({
  intake = { untriaged: null, triagers: [] },
}: {
  intake?: { untriaged: number | null; triagers: readonly string[] };
} = {}) {
  // The read goes through the store (#614); the save goes through the command module (#621).
  const jav = useJav();
  const read = jav.read.state === "loading" ? null : jav.read.data;
  // Only a read that never landed replaces the form: a failed re-read after a save keeps it.
  const loadError = jav.read.state === "error" && jav.read.data === null ? jav.read.message : null;
  const [draft, setDraft] = useState<JavConfigView | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // The snapshot a save just replaced on the server: until the re-read lands,
  // it is not judged against the draft, so the page does not flash "Unsaved
  // changes" or the old routing's problems over a save that went through.
  const [superseded, setSuperseded] = useState<JavView | null>(null);
  const saving = useCommand("/api/jav/save");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    if (read) setDraft(read.config);
  }, [read]);

  if (loadError) {
    return (
      <Alert variant="destructive" className="bg-transparent">
        <CircleAlert />
        <AlertTitle>Jav could not be read</AlertTitle>
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

  // A failed re-read keeps the superseded data as its last, so it must end the wait too, or Save would stay held.
  const pending = read === superseded && jav.read.state !== "error";
  const dirty = !pending && !sameConfig(draft, read.config);
  const edit = (next: JavConfigView) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };
  const hint = labelHint(draft, read.reserved, newLabel);
  const stranded = draft.enabled ? strandedLabels(draft, read.loops) : [];
  const idle = draft.enabled ? idleLoops(draft, read.loops) : [];
  const noTriager = needsTriager(draft, intake);

  const submitLabel = () => {
    if (hint !== null || newLabel.trim() === "") return;
    edit(addLabel(draft, newLabel));
    setNewLabel("");
  };

  const commit = async () => {
    setSave({ kind: "saving" });
    const result = await saving.send<Partial<JavSaveResult>>({ config: draft });
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    // The route refuses an invalid routing with a 400 (above); a 2xx reading `valid: false` is held to the same list.
    const body = result.value ?? {};
    if (!body.valid) {
      setSave({ kind: "failed", problems: body.problems ?? ["the save answered nothing"] });
      return;
    }
    setSuperseded(read);
    setSave({ kind: "saved", at: new Date() });
    jav.reload();
  };

  return (
    <div className="space-y-6">
      {read.problems.length > 0 && !dirty && !pending && (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>This project's routing has problems, so every loop's pick is failing</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {read.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-md border p-4">
        <Checkbox
          className="mt-0.5"
          checked={draft.enabled}
          onCheckedChange={(checked) => edit(setEnabled(draft, checked === true))}
        />
        <span className="space-y-1">
          <span className="block text-sm font-medium">Route tickets by difficulty</span>
          <span className="block text-sm text-muted-foreground">
            {draft.enabled
              ? "Each loop picks only tickets carrying a label it takes. Tickets with none of these labels wait for triage."
              : "Off: every loop picks from the whole frontier. Labels and routes below are kept for when you turn it on."}
          </span>
        </span>
      </label>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Difficulty labels</h3>
        <p className="text-sm text-muted-foreground">The GitHub labels your triager applies to ready-for-agent tickets.</p>
        <div className="flex flex-wrap gap-2">
          {draft.labels.length === 0 && <span className="text-sm text-muted-foreground">No labels yet.</span>}
          {draft.labels.map((label) => (
            <Badge key={label} variant="outline" className="gap-1 font-mono font-normal">
              {label}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${label}`}
                className="size-auto rounded-sm border-0 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                onClick={() => edit(removeLabel(draft, label))}
              >
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitLabel();
          }}
        >
          <Input
            value={newLabel}
            placeholder="difficulty:medium"
            className="max-w-xs font-mono"
            aria-invalid={hint !== null}
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" disabled={hint !== null || newLabel.trim() === ""}>
            <Plus />
            Add
          </Button>
        </form>
        {hint && <p className="text-xs text-status-bad">{hint}</p>}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Who takes what</h3>
        <p className="text-sm text-muted-foreground">
          Tick the labels each loop takes. A loop can take several; several loops can share one. A loop
          with no ticks of its own takes what <span className="font-mono">any other coder</span> takes.
          Only coders are listed: a triager or a CI doctor takes no frontier work, so it holds no route.
        </p>
        {draft.labels.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add a label first.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Loop</TableHead>
                {draft.labels.map((label) => (
                  <TableHead key={label} className="text-center font-mono font-normal">
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...read.loops, DEFAULT_ROUTE].map((loop) => (
                <TableRow key={loop}>
                  <TableCell className={loop === DEFAULT_ROUTE ? "text-muted-foreground" : "font-mono"}>
                    {loop === DEFAULT_ROUTE ? "any other coder" : loop}
                  </TableCell>
                  {draft.labels.map((label) => (
                    <TableCell key={label} className="text-center">
                      <Checkbox
                        className="align-middle"
                        aria-label={`${loop} takes ${label}`}
                        checked={(draft.routes[loop] ?? []).includes(label)}
                        onCheckedChange={() => edit(toggleRoute(draft, loop, label))}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(stranded.length > 0 || idle.length > 0 || noTriager) && (
          <Alert className="bg-transparent">
            <TriangleAlert />
            <AlertTitle>Check the routing</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {stranded.map((label) => (
                  <li key={label}>
                    No loop takes <span className="font-mono">{label}</span>, so it can't be saved like this.
                  </li>
                ))}
                {idle.map((loop) => (
                  <li key={loop}>
                    <span className="font-mono">{loop}</span> takes nothing and will wait idle.
                  </li>
                ))}
                {noTriager && (
                  <li>
                    {intake.untriaged} ready{" "}
                    {intake.untriaged === 1 ? "ticket carries" : "tickets carry"} no difficulty label, and this project
                    staffs no triager. With routing on, no coder takes them — add a loop with the{" "}
                    <span className="font-mono">triager</span> role, or label them by hand.
                  </li>
                )}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </section>

      {save.kind === "failed" && (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {save.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {save.kind === "refused" && (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            <div>
              <CommandNotice error={save.error} />
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <p>
          Loops read this on every pick, so a save applies from their next ticket without a restart. This is{" "}
          <span className="font-mono">{read.project}</span>'s block
          {read.own ? "" : " — it has none of its own yet, so saving gives it one"} in{" "}
          <span className="font-mono break-all">{read.path}</span>; other projects' routing is untouched.
        </p>
      </div>

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-3">
        <Button
          size="sm"
          disabled={!dirty || save.kind === "saving" || saving.disabled}
          title={saving.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? "Saving…" : "Save routing"}
        </Button>
        <LocalOnlyNote route="/api/jav/save" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!dirty || save.kind === "saving"}
          onClick={() => {
            setDraft(read.config);
            setSave({ kind: "idle" });
          }}
        >
          <RotateCcw />
          Discard
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {dirty ? (
            "Unsaved changes."
          ) : save.kind === "saved" ? (
            <span className="inline-flex items-center gap-1.5 text-status-good">
              <CircleCheck className="size-3.5" />
              Saved {save.at.toLocaleTimeString()}
            </span>
          ) : (
            "No unsaved changes."
          )}
        </span>
      </div>
    </div>
  );
}
