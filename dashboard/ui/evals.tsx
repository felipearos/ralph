/**
 * The Evals tab (#801): start an A/B on a merged PR, a clerk's person tickets
 * or the project's test set (#854) — arms that are a lineup
 * and, optionally, a prompt overlay — and read every run's results: each
 * arm's outcome and numbers per case, every judge's axis scores with the
 * contested ones flagged, the analyst's improvements and the repeats.
 *
 * The read is a relayed snapshot and Start and Stop are relayed commands, so
 * the remote page does all of it; a trial's patch is the project's code, so
 * it opens on the local page, and on the remote page only for a project that
 * set `relayEvalPatches`. Every decision is in `evals-model.ts`.
 */
import { CircleAlert, Flag, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { EVAL_AXES, type EvalCaseView, type EvalRepeatView, type EvalRunView, type EvalSetRowView, type EvalSetView, type EvalSetWriteResult, type EvalImproveResult, type EvalInboxWriteResult, type EvalsView, type EvalStartResult, type EvalStopResult } from "../contracts";
import { isRemote } from "./api";
import { CommandNotice, useCommand } from "./command";
import {
  accuracyAxisLines,
  judgeAccuracyHeadline,
  contestedExcludedLabel,
  armGapLabel,
  goalVerdictLabel,
  guardrailConditionLabel,
  armLabel,
  buildPlan,
  calibrationBody,
  calibrationCaseId,
  calibrationDefaults,
  caseHasGrade,
  contestedFor,
  costLabel,
  defaultForm,
  durationLabel,
  armResolutionFor,
  estimate,
  EVAL_AXIS_LABELS,
  firstTrialLabel,
  floorRunLabel,
  graderLabel,
  judgeScoreLabel,
  judgeTotalLabel,
  MAX_ARMS,
  MAX_CLERK_CAP,
  NO_NOISE_FLOOR,
  modelsLabel,
  noiseStatusLabel,
  objectiveLabel,
  objectiveTotalLabel,
  patchOpens,
  qualityCostPlot,
  rankingLabel,
  restoreForm,
  runConfigLabel,
  runHasGrades,
  runStatus,
  setTagsOffered,
  setShortVersion,
  sourceLabel,
  spreadLabel,
  tokensLabel,
  type CalibrationForm,
  type RunForm,
} from "./evals-model";
import { QualityCostChart } from "./evals-plot";
import { EvalInboxScreen } from "./evals-inbox";
import { EvalProposalsScreen } from "./evals-proposals";
import { EvalSetScreen, writeNotice } from "./evals-set";
import { EvalSuggestionsScreen } from "./evals-suggestions";
import { Quiet } from "./label";
import { evalPatchUrl } from "./reads";
import { screenProject } from "./screen-project";
import { useEvalSet, useEvals } from "./use-reads";

const Field = ({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) => (
  <label className={cn("flex flex-col gap-1 text-xs text-muted-foreground", className)}>
    <span>{label}</span>
    {children}
  </label>
);

const TONE: Record<ReturnType<typeof runStatus>["tone"], string> = {
  live: "text-status-info",
  ok: "text-status-good",
  warn: "text-status-warn",
  muted: "text-muted-foreground",
};

/** Where a project's Run form is kept across reloads, one per project. */
const formKey = (project: string | null): string => `ralph.evals.form.${project ?? "_"}`;

function loadForm(project: string | null, fallback: RunForm): RunForm {
  try {
    const raw = localStorage.getItem(formKey(project));
    return raw === null ? fallback : restoreForm(JSON.parse(raw), fallback);
  } catch {
    // Storage blocked or a value that is not JSON: the form opens fresh.
    return fallback;
  }
}

function saveForm(project: string | null, form: RunForm): void {
  try {
    localStorage.setItem(formKey(project), JSON.stringify(form));
  } catch {
    // Storage blocked or full: the form just does not survive a reload.
  }
}

/** The test set's controls: which cases a set run replays, and the set's version. */
function SetControls({ form, setView, set }: { form: RunForm; setView: EvalSetView | null; set: (patch: Partial<RunForm>) => void }) {
  if (setView === null) return <Quiet>Reading the test set…</Quiet>;
  const tags = setTagsOffered(setView.cases);
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Cases" className="sm:w-56">
          <Select value={form.setMode} onValueChange={(value) => set({ setMode: value as RunForm["setMode"] })}>
            <SelectTrigger aria-label="Cases"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All active cases</SelectItem>
              <SelectItem value="tags">By tag</SelectItem>
              <SelectItem value="subset">Hand-picked</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <span className="pb-2 text-xs text-muted-foreground">Set <span className="font-mono">{setShortVersion(setView.version)}</span> · {setView.cases.length} case{setView.cases.length === 1 ? "" : "s"}</span>
      </div>
      {setView.problem !== null && <p className="font-mono text-xs break-all text-status-warn">{setView.problem}</p>}
      {form.setMode === "tags" && (
        tags.length === 0 ? <Quiet>No case carries a tag.</Quiet> : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Button key={tag} size="xs" variant={form.setTags.includes(tag) ? "default" : "outline"} aria-pressed={form.setTags.includes(tag)} onClick={() => set({ setTags: toggle(form.setTags, tag) })}>
                {tag}
              </Button>
            ))}
          </div>
        )
      )}
      {form.setMode === "subset" && (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {setView.cases.map((entry) => {
            const retired = entry.status === "retired";
            return (
              <li key={entry.id}>
                <label className={cn("flex flex-wrap items-baseline gap-x-2 text-sm", retired && "text-muted-foreground")}>
                  <input type="checkbox" disabled={retired} checked={!retired && form.setCases.includes(entry.id)} onChange={() => set({ setCases: toggle(form.setCases, entry.id) })} />
                  <span>{entry.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{entry.id}</span>
                  {entry.tags.map((tag) => <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>)}
                  {entry.status !== "active" && <Badge variant="secondary" className="text-[10px]">{entry.status}</Badge>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RunFormCard({ view, setView, project, onStarted }: { view: EvalsView | null; setView: EvalSetView | null; project: string | null; onStarted: () => void }) {
  const start = useCommand("/api/evals/start");
  const add = useCommand("/api/evals/inbox/add");
  const [reason, setReason] = useState("");
  const [form, setForm] = useState<RunForm>(() => loadForm(project, defaultForm(view)));
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const set = (patch: Partial<RunForm>) => setForm({ ...form, ...patch });
  // Saved only once the view is in: a form seeded before it holds fallback
  // defaults, and storing those would outlive the view's own on every reload.
  useEffect(() => { if (view !== null) saveForm(project, form); }, [view, project, form]);
  const clerks = view?.clerks ?? [];
  // A form on "clerk" against a view with no clerks falls back to PRs, and an
  // unset clerk (the form was built before the view arrived) to the first
  // one: the plan is built from this resolved form, so what is shown is sent.
  const source = form.source === "clerk" ? (clerks.length > 0 ? "clerk" : "pr") : form.source;
  const effective: RunForm = { ...form, source, clerk: form.clerk === "" ? (clerks[0] ?? "") : form.clerk };
  const clerkRepos = view?.clerkRepos ?? [];
  const built = buildPlan(effective, clerkRepos, setView);
  const cost = estimate(effective, view?.history ?? null, setView?.cases ?? []);
  const lineups = ["live", ...(view?.lineups ?? [])];

  const submit = async (): Promise<void> => {
    setNotice(null);
    if (!built.ok) return;
    const result = await start.send<EvalStartResult>({ plan: built.plan });
    onStarted();
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value !== null && !result.value.ok) setNotice(<span>Not started: {result.value.why}</span>);
    else setNotice(<span className="text-status-good">Started{result.value?.ok ? ` (${result.value.id})` : ""}. It shows below as its trials run.</span>);
  };

  // Puts the plan in the Inbox (#872) for later; it starts nothing.
  const addToInbox = async (): Promise<void> => {
    setNotice(null);
    if (!built.ok) return;
    const why = reason.trim();
    const result = await add.send<EvalInboxWriteResult>(why === "" ? { plan: built.plan } : { plan: built.plan, reason: why });
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value !== null && !result.value.ok) setNotice(<span>Not added: {result.value.why}</span>);
    else {
      setReason("");
      setNotice(<span className="text-status-good">Added to the inbox</span>);
    }
  };

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        {source === "set" ? (
          <>
            <CardTitle className="text-sm">New run over the test set</CardTitle>
            <p className="text-xs text-muted-foreground">
              Each arm replays every selected case from its merge-base as one sandboxed coder iteration. Nothing is pushed or published.
            </p>
          </>
        ) : source === "clerk" ? (
          <>
            <CardTitle className="text-sm">New backtest on a clerk's person tickets</CardTitle>
            <p className="text-xs text-muted-foreground">
              Each arm replays up to the cap of the tickets the clerk handed to a person, each from its merge-base. Nothing is pushed or published.
            </p>
          </>
        ) : (
          <>
            <CardTitle className="text-sm">New A/B on a merged PR</CardTitle>
            <p className="text-xs text-muted-foreground">
              Each arm replays the PR's ticket from its merge-base as one sandboxed coder iteration, with the same simulated review rounds. Nothing is pushed or published.
            </p>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="sm:w-72">
          <Field label="Source">
            <Select value={source} onValueChange={(value) => set({ source: value as RunForm["source"] })}>
              <SelectTrigger aria-label="Source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pr">Merged PRs</SelectItem>
                {clerks.length > 0 && <SelectItem value="clerk">A clerk's person tickets</SelectItem>}
                <SelectItem value="set">Test set</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {source === "set" ? (
          <SetControls form={form} setView={setView} set={set} />
        ) : source === "clerk" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Clerk">
              <Select value={effective.clerk} onValueChange={(clerk) => set({ clerk })}>
                <SelectTrigger aria-label="Clerk"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {clerks.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Tickets (cap)">
              <Input type="number" min={1} max={MAX_CLERK_CAP} value={form.cap} onChange={(event) => set({ cap: Number(event.target.value) })} />
            </Field>
            <Field label="Since (optional)">
              <Input type="date" value={form.since} onChange={(event) => set({ since: event.target.value })} />
            </Field>
            {clerkRepos.map((repo) => (
              <div key={repo} className="sm:col-span-3">
                <Field label={`Checkout of ${repo}`}>
                  <Input
                    value={form.checkouts[repo] ?? ""}
                    placeholder={`/home/…/${repo.split("/").pop() ?? repo}`}
                    onChange={(event) => set({ checkouts: { ...form.checkouts, [repo]: event.target.value } })}
                  />
                </Field>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Merged PRs (one ticket's)">
              <Input value={form.prs} placeholder="2731, 2740" onChange={(event) => set({ prs: event.target.value })} />
            </Field>
            <Field label="Ticket (empty: the issue the PR closes)">
              <Input value={form.ticket} placeholder="#2702 or OA-12" onChange={(event) => set({ ticket: event.target.value })} />
            </Field>
            <Field label="Repo (empty: the project's)">
              <Input value={form.repo} placeholder="owner/name" onChange={(event) => set({ repo: event.target.value })} />
            </Field>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Arms</p>
          {form.arms.map((arm, index) => (
            <div key={index} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[10rem_12rem_1fr_auto]">
              <Field label="Name">
                <Input value={arm.name} onChange={(event) => set({ arms: form.arms.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)) })} />
              </Field>
              <Field label="Lineup">
                <Select value={arm.lineup} onValueChange={(lineup) => set({ arms: form.arms.map((entry, at) => (at === index ? { ...entry, lineup } : entry)) })}>
                  <SelectTrigger aria-label={`${arm.name} lineup`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {lineups.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Prompt overlay (optional absolute path)">
                <Input value={arm.overlay} placeholder="/home/…/overlays/short-coder" onChange={(event) => set({ arms: form.arms.map((entry, at) => (at === index ? { ...entry, overlay: event.target.value } : entry)) })} />
              </Field>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove arm ${arm.name}`} disabled={form.arms.length === 1} onClick={() => set({ arms: form.arms.filter((_, at) => at !== index) })}>
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="xs" disabled={form.arms.length >= MAX_ARMS} onClick={() => set({ arms: [...form.arms, { name: `arm-${form.arms.length + 1}`, lineup: "live", overlay: "" }] })}>
            <Plus /> Arm
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Judge panel</p>
          {form.judges.map((judge, index) => (
            <div key={index} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_10rem_auto]">
              <Field label="Family">
                <Select value={judge.runner} onValueChange={(runner) => set({ judges: form.judges.map((entry, at) => (at === index ? { ...entry, runner: runner as "claude" | "codex" } : entry)) })}>
                  <SelectTrigger aria-label="Judge family"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <Input value={judge.model} onChange={(event) => set({ judges: form.judges.map((entry, at) => (at === index ? { ...entry, model: event.target.value } : entry)) })} />
              </Field>
              <Field label="Name (optional)">
                <Input value={judge.name} onChange={(event) => set({ judges: form.judges.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)) })} />
              </Field>
              <Button variant="ghost" size="icon-sm" aria-label="Remove judge" disabled={form.judges.length === 1} onClick={() => set({ judges: form.judges.filter((_, at) => at !== index) })}>
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="xs" onClick={() => set({ judges: [...form.judges, { name: "", runner: "claude", model: "" }] })}>
            <Plus /> Judge
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:w-96">
          <Field label="Repeats when arms disagree">
            <Select value={String(form.repeats)} onValueChange={(value) => set({ repeats: Number(value) })}>
              <SelectTrigger aria-label="Repeats"><SelectValue /></SelectTrigger>
              <SelectContent>{[0, 1, 2, 3].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Trial cap (minutes)">
            <Input type="number" min={10} max={240} value={form.trialMinutes} onChange={(event) => set({ trialMinutes: Math.max(10, Number(event.target.value) || 90) })} />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">{cost.text}</p>
        {!built.ok && (source !== "pr" || form.prs.trim() !== "") && <p className="text-xs text-status-warn">{built.why}</p>}
        {notice !== null && <div className="text-xs">{notice}</div>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!built.ok || start.disabled || start.pending} title={start.why ?? undefined} onClick={() => void submit()}>
            {start.queued ? "Waiting for the machine…" : start.pending ? "Starting…" : "Start"}
          </Button>
          <Button size="sm" variant="outline" disabled={!built.ok || add.disabled || add.pending} title={add.why ?? undefined} onClick={() => void addToInbox()}>
            {add.queued ? "Waiting for the machine…" : add.pending ? "Adding…" : "Add to inbox"}
          </Button>
          <Input className="h-8 max-w-64 text-xs" placeholder="Why (optional)" aria-label="Why add to the inbox" value={reason} onChange={(event) => setReason(event.target.value)} />
          {start.why !== null && <span className="text-xs text-muted-foreground">{start.why}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * "I disagree" on a Results case (#876): the operator's verdict on which of
 * two arms was better on one axis, stored on the test-set case so the panel
 * can be calibrated against it. A case the set does not hold has nowhere to
 * store it, so its button is shown disabled and says so. `undefined` means the
 * set was not read (loading or failed): "not in the test set" would then be a
 * guess, so the button says the set is unread instead.
 */
function DisagreeAction({ entry, caseId }: { entry: EvalCaseView; caseId: string | null | undefined }) {
  const calibrate = useCommand("/api/evals/set/calibrate");
  const [form, setForm] = useState<CalibrationForm | null>(null);
  const [notice, setNotice] = useState<React.ReactNode>(null);
  if (caseId === undefined) {
    return <Button size="sm" variant="outline" disabled>Test set not read</Button>;
  }
  if (caseId === null) {
    return <Button size="sm" variant="outline" disabled>Not in the test set</Button>;
  }
  const set = (patch: Partial<CalibrationForm>) => setForm((current) => {
    if (current === null) return current;
    const next = { ...current, ...patch };
    // Keep the preferred arm one of the pair when the pair changes under it.
    if (next.preferred !== next.armA && next.preferred !== next.armB) next.preferred = next.armA;
    return next;
  });
  const built = form === null ? null : calibrationBody(caseId, form);
  const arms = entry.arms.map((arm) => arm.arm);

  const submit = async (): Promise<void> => {
    if (built === null || !built.ok) return;
    setNotice(null);
    const result = await calibrate.send<EvalSetWriteResult>(built.body);
    const value = result.ok ? (result.value as EvalSetWriteResult | null) : null;
    if (result.ok && (value === null || value.ok)) setForm(null);
    setNotice(writeNotice(result, "Not recorded", "Recorded. It shows on the case in the Test set."));
  };

  if (form === null) {
    return (
      <div className="space-y-1">
        <Button size="sm" variant="outline" onClick={() => { setNotice(null); setForm(calibrationDefaults(entry)); }}>I disagree</Button>
        {notice !== null && <div className="text-xs">{notice}</div>}
      </div>
    );
  }
  const armSelect = (label: string, value: string, other: string, onChange: (arm: string) => void) => (
    <Field label={label}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
        <SelectContent>
          {arms.filter((arm) => arm !== other).map((arm) => <SelectItem key={arm} value={arm}>{armLabel(arm, entry)}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Axis">
          <Select value={form.axis} onValueChange={(axis) => set({ axis: axis as CalibrationForm["axis"] })}>
            <SelectTrigger aria-label="Axis"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EVAL_AXES.map((axis) => <SelectItem key={axis} value={axis}>{EVAL_AXIS_LABELS[axis]}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {armSelect("Arm", form.armA, form.armB, (armA) => set({ armA }))}
        {armSelect("Against", form.armB, form.armA, (armB) => set({ armB }))}
        <Field label="Better">
          <Select value={form.preferred} onValueChange={(preferred) => set({ preferred })}>
            <SelectTrigger aria-label="Better"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[form.armA, form.armB].filter((arm) => arm !== "").map((arm) => <SelectItem key={arm} value={arm}>{armLabel(arm, entry)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Why">
        <Textarea rows={2} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      {built !== null && !built.ok && <p className="text-xs text-status-warn">{built.why}</p>}
      {notice !== null && <div className="text-xs">{notice}</div>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={built === null || !built.ok || calibrate.disabled || calibrate.pending} title={calibrate.why ?? (built !== null && !built.ok ? built.why : undefined)} onClick={() => void submit()}>
          {calibrate.queued ? "Waiting for the machine…" : calibrate.pending ? "Recording…" : "Record verdict"}
        </Button>
        <Button size="sm" variant="ghost" disabled={calibrate.pending} onClick={() => { setForm(null); setNotice(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

function CaseBlock({ run, entry, project, relayPatches, setRows }: { run: EvalRunView; entry: EvalCaseView; project: string | null; relayPatches: boolean; setRows: readonly EvalSetRowView[] | null }) {
  const ranking = rankingLabel(entry);
  const patch = patchOpens(isRemote(), relayPatches);
  const scored = entry.arms.flatMap((arm) => arm.axes.map((axes) => ({ arm: arm.arm, ...axes })));
  const grader = graderLabel(entry.grade);
  const graded = caseHasGrade(entry);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">{entry.title}</span>
        <span className="font-mono text-xs text-muted-foreground">{entry.key} · {entry.prs.map((pr) => `#${pr}`).join(", ")}</span>
        {ranking !== null && <span className="text-xs">Panel: {ranking}</span>}
        {grader !== null && <span className="text-xs text-muted-foreground">Grader: {grader}</span>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Arm</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Gates</TableHead>
            <TableHead>Held-out</TableHead>
            <TableHead>Findings</TableHead>
            <TableHead>Rounds</TableHead>
            <TableHead>Time</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Cost</TableHead>
            {graded && <TableHead>Objective</TableHead>}
            {graded && <TableHead>Judge score</TableHead>}
            {patch && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entry.arms.map((arm) => (
            <TableRow key={arm.arm}>
              <TableCell className="font-medium" title={modelsLabel(armResolutionFor(run, arm.arm)) ?? undefined}>{armLabel(arm.arm, entry)}</TableCell>
              <TableCell>{arm.outcome ?? "merged"}</TableCell>
              <TableCell className="tabular-nums">{arm.gates ?? "—"}</TableCell>
              <TableCell className="tabular-nums">{arm.heldOut ?? "—"}</TableCell>
              <TableCell className="tabular-nums">{arm.findings === null ? "—" : `P1 ${arm.findings.P1} · P2 ${arm.findings.P2} · P3 ${arm.findings.P3}`}</TableCell>
              <TableCell className="tabular-nums">{arm.rounds ?? "—"}</TableCell>
              <TableCell className="tabular-nums" title={arm.arm === "a" ? "open to merge" : "trial run time"}>{durationLabel(arm.wallSeconds)}</TableCell>
              <TableCell className="tabular-nums">{tokensLabel(arm.tokens)}</TableCell>
              <TableCell className="tabular-nums">{arm.arm === "a" ? "—" : costLabel(arm.costUsd)}</TableCell>
              {graded && <TableCell>{objectiveLabel(arm.objective)}</TableCell>}
              {graded && <TableCell className="tabular-nums">{judgeScoreLabel(arm.judge)}</TableCell>}
              {patch && (
                <TableCell>
                  {arm.arm !== "a" && (
                    <a className="text-xs underline-offset-4 hover:underline" href={evalPatchUrl(project, run.dir, entry.key, arm.arm)} target="_blank" rel="noreferrer">
                      Patch
                    </a>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {scored.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Arm</TableHead>
              <TableHead>Judge</TableHead>
              {EVAL_AXES.map((axis) => <TableHead key={axis}>{EVAL_AXIS_LABELS[axis]}</TableHead>)}
              <TableHead>Did better</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scored.map((row) => (
              <TableRow key={`${row.arm}-${row.judge}`}>
                <TableCell className="font-medium">{armLabel(row.arm, entry)}</TableCell>
                <TableCell>{row.judge}</TableCell>
                {EVAL_AXES.map((axis) => (
                  <TableCell key={axis} className="tabular-nums">
                    {row.scores[axis] ?? "—"}
                    {contestedFor(entry, row.arm, axis) && <Flag aria-label="contested" className="ml-1 inline size-3 text-status-warn" />}
                  </TableCell>
                ))}
                <TableCell className="max-w-md text-xs">{row.better}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {entry.contested.length === 0 && entry.contestedRule !== null && (
        <p className="text-xs text-muted-foreground">Nothing contested by {entry.contestedRule}.</p>
      )}
      {entry.contested.length > 0 && (
        <p className="text-xs text-status-warn">
          Contested by {entry.contestedRule} — read the diffs:{" "}
          {entry.contested.map((contested) => `${EVAL_AXIS_LABELS[contested.axis]} (${contested.arms.map((arm) => armLabel(arm, entry)).join(" vs ")})`).join("; ")}
        </p>
      )}
      {entry.judges.filter((judge) => judge.status === "unavailable").map((judge) => (
        <p key={judge.name} className="text-xs text-muted-foreground">{judge.name} abstained: {judge.reason}</p>
      ))}
      {entry.arms.length >= 2 && <DisagreeAction entry={entry} caseId={run.source.kind !== "set" && setRows === null ? undefined : calibrationCaseId(run, entry, setRows ?? [])} />}
    </div>
  );
}

function RunCard({ run, project, relayPatches, setRows, onChanged }: { run: EvalRunView; project: string | null; relayPatches: boolean; setRows: readonly EvalSetRowView[] | null; onChanged: () => void }) {
  const stop = useCommand("/api/evals/stop");
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const status = runStatus(run);
  const configLabel = runConfigLabel(run);
  const plot = qualityCostPlot(run);
  const grades = runHasGrades(run);
  const stopRun = async (): Promise<void> => {
    const result = await stop.send<EvalStopResult>({ run: run.dir });
    onChanged();
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value !== null && !result.value.stopped) setNotice(<span>{result.value.why ?? "Not stopped."}</span>);
  };
  return (
    // The anchor a proposal's run link scrolls to (#874): proposals name runs by id.
    <Collapsible id={`eval-run-${run.id}`} defaultOpen={run.running}>
      <Card className="gap-3 py-4 shadow-none">
        <CardHeader className="px-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <CollapsibleTrigger className="text-left text-sm font-medium hover:underline">{sourceLabel(run)}</CollapsibleTrigger>
            <Badge variant="outline" className="text-[10px]">{run.kind}</Badge>
            <span className={cn("text-xs", TONE[status.tone])}>{status.label}</span>
            <span className="text-xs text-muted-foreground" title={run.startedAt}>{run.startedAt.slice(0, 16).replace("T", " ")}</span>
            <span className="text-xs text-muted-foreground">{run.arms.map((arm) => arm.name).join(" · ")}</span>
            {run.running && (
              <Button variant="outline" size="xs" className="ml-auto" disabled={stop.disabled || stop.pending} title={stop.why ?? "Stop after killing the current trial; starting the same plan again resumes it."} onClick={() => void stopRun()}>
                {stop.queued ? "Waiting…" : "Stop"}
              </Button>
            )}
          </div>
          {configLabel !== null && <div className="text-xs text-muted-foreground">{configLabel}</div>}
          {run.source.kind === "set" && (
            <div className="text-xs text-muted-foreground">
              Set <span className="font-mono">{setShortVersion(run.source.version)}</span>
              {run.source.unrunnable.length > 0 && (
                <ul className="mt-1 text-status-warn">
                  {run.source.unrunnable.map((entry) => <li key={entry.id}>Unrunnable: <span className="font-mono">{entry.id}</span> — {entry.reason}</li>)}
                </ul>
              )}
            </div>
          )}
          {notice !== null && <div className="text-xs">{notice}</div>}
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="space-y-5 px-5">
            {run.problem !== null && <Quiet>{run.problem}</Quiet>}
            {run.totals.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Arm</TableHead>
                    <TableHead>Runs</TableHead>
                    <TableHead>Green</TableHead>
                    <TableHead>Panel wins</TableHead>
                    <TableHead>Held-out</TableHead>
                    <TableHead>Median time</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Cost</TableHead>
                    {grades && <TableHead>Objective</TableHead>}
                    {grades && <TableHead>Judge score</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.totals.map((total) => {
                    const arm = run.arms.find((entry) => entry.name === total.arm);
                    const models = modelsLabel(armResolutionFor(run, total.arm));
                    return (
                      <TableRow key={total.arm}>
                        <TableCell title={models ?? undefined}>
                          <span className="font-medium">{total.arm}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{arm?.lineup ?? ""}{arm?.overlay ? " + overlay" : ""}</span>
                          {models !== null && <div className="text-xs text-muted-foreground">{models}</div>}
                        </TableCell>
                        <TableCell className="tabular-nums">{total.ran}</TableCell>
                        <TableCell className="tabular-nums">{total.green}/{total.ran}</TableCell>
                        <TableCell className="tabular-nums">{total.judged === 0 ? "—" : `${total.wins}/${total.judged}`}</TableCell>
                        <TableCell className="tabular-nums">{total.heldOut ?? "—"}</TableCell>
                        <TableCell className="tabular-nums">{durationLabel(total.medianWallSeconds)}</TableCell>
                        <TableCell className="tabular-nums">{tokensLabel(total.tokens)}</TableCell>
                        <TableCell className="tabular-nums">{costLabel(total.costUsd, total.costPartial)}</TableCell>
                        {grades && <TableCell className="tabular-nums">{objectiveTotalLabel(total.objective)}</TableCell>}
                        {grades && <TableCell className="tabular-nums">{judgeTotalLabel(total.judge)}</TableCell>}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {/* != null: a snapshot from a host before #859 has neither field. */}
            {run.noiseFloor != null && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Noise-floor measurement</p>
                <p className={cn("text-xs", run.noiseFloor.stored ? "text-muted-foreground" : !run.running && "text-status-warn")}>{floorRunLabel(run.noiseFloor, run.running)}</p>
              </div>
            )}
            {run.noise != null && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Against the noise floor</p>
                <p className={cn("text-xs", run.noise.state === "fresh" ? "text-muted-foreground" : "text-status-warn")}>{noiseStatusLabel(run.noise, true)}</p>
                {run.noise.gaps.length > 0 && (
                  <ul className="space-y-0.5 text-xs tabular-nums">
                    {run.noise.gaps.map((gap) => <li key={`${gap.arm}-${gap.vs}`}>{armGapLabel(gap)}</li>)}
                  </ul>
                )}
              </div>
            )}
            {/* != null: a snapshot from a host before #871 has no verdict. */}
            {run.guardrails != null && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Guardrails</p>
                <p className="text-xs text-muted-foreground">{run.guardrails.proposal} against the baseline {run.guardrails.baseline}</p>
                {run.guardrails.goals.map((goal) => (
                  <div key={goal.goal} className="space-y-0.5">
                    <p className={cn("text-xs font-medium", goal.pass ? "text-status-good" : "text-status-warn")}>{goalVerdictLabel(goal)}</p>
                    <ul className="space-y-0.5 text-xs tabular-nums">
                      {goal.conditions.map((condition) => (
                        <li key={condition.id} className={cn(!condition.pass && "text-status-warn")}>{guardrailConditionLabel(condition)}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {/* != null: a snapshot from a host before #877 has no judge accuracy. */}
            {run.judgeAccuracy != null && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Judge accuracy</p>
                <p className="text-xs font-medium tabular-nums">{judgeAccuracyHeadline(run.judgeAccuracy)}</p>
                {accuracyAxisLines(run.judgeAccuracy).length > 0 && (
                  <ul className="space-y-0.5 text-xs tabular-nums">
                    {accuracyAxisLines(run.judgeAccuracy).map((line) => <li key={line}>{line}</li>)}
                  </ul>
                )}
                {contestedExcludedLabel(run.judgeAccuracy.contested) !== null && (
                  <p className="text-xs text-muted-foreground">{contestedExcludedLabel(run.judgeAccuracy.contested)}</p>
                )}
              </div>
            )}
            {plot !== null && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quality vs cost</p>
                <QualityCostChart plot={plot} />
              </div>
            )}
            {run.cases.length === 0 && !run.running && run.problem === null && <Quiet>No case finished.</Quiet>}
            {run.cases.map((entry) => <CaseBlock key={entry.key} run={run} entry={entry} project={project} relayPatches={relayPatches} setRows={setRows} />)}
            {run.repeated.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Repeats</p>
                <p className="text-xs text-muted-foreground">
                  The arms disagreed on these cases, or the panel contested them, so each ran again and every run was scored and judged.
                  Axis scores are the mean over the arm's runs, lowest and highest in brackets. The verdict above stays the first trial's.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Case</TableHead>
                      <TableHead>Arm</TableHead>
                      <TableHead>Green</TableHead>
                      <TableHead>Judged</TableHead>
                      {EVAL_AXES.map((axis) => <TableHead key={axis}>{EVAL_AXIS_LABELS[axis]}</TableHead>)}
                      <TableHead>First trial</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {run.repeated.map((entry) => (
                      <TableRow key={`${entry.case}-${entry.arm}`}>
                        <TableCell>{entry.case}</TableCell>
                        <TableCell className="font-medium">{entry.arm}</TableCell>
                        <TableCell className="tabular-nums">{entry.ran === 0 ? "—" : `${entry.green}/${entry.ran}`}</TableCell>
                        <TableCell className="tabular-nums">{entry.judged ?? "—"}</TableCell>
                        {EVAL_AXES.map((axis) => <TableCell key={axis} className="tabular-nums">{spreadLabel((entry.axes as EvalRepeatView["axes"] | undefined)?.[axis])}</TableCell>)}
                        <TableCell className="text-xs">{firstTrialLabel(entry)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {run.analysis !== null && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Analyst</p>
                {run.analysis.status === "unavailable" ? (
                  <Quiet>Not analysed: {run.analysis.reason}</Quiet>
                ) : (
                  <>
                    <p className="text-sm">{run.analysis.summary}</p>
                    {run.analysis.improvements.length === 0 ? (
                      <Quiet>No improvement the evidence supports.</Quiet>
                    ) : (
                      <ul className="list-disc space-y-1 pl-5 text-sm">
                        {run.analysis.improvements.map((entry, index) => (
                          <li key={index}>
                            <Badge variant="outline" className="mr-2 text-[10px]">{entry.knob}{entry.target ? ` · ${entry.target}` : ""}</Badge>
                            {entry.change} <span className="text-xs text-muted-foreground">(arm {entry.arm}; {entry.evidence.join(", ")})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-xs text-muted-foreground">The analyst knew which arm ran what; the judges did not. Try an improvement as another arm.</p>
                    {!run.running && run.source.kind === "set" && run.analysis.improvements.length > 0 && <ProposeImprovement run={run.dir} />}
                  </>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/**
 * Propose improvement (#873): the improver reads this run's allowed material
 * and puts one proposal's recommended run in the Inbox. It runs in the
 * background, so the answer here is only that it started.
 */
function ProposeImprovement({ run }: { run: string }) {
  const propose = useCommand("/api/evals/improve/propose");
  const [goal, setGoal] = useState<"quality" | "cost">("quality");
  const [notice, setNotice] = useState<React.ReactNode>(null);
  const send = async (): Promise<void> => {
    const result = await propose.send<EvalImproveResult>({ run, goal });
    if (!result.ok) setNotice(<CommandNotice error={result.error} />);
    else if (result.value === null) setNotice(<span>Waiting for the machine…</span>);
    else if (!result.value.ok) setNotice(<span className="text-status-warn">{result.value.why}</span>);
    else setNotice(<span>The improver started; its proposal's recommended run will wait in the Inbox.</span>);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <Select value={goal} onValueChange={(value) => setGoal(value as "quality" | "cost")}>
        <SelectTrigger size="sm" aria-label="Goal" className="w-32"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="quality">Quality</SelectItem>
          <SelectItem value="cost">Cost</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="xs" disabled={propose.disabled || propose.pending} title={propose.why ?? "One improver session proposes a change toward the goal; nothing runs until you start it from the Inbox."} onClick={() => void send()}>
        {propose.queued ? "Waiting for the machine…" : propose.pending ? "Starting…" : "Propose improvement"}
      </Button>
      {notice !== null && <span className="text-xs">{notice}</span>}
    </div>
  );
}

/** How many frames a run link waits for the Runs screen to mount and draw the run's card. */
const OPEN_RUN_FRAMES = 30;

/** The Evals tab: Runs (the default), the Test set they sample (#856), the merged PRs suggested for it (#858), the recommended runs waiting in the Inbox (#872), and the improver's Proposals (#874). */
export function EvalsPage() {
  // Controlled, so a proposal's run link can switch to Runs (#874).
  const [tab, setTab] = useState("runs");
  const openRun = (id: string): void => {
    setTab("runs");
    // The Runs screen mounts on the switch and its read may still be loading,
    // so look for the card frame by frame and give up quietly if it never draws.
    let frames = 0;
    const look = (): void => {
      const card = document.getElementById(`eval-run-${id}`);
      if (card !== null) card.scrollIntoView({ behavior: "smooth", block: "start" });
      else if (++frames < OPEN_RUN_FRAMES) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };
  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <TabsList variant="line" className="h-auto flex-wrap justify-start gap-1 p-0" aria-label="Evals screen">
        <TabsTrigger value="runs" className="h-7 flex-none px-2.5">Runs</TabsTrigger>
        <TabsTrigger value="set" className="h-7 flex-none px-2.5">Test set</TabsTrigger>
        <TabsTrigger value="suggestions" className="h-7 flex-none px-2.5">Suggestions</TabsTrigger>
        <TabsTrigger value="inbox" className="h-7 flex-none px-2.5">Inbox</TabsTrigger>
        <TabsTrigger value="proposals" className="h-7 flex-none px-2.5">Proposals</TabsTrigger>
      </TabsList>
      <TabsContent value="runs">
        <RunsScreen />
      </TabsContent>
      <TabsContent value="set">
        <EvalSetScreen />
      </TabsContent>
      <TabsContent value="suggestions">
        <EvalSuggestionsScreen />
      </TabsContent>
      <TabsContent value="inbox">
        <EvalInboxScreen />
      </TabsContent>
      <TabsContent value="proposals">
        <EvalProposalsScreen onOpenRun={openRun} />
      </TabsContent>
    </Tabs>
  );
}

function RunsScreen() {
  const { read, refresh } = useEvals();
  const { read: setRead } = useEvalSet();
  const project = screenProject();
  // A set read that failed with nothing cached shows as the set's problem, so
  // the form says why it refuses instead of waiting on a read that is over.
  const setView: EvalSetView | null = setRead.state === "loading"
    ? null
    : setRead.data ?? { version: null, details: false, cases: [], noiseFloor: NO_NOISE_FLOOR, calibrationSuggestions: [], problem: setRead.state === "error" ? setRead.message : null };
  const view = read.state === "loading" ? null : read.data;
  if (read.state === "loading") return <Skeleton className="h-64" />;
  return (
    <div className="space-y-4">
      {view?.problem && (
        <Alert className="bg-transparent">
          <CircleAlert className="text-status-warn" />
          <AlertTitle>The project's eval runs could not be read</AlertTitle>
          <AlertDescription><p className="font-mono text-xs break-all">{view.problem}</p></AlertDescription>
        </Alert>
      )}
      {read.state === "error" && view === null && <Quiet>{read.message}</Quiet>}
      <RunFormCard key={view === null ? "empty" : "read"} view={view} setView={setView} project={project} onStarted={refresh} />
      {(view?.runs ?? []).length === 0 ? (
        <Quiet>No eval run yet.</Quiet>
      ) : (
        view!.runs.map((run) => <RunCard key={run.dir} run={run} project={project} relayPatches={view!.relayPatches} setRows={setView !== null && setView.problem === null ? setView.cases : null} onChanged={refresh} />)
      )}
    </div>
  );
}
