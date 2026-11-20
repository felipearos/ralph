/**
 * The Evals tab's Test set screen (#856): the committed cases a run samples,
 * with their tags, graders and last run, and the curation an operator does on
 * them — add a case from merged PRs, edit its tags and notes, attach a check
 * (#857), retire it, or confirm what the improver suggested for the set
 * (#878). A case every arm passed in its last set runs is flagged saturated
 * and suggested for retirement, with Retire and a Keep that clears the
 * suggestion (#860).
 *
 * The set is a relayed snapshot and add, edit, check, retire and keep are relayed
 * commands, so the remote page does all of it. A case's reason and notes stay
 * on the host unless the project relays details: the local page reads them
 * for the edit form from the local-only case route, and the remote page of a
 * summary-only project edits notes blind. Every decision is in `evals-model.ts`.
 */
import { CircleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { EvalCalibrationSuggestionView, EvalProposalRowView, EvalSetRowView, EvalSetView, EvalSetWriteResult, EvalsView, EvalStartResult } from "../contracts";
import { isRemote } from "./api";
import { CommandNotice, useCommand } from "./command";
import {
  buildCaseAdd,
  buildCaseCheck,
  buildCaseEdit,
  calibrationCountLabel,
  calibrationVerdictLabel,
  caseEditForm,
  caseLabel,
  defaultCaseRepo,
  defaultNoiseFloorArms,
  estimate,
  EVAL_AXIS_LABELS,
  isTestSetProposal,
  lastRunLabel,
  MAX_ARMS,
  MIN_NOISE_FLOOR_ARMS,
  noiseFloorForm,
  noiseFloorPlan,
  noiseStatusLabel,
  proposalLabel,
  saturationNote,
  setVersionLabel,
  suggestionConfirm,
  suggestionLine,
  type CaseAddForm,
  type CaseCheckForm,
  type CaseEditForm,
} from "./evals-model";
import { Quiet } from "./label";
import { useEvalProposals, useEvalSet, useEvalSetCase, useEvals } from "./use-reads";

const Field = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
    <span>{label}</span>
    {children}
  </label>
);

/** A write's answer as the notice beside its button: the transport error, the CLI's refusal verbatim, or `done`. Results' "I disagree" (#876) answers the same way. */
export function writeNotice(result: Awaited<ReturnType<ReturnType<typeof useCommand>["send"]>>, refused: string, done: string): React.ReactNode {
  if (!result.ok) return <CommandNotice error={result.error} />;
  const value = result.value as EvalSetWriteResult | null;
  if (value !== null && !value.ok) return <span>{refused}: {value.why}</span>;
  return <span className="text-status-good">{done}</span>;
}

/**
 * The add form. The Suggestions screen (#858) opens it under a suggestion with
 * `initial` (its repo, PR and a drafted reason) and its own `title` and `done`
 * text, so a case is added one way from either screen.
 */
export function AddCaseCard({ view, onChanged, onAdded, initial, title = "Add a case", done = "Added. It shows in the set below." }: {
  view: EvalSetView | null;
  onChanged: () => void;
  /** Called with the new case's id once the add is committed, before the refresh. */
  onAdded?: (id: string) => void;
  initial?: Partial<CaseAddForm>;
  title?: string;
  done?: string;
}) {
  const add = useCommand("/api/evals/set/add");
  const [form, setForm] = useState<CaseAddForm>(() => ({ repo: defaultCaseRepo(view), prs: "", reason: "", tags: "", notes: "", ...initial }));
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const set = (patch: Partial<CaseAddForm>) => setForm({ ...form, ...patch });
  const built = buildCaseAdd(form);

  const submit = async (): Promise<void> => {
    setNotice(null);
    if (!built.ok) return;
    const result = await add.send<EvalSetWriteResult>(built.body);
    // A queued remote add answers null: nothing is committed yet, so no id to report.
    if (result.ok && result.value !== null && result.value.ok) onAdded?.(result.value.id);
    onChanged();
    setNotice(writeNotice(result, "Not added", done));
    if (result.ok && (result.value === null || result.value.ok)) setForm({ ...form, prs: "", reason: "", tags: "", notes: "" });
  };

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          A case is one or more merged PRs whose ticket a run replays. It is committed to the set with why it belongs.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Repository (owner/name)">
            <Input value={form.repo} onChange={(event) => set({ repo: event.target.value })} placeholder="acme/app" />
          </Field>
          <Field label="Merged PRs">
            <Input value={form.prs} onChange={(event) => set({ prs: event.target.value })} placeholder="2731, 2740" />
          </Field>
          <Field label="Tags (comma-separated)">
            <Input value={form.tags} onChange={(event) => set({ tags: event.target.value })} placeholder="ui, migration" />
          </Field>
        </div>
        <Field label="Reason">
          <Input value={form.reason} onChange={(event) => set({ reason: event.target.value })} placeholder="Why this case belongs in the set" />
        </Field>
        <Field label="Notes (optional)">
          <Textarea value={form.notes} onChange={(event) => set({ notes: event.target.value })} rows={2} />
        </Field>
        {!built.ok && (form.prs.trim() !== "" || form.reason.trim() !== "") && <p className="text-xs text-status-warn">{built.why}</p>}
        {notice !== null && <div className="text-xs">{notice}</div>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!built.ok || add.disabled || add.pending} title={add.why ?? undefined} onClick={() => void submit()}>
            {add.queued ? "Waiting for the machine…" : add.pending ? "Adding…" : "Add"}
          </Button>
          {add.why !== null && <span className="text-xs text-muted-foreground">{add.why}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The set's noise floor (#859): whether the latest one still describes the
 * set, and a start of N identical live arms over the whole set to measure it
 * again. The trial count shows before the button, as on the Run card.
 */
function NoiseFloorSection({ view, evals, onStarted }: { view: EvalSetView; evals: EvalsView | null; onStarted: () => void }) {
  const start = useCommand("/api/evals/start");
  const [arms, setArms] = useState(() => defaultNoiseFloorArms(evals));
  const [notice, setNotice] = useState<React.ReactNode>(null);
  // measuredAt only matters at send; the plan built here judges whether it would go.
  const built = noiseFloorPlan(evals, view, arms, new Date().toISOString());
  const cost = estimate(noiseFloorForm(evals, arms), evals?.history ?? null, view.cases);

  const submit = async (): Promise<void> => {
    setNotice(null);
    const plan = noiseFloorPlan(evals, view, arms, new Date().toISOString());
    if (!plan.ok) return;
    const result = await start.send<EvalStartResult>({ plan: plan.plan });
    onStarted();
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value !== null && !result.value.ok) setNotice(<span>Not started: {result.value.why}</span>);
    else setNotice(<span className="text-status-good">Started{result.value?.ok ? ` (${result.value.id})` : ""}. It shows under Runs as its trials run.</span>);
  };

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm">Noise floor</CardTitle>
        <p className={cn("text-xs", view.noiseFloor?.state === "fresh" ? "text-muted-foreground" : "text-status-warn")}>{noiseStatusLabel(view.noiseFloor)}</p>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <p className="text-xs text-muted-foreground">
          Identical arms on the live lineup replay every active case; how far they drift apart is the gap a later run must beat to count.
        </p>
        <Field label={`Identical arms (${MIN_NOISE_FLOOR_ARMS}–${MAX_ARMS})`} className="w-40">
          <Input
            type="number"
            min={MIN_NOISE_FLOOR_ARMS}
            max={MAX_ARMS}
            step={1}
            value={Number.isNaN(arms) ? "" : arms}
            onChange={(event) => setArms(event.target.value === "" ? Number.NaN : Number(event.target.value))}
          />
        </Field>
        <p className="text-xs text-muted-foreground">{cost.text}</p>
        {!built.ok && <p className="text-xs text-status-warn">{built.why}</p>}
        {notice !== null && <div className="text-xs">{notice}</div>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!built.ok || start.disabled || start.pending} title={start.why ?? (built.ok ? undefined : built.why)} onClick={() => void submit()}>
            {start.queued ? "Waiting for the machine…" : start.pending ? "Starting…" : "Measure noise floor"}
          </Button>
          {start.why !== null && <span className="text-xs text-muted-foreground">{start.why}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The inline edit form under a row. Locally the notes come from the case
 * route, read once on open; remotely from the row when the project relays
 * details, else they are unknown and a blank field leaves them as they are.
 */
function EditCaseForm({ row, details, onClose, onChanged }: { row: EvalSetRowView; details: boolean; onClose: () => void; onChanged: () => void }) {
  const remote = isRemote();
  const { read } = useEvalSetCase(remote ? null : row.id);
  if (!remote && read.state === "loading") return <Skeleton className="h-24" />;
  if (!remote && read.state === "error") {
    return (
      <div className="space-y-2 text-xs">
        <p className="text-status-warn">The case's notes could not be read: {read.message}</p>
        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
      </div>
    );
  }
  const current = !remote && read.state === "ready"
    ? { id: row.id, tags: read.data.tags, notes: read.data.notes }
    : { id: row.id, tags: row.tags, ...(details && row.notes !== undefined ? { notes: row.notes } : {}) };
  const notesKnown = current.notes !== undefined;
  return <EditCaseFields current={current} notesKnown={notesKnown} onClose={onClose} onChanged={onChanged} />;
}

function EditCaseFields({ current, notesKnown, onClose, onChanged }: {
  current: { id: string; tags: string[]; notes?: string };
  notesKnown: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const edit = useCommand("/api/evals/set/edit");
  const [form, setForm] = useState<CaseEditForm>(() => caseEditForm(current));
  const [notice, setNotice] = useState<React.ReactNode>(null);
  // What the case holds now: the form stays open after a save, so the next
  // edit is judged against what was saved, not against what the form opened on.
  const [baseline, setBaseline] = useState(current);
  const [baselineNotesKnown, setBaselineNotesKnown] = useState(notesKnown);
  const built = buildCaseEdit(baseline, form, baselineNotesKnown);

  const submit = async (): Promise<void> => {
    setNotice(null);
    if (!built.ok) return;
    const result = await edit.send<EvalSetWriteResult>(built.body);
    const value = result.ok ? result.value : null;
    if (value !== null && value.ok) {
      const { tags, notes } = built.body;
      setBaseline({ ...baseline, ...(tags === undefined ? {} : { tags }), ...(notes === undefined ? {} : { notes }) });
      if (notes !== undefined) setBaselineNotesKnown(true);
    }
    onChanged();
    setNotice(writeNotice(result, "Not saved", "Saved."));
  };

  return (
    <div className="space-y-3">
      <Field label="Tags (comma-separated)">
        <Input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
      </Field>
      <Field label="Notes">
        <Textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows={3} />
      </Field>
      {!baselineNotesKnown && <Quiet>Notes stay on the host for this project: a blank field leaves them as they are, and text typed here replaces them.</Quiet>}
      {notice !== null && <div className="text-xs">{notice}</div>}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!built.ok || edit.disabled || edit.pending} title={edit.why ?? (built.ok ? undefined : "Nothing changed")} onClick={() => void submit()}>
          {edit.queued ? "Waiting for the machine…" : edit.pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        {edit.why !== null && <span className="text-xs text-muted-foreground">{edit.why}</span>}
      </div>
    </div>
  );
}

/**
 * The inline attach-check form under a row (#857). The server runs the check
 * on the case's base and reference and stores it only if it fails on one and
 * passes on the other; its refusal reason is the notice. The stored check is
 * never shown back: the set view does not carry it.
 */
function CheckCaseForm({ row, onClose, onChanged }: { row: EvalSetRowView; onClose: () => void; onChanged: () => void }) {
  const check = useCommand("/api/evals/set/check");
  const [form, setForm] = useState<CaseCheckForm>({ kind: "test", value: "" });
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const built = buildCaseCheck(row.id, form);

  const submit = async (): Promise<void> => {
    setNotice(null);
    if (!built.ok) return;
    const result = await check.send<EvalSetWriteResult>(built.body);
    onChanged();
    setNotice(writeNotice(result, "Not attached", "Attached. Set runs grade this case on its check."));
  };

  return (
    <div className="space-y-3">
      <div className="inline-flex gap-1">
        <Button size="sm" variant={form.kind === "test" ? "secondary" : "ghost"} onClick={() => setForm({ ...form, kind: "test" })}>Test file</Button>
        <Button size="sm" variant={form.kind === "command" ? "secondary" : "ghost"} onClick={() => setForm({ ...form, kind: "command" })}>Command</Button>
      </div>
      <Input
        value={form.value}
        onChange={(event) => setForm({ ...form, value: event.target.value })}
        placeholder={form.kind === "test" ? "src/feature.test.ts" : "bun test src/feature.test.ts"}
        className="font-mono"
      />
      <Quiet>Accepted only if it fails on the case's base and passes on its reference. Running it takes a few minutes.</Quiet>
      {!built.ok && form.value.trim() !== "" && <p className="text-xs text-status-warn">{built.why}</p>}
      {notice !== null && <div className="text-xs">{notice}</div>}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!built.ok || check.disabled || check.pending} title={check.why ?? (built.ok ? undefined : built.why)} onClick={() => void submit()}>
          {check.queued ? "Waiting for the machine…" : check.pending ? "Checking…" : "Attach check"}
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        {check.why !== null && <span className="text-xs text-muted-foreground">{check.why}</span>}
      </div>
    </div>
  );
}

/** Retire on a second click: the first arms it, so one stray click retires nothing. */
function RetireAction({ row, onChanged, onNotice }: { row: EvalSetRowView; onChanged: () => void; onNotice: (notice: React.ReactNode) => void }) {
  const retire = useCommand("/api/evals/set/retire");
  const [armed, setArmed] = useState(false);

  const submit = async (): Promise<void> => {
    onNotice(null);
    const result = await retire.send<EvalSetWriteResult>({ case: row.id });
    setArmed(false);
    onChanged();
    onNotice(writeNotice(result, "Not retired", "Retired. No run samples it from now on."));
  };

  if (!armed) {
    return (
      <Button size="sm" variant="ghost" disabled={retire.disabled} title={retire.why ?? undefined} onClick={() => setArmed(true)}>
        Retire
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Button size="sm" variant="destructive" disabled={retire.disabled || retire.pending} onClick={() => void submit()}>
        {retire.queued ? "Waiting for the machine…" : retire.pending ? "Retiring…" : "Confirm retire"}
      </Button>
      <Button size="sm" variant="ghost" disabled={retire.pending} onClick={() => setArmed(false)}>Cancel</Button>
    </span>
  );
}

/** Keep a saturated case (#860): one click, since it only clears the suggestion until more runs flag it again. */
function KeepAction({ row, onChanged, onNotice }: { row: EvalSetRowView; onChanged: () => void; onNotice: (notice: React.ReactNode) => void }) {
  const keep = useCommand("/api/evals/set/keep");
  const runs = row.saturation?.window ?? 0;

  const submit = async (): Promise<void> => {
    onNotice(null);
    const result = await keep.send<EvalSetWriteResult>({ case: row.id });
    onChanged();
    onNotice(writeNotice(result, "Not kept", `Kept. It is flagged again only after ${runs} more set run${runs === 1 ? "" : "s"} that every arm passes.`));
  };

  return (
    <Button size="sm" variant="ghost" disabled={keep.disabled || keep.pending} title={keep.why ?? undefined} onClick={() => void submit()}>
      {keep.queued ? "Waiting for the machine…" : keep.pending ? "Keeping…" : "Keep"}
    </Button>
  );
}

/**
 * A case's calibration verdicts (#876), only on a row that carries them
 * (details on): a summary-only row has the count alone, and the page never
 * draws a reason the data does not hold.
 */
function CalibrationList({ verdicts }: { verdicts: NonNullable<EvalSetRowView["calibration"]> }) {
  return (
    <ul className="mt-1 space-y-1">
      {verdicts.map((verdict, index) => (
        <li key={`${verdict.at}-${index}`}>
          <span className="font-medium">{EVAL_AXIS_LABELS[verdict.axis]}: {calibrationVerdictLabel(verdict)}</span>
          <span className="text-muted-foreground"> — {verdict.reason} · {verdict.by}, {verdict.at.slice(0, 10)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Calibrate next (#876): the contested cases worth a verdict, in the order the set view gives (uncalibrated first). */
function CalibrateNextSection({ suggestions }: { suggestions: EvalCalibrationSuggestionView[] }) {
  return (
    <Card className="gap-2 py-4 shadow-none">
      <CardHeader className="px-5"><CardTitle className="text-sm">Calibrate next</CardTitle></CardHeader>
      <CardContent className="px-5">
        <ul className="space-y-1 text-sm">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id}>
              <span className="font-medium">{suggestion.title}</span>
              <span className="text-xs text-muted-foreground">
                {" · "}{suggestion.contested.map((item) => `${EVAL_AXIS_LABELS[item.axis]} (${item.arms.join(" vs ")})`).join("; ")}
                {" · "}<span className="font-mono">{suggestion.run}</span>
                {" · "}{calibrationCountLabel(suggestion.calibrations) ?? "no verdict yet"}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CaseRow({ row, details, onChanged }: { row: EvalSetRowView; details: boolean; onChanged: () => void }) {
  // One inline form at a time under the row: the edit form or the attach-check form.
  const [open, setOpen] = useState<"edit" | "check" | null>(null);
  const toggle = (form: "edit" | "check") => setOpen(open === form ? null : form);
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const retired = row.status === "retired";
  const saturation = saturationNote(row);
  const columns = details ? 7 : 6;
  const verdicts = calibrationCountLabel(row.calibrations);
  return (
    <>
      <TableRow className={cn(retired && "text-muted-foreground")}>
        <TableCell className="max-w-80 whitespace-normal">
          <div className="font-medium">{row.title}</div>
          <div className="font-mono text-xs text-muted-foreground">{caseLabel(row)}</div>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {row.tags.map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}
          </div>
        </TableCell>
        <TableCell className="text-xs">{row.graders.join(", ")}</TableCell>
        <TableCell className="font-mono text-xs">{lastRunLabel(row)}</TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            <Badge variant={retired ? "secondary" : "outline"} className={cn("text-[10px]", row.status === "saturated" && "text-status-warn")}>{row.status}</Badge>
            {saturation !== null && row.status !== "saturated" && (
              <Badge variant="outline" className="text-[10px] text-status-warn" title={saturation}>saturated</Badge>
            )}
          </div>
          {saturation !== null && <p className="mt-1 max-w-60 whitespace-normal text-xs text-status-warn">{saturation}</p>}
          {verdicts !== null && <p className="mt-1 text-xs text-muted-foreground">{verdicts}</p>}
        </TableCell>
        {details && (
          <TableCell className="max-w-80 whitespace-normal text-xs">
            {row.reason !== undefined && row.reason !== "" && <p>{row.reason}</p>}
            {row.notes !== undefined && row.notes !== "" && <p className="text-muted-foreground">{row.notes}</p>}
            {(row.calibration ?? []).length > 0 && <CalibrationList verdicts={row.calibration!} />}
          </TableCell>
        )}
        <TableCell className="text-right">
          <span className="inline-flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => toggle("edit")}>{open === "edit" ? "Close" : "Edit"}</Button>
            {!retired && <Button size="sm" variant="ghost" onClick={() => toggle("check")}>{open === "check" ? "Close" : "Attach check"}</Button>}
            {saturation !== null && <KeepAction row={row} onChanged={onChanged} onNotice={setNotice} />}
            {!retired && <RetireAction row={row} onChanged={onChanged} onNotice={setNotice} />}
          </span>
          {notice !== null && <div className="mt-1 text-xs">{notice}</div>}
        </TableCell>
      </TableRow>
      {open === "edit" && (
        <TableRow>
          <TableCell colSpan={columns} className="whitespace-normal">
            <EditCaseForm row={row} details={details} onClose={() => setOpen(null)} onChanged={onChanged} />
          </TableCell>
        </TableRow>
      )}
      {open === "check" && !retired && (
        <TableRow>
          <TableCell colSpan={columns} className="whitespace-normal">
            <CheckCaseForm row={row} onClose={() => setOpen(null)} onChanged={onChanged} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * One improver suggestion for the set (#878). Confirm sends the set's own add,
 * check or retire, so a check still has to fail on the base and pass on the
 * reference, and a refusal reads as the CLI's reason. Nothing reaches the set
 * before that click. A row without a suggestion (a summary-only project) has
 * nothing to send, so it has no Confirm.
 */
function SuggestedRow({ row, onChanged }: { row: EvalProposalRowView; onChanged: () => void }) {
  const confirm = suggestionConfirm(row.suggestion);
  const command = useCommand(confirm?.path ?? "/api/evals/set/add");
  const [notice, setNotice] = useState<React.ReactNode>(null);

  const submit = async (): Promise<void> => {
    if (confirm === null) return;
    setNotice(null);
    const result = await command.send<EvalSetWriteResult>(confirm.body);
    onChanged();
    setNotice(writeNotice(result, confirm.refused, confirm.done));
  };

  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[10px]">{proposalLabel(row)}</Badge>
        <span className="break-all">{suggestionLine(row)}</span>
        {confirm !== null && (
          <Button size="xs" variant="outline" disabled={command.disabled || command.pending} title={command.why ?? undefined} onClick={() => void submit()}>
            {command.queued ? "Waiting for the machine…" : command.pending ? "Confirming…" : "Confirm"}
          </Button>
        )}
      </div>
      {confirm === null && <Quiet>This project does not relay eval details, so its content is not here to confirm; add it with the form above.</Quiet>}
      {notice !== null && <div>{notice}</div>}
    </li>
  );
}

/** The improver's suggestions for the set (#878), waiting on an operator: shown only when there is one. */
function SuggestedSection({ proposals, onChanged }: { proposals: EvalProposalRowView[]; onChanged: () => void }) {
  const suggested = proposals.filter((row) => isTestSetProposal(row.kind) && row.status === "suggested");
  if (suggested.length === 0) return null;
  return (
    <section className="space-y-2 text-xs">
      <h3 className="text-sm font-medium">Suggested by the improver</h3>
      <ul className="space-y-2">
        {suggested.map((row) => <SuggestedRow key={row.id} row={row} onChanged={onChanged} />)}
      </ul>
    </section>
  );
}

export function EvalSetScreen() {
  const { read, refresh } = useEvalSet();
  const { read: evalsRead, refresh: refreshEvals } = useEvals();
  const { read: proposalsRead, refresh: refreshProposals } = useEvalProposals();
  if (read.state === "loading") return <Skeleton className="h-64" />;
  const view = read.data;
  // The arm count and panel come from the evals view; before it is in, the card opens on 3 and the default panel.
  const evals = evalsRead.state === "loading" ? null : evalsRead.data;
  const saturatedCount = (view?.cases ?? []).filter((row) => saturationNote(row) !== null).length;
  return (
    <div className="space-y-4">
      {view !== null && (
        <p className="text-sm">
          <span className="font-medium">{setVersionLabel(view)}</span>
          <span className="text-muted-foreground"> · {view.cases.length} case{view.cases.length === 1 ? "" : "s"}</span>
        </p>
      )}
      {view?.problem && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>The project's test set could not be read</AlertTitle>
          <AlertDescription><p className="font-mono text-xs break-all">{view.problem}</p></AlertDescription>
        </Alert>
      )}
      {read.state === "error" && view === null && <Quiet>{read.message}</Quiet>}
      {view !== null && <NoiseFloorSection key={evals === null ? "empty" : "read"} view={view} evals={evals} onStarted={refreshEvals} />}
      <AddCaseCard key={view === null ? "empty" : "read"} view={view} onChanged={refresh} />
      {proposalsRead.state !== "loading" && proposalsRead.data !== null && (
        <SuggestedSection proposals={proposalsRead.data.proposals} onChanged={() => { refresh(); refreshProposals(); }} />
      )}
      {(view?.calibrationSuggestions ?? []).length > 0 && <CalibrateNextSection suggestions={view!.calibrationSuggestions} />}
      {saturatedCount > 0 && (
        <p className="text-xs text-status-warn">{saturatedCount} saturated case{saturatedCount === 1 ? "" : "s"} suggested for retirement</p>
      )}
      {(view?.cases ?? []).length === 0 ? (
        <Quiet>No case in the set yet.</Quiet>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Graders</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Status</TableHead>
              {view!.details && <TableHead>Reason · notes</TableHead>}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {view!.cases.map((row) => <CaseRow key={row.id} row={row} details={view!.details} onChanged={refresh} />)}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
