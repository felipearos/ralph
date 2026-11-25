/**
 * The project's settings page, opened from the sidebar's foot (#689).
 *
 * It opens with a read-only overview over `GET /api/settings` — the project's
 * config, where its checkout and worktrees live, and how each worktree is
 * used — drawn from `settings-model.ts`. Under it, when the config reads, an
 * Edit form proposes a new display name or base branch through
 * `POST /api/settings/project` (#691): a save opens a PR, so nothing changes
 * until it merges. Below that, Agent worktrees sets the folder new agent
 * worktrees are created in through `POST /api/settings/worktrees` (#693); it
 * needs only the settings to read, not the config. Removing the project sits
 * below it in every state, so a project whose config or checkout cannot be
 * read can still be removed.
 *
 * Gates (#690) lists the config's gate commands, required CI checks and
 * refused files; Run starts one saved gate in the main checkout over
 * `POST /api/settings/gates/run` and the page polls `GET` for its outcome, on
 * the local page only. Under the list, a form proposes new gates, required
 * checks and refused files as one config PR over `POST /api/settings/project`
 * (#692), as Edit does. Worktree setup (#694) lists the steps a new agent
 * worktree runs after `git worktree add`, and proposes new ones the same way.
 *
 * Prompts (#695) shows what an agent of this project reads, over the relayed
 * `GET /api/settings/prompts`: each fragment the config names, as source, and
 * one role's rendered prompt, chosen among the roster's roles.
 */
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, ExternalLink, TriangleAlert } from "lucide-react";

import type {
  CleanUpWorktreesResult,
  GateRunAnswer,
  GateRunView,
  ProjectSettingsView,
  ProposeProjectResult,
  SetWorktreesResult,
  WorktreeSetupStepConfig,
} from "../contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Answer, Confirming, RemoveProject, shown, type Said } from "./agents";
import { ClaudeAccounts } from "./claude-accounts";
import { isRemote } from "./api";
import { CommandNotice, LocalOnlyNote, useCommand } from "./command";
import type { CommandError } from "./command-model";
import { GATE_RUN_POLL_MS, gateRunAvailability, gateRunResult, keepPolling, type GateRunResult } from "./gate-run-model";
import { gateRunUrl } from "./reads";
import {
  gatesEditFromForm,
  gatesEditProblems,
  gatesFormFromView,
  projectEditFromForm,
  projectEditProblems,
  projectFormFromView,
  projectSaveNotice,
  SETUP_MAX_SECONDS,
  setupEditFromForm,
  setupEditProblems,
  setupFormFromView,
  setupTotalSeconds,
  worktreesEditFromForm,
  worktreesFolderProblems,
  worktreesFormFromView,
  worktreesSaveNotice,
  type GatesForm,
  type ProjectForm,
  type ProjectSaveNotice,
  type SetupForm,
} from "./settings-form-model";
import { promptsModel, type PromptBody } from "./prompts-model";
import { settingsModel, type SettingsField, type SettingsGate, type SettingsModel } from "./settings-model";
import { Absent, Dot, TONE_TEXT } from "./shell-parts";
import { useProjectPrompts, useProjectSettings } from "./use-reads";
import { cleanUpCandidates, cleanUpConfirmLabel, cleanUpOutcome, cleanUpWhy, type CleanUpOutcome } from "./worktree-cleanup-model";

export function ProjectSettings({ project }: { project: string }) {
  return (
    <section className="space-y-6" aria-label="Project settings">
      <Overview project={project} />
      <Edit project={project} />
      <ClaudeAccounts project={project} />
      <Gates project={project} />
      <Prompts project={project} />
      <WorktreeSetup project={project} />
      <Worktrees project={project} />
      <div className="space-y-4">
        <h2 className="text-sm font-semibold">Danger zone</h2>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Clean up worktrees</h3>
          <CleanUpWorktrees project={project} />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Remove project</h3>
          <RemoveProject project={project} />
        </div>
      </div>
    </section>
  );
}

/**
 * Prunes git's registration of worktrees whose directory is gone (#696): a
 * stale registration makes `git worktree add` refuse that path. The server
 * re-checks each path and skips an orphaned (locked) worktree or one a loop
 * runs in, so the outcome lists what it skipped and why.
 */
function CleanUpWorktrees({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const view = settings.read.state === "loading" ? null : settings.read.data;
  const candidates = cleanUpCandidates(view);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Said | null>(null);
  const [outcome, setOutcome] = useState<CleanUpOutcome | null>(null);
  const command = useCommand("/api/settings/worktrees/cleanup");
  const why = cleanUpWhy(command.why, candidates.length);
  return (
    <section className="space-y-2" aria-label="Clean up worktrees">
      <p className="text-sm text-muted-foreground">
        Remove git's registration of worktrees whose directory is gone: they block <span className="font-mono">git worktree add</span> at that path. An
        orphaned (locked) worktree and a worktree a loop runs in are never touched. A checkout on a volume that is not
        mounted reads as gone too: lock it (<span className="font-mono">git worktree lock</span>) to keep it.
      </p>
      <Confirming
        label="Clean up worktrees…"
        confirm={cleanUpConfirmLabel(candidates.length)}
        busy={busy}
        unavailable={command.disabled || candidates.length === 0}
        why={why}
        armedDetails={<WorktreeList title="These registrations will be pruned:" entries={candidates} />}
        onConfirm={async () => {
          setBusy(true);
          setFailure(null);
          setOutcome(null);
          const paths = candidates.map((candidate) => candidate.path);
          const result = await command.send<CleanUpWorktreesResult>({ paths, confirm: true });
          setBusy(false);
          if (!result.ok) {
            setFailure(shown(result.error));
            return;
          }
          if (result.value !== null) setOutcome(cleanUpOutcome(result.value, paths));
          settings.reload();
        }}
      />
      <LocalOnlyNote route="/api/settings/worktrees/cleanup" />
      {failure && <Answer notice={failure} />}
      {outcome && (
        <div className="space-y-2">
          <Answer notice={outcome.notice} />
          {outcome.pruned.length > 0 && <WorktreeList title="Pruned:" entries={outcome.pruned} />}
          {outcome.skipped.length > 0 && <WorktreeList title="Skipped:" entries={outcome.skipped} />}
        </div>
      )}
    </section>
  );
}

function WorktreeList({ title, entries }: { title: string; entries: { path: string; branch: string | null; reason?: string }[] }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {entries.map((entry) => (
          <li key={entry.path}>
            <span className="font-mono">{entry.path}</span>
            {entry.branch !== null && <span className="text-muted-foreground"> ({entry.branch})</span>}
            {entry.reason !== undefined && <span className="text-muted-foreground">: {entry.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Overview({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const read = settings.read;
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Overview</h2>
      {read.state === "loading" ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : read.state === "error" && read.data === null ? (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>The settings could not be read</AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-wrap">{read.message}</p>
          </AlertDescription>
        </Alert>
      ) : read.data === null ? null : (
        <OverviewBody model={settingsModel(read.data)} />
      )}
    </div>
  );
}

/** Read-only: a fragment changes by a PR to the project, not from here. */
function Prompts({ project }: { project: string }) {
  const prompts = useProjectPrompts(project);
  const read = prompts.read;
  const [role, setRole] = useState<string | null>(null);
  const model = read.state === "loading" || read.data === null ? null : promptsModel(read.data, role);
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Prompts</h2>
      {read.state === "loading" ? (
        <div className="space-y-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : read.state === "error" && read.data === null ? (
        <Alert variant="destructive" className="bg-transparent">
          <CircleAlert />
          <AlertTitle>The prompts could not be read</AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-wrap">{read.message}</p>
          </AlertDescription>
        </Alert>
      ) : model === null ? null : (
        <>
          {model.problems.length > 0 && (
            <Alert className="bg-transparent">
              <TriangleAlert className={TONE_TEXT.warn} />
              <AlertTitle>The prompts have problems</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {model.problems.map((problem, at) => (
                    <li key={`${at}:${problem}`} className="whitespace-pre-wrap">
                      {problem}
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Fragments</h3>
            {model.fragments.length === 0 ? (
              <p className="text-xs text-muted-foreground">The config names no prompt fragments.</p>
            ) : (
              model.fragments.map((fragment) => (
                <PromptSource key={`${fragment.label}:${fragment.path}`} title={fragment.label} path={fragment.path} body={fragment.body} />
              ))
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Rendered prompt</h3>
            {model.chosen === null ? (
              <p className="text-xs text-muted-foreground">No role to render: the roster names no loops.</p>
            ) : (
              <>
                <Tabs value={model.chosen.id} onValueChange={setRole}>
                  <TabsList variant="line" className="h-auto flex-wrap justify-start gap-1 p-0" aria-label="Render the prompt of">
                    {model.options.map((option) => (
                      <TabsTrigger key={option.id} value={option.id} className="h-7 flex-none px-2.5">
                        {option.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <PromptSource title={model.chosen.label} path={null} body={model.chosen.body} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** A fragment or render as Markdown source: there is no renderer here, and the source is what the agent reads. */
function PromptSource({ title, path, body }: { title: string; path: string | null; body: PromptBody }) {
  const heading = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-medium">{title}</span>
      {path !== null && <span className="font-mono text-muted-foreground">{path}</span>}
    </span>
  );
  if (body.kind !== "text") {
    return (
      <div className="rounded-md border px-3 py-2 text-xs">
        {heading}
        {body.kind === "missing" ? (
          <p className={cn("mt-1 font-medium", TONE_TEXT.bad)}>missing: the config names this file, but it does not exist</p>
        ) : (
          <p className={cn("mt-1 whitespace-pre-wrap", TONE_TEXT.bad)}>{body.text}</p>
        )}
      </div>
    );
  }
  return (
    <details className="rounded-md border text-xs">
      <summary className="cursor-pointer px-3 py-2">{heading}</summary>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t px-3 py-2 font-mono">{body.text}</pre>
    </details>
  );
}

/** Only a config that reads can be edited: an invalid one is fixed on the base branch, not here. */
function Edit({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const view = settings.read.state === "loading" ? null : settings.read.data;
  if (view === null || view.config === null) return null;
  return <EditProject view={view} reload={settings.reload} />;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "done"; notice: ProjectSaveNotice } | { kind: "refused"; error: CommandError };

function EditProject({ view, reload }: { view: ProjectSettingsView; reload: () => void }) {
  const [draft, setDraft] = useState<ProjectForm>(() => projectFormFromView(view));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const proposing = useCommand("/api/settings/project");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    setDraft(projectFormFromView(view));
  }, [view]);

  const edit = projectEditFromForm(draft, view);
  const problems = projectEditProblems(draft, view);
  const change = (next: ProjectForm) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };

  const commit = async () => {
    if (edit === null || problems.length > 0) return;
    setSave({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeProjectResult>>(edit);
    // A refusal sets no new snapshot, so the draft stays as typed.
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not proposed: the proposal answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: projectSaveNotice(body as ProposeProjectResult) });
    // The overview still shows the base branch's config until the PR merges;
    // re-reading keeps the page on what a loop reads now.
    if (body.outcome !== "refused") reload();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Edit</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="settings-display-name">Display name</Label>
          <Input
            id="settings-display-name"
            value={draft.displayName}
            // Disabled with Save on the remote page, so the whole form reads as unavailable there.
            disabled={proposing.disabled}
            placeholder={view.project}
            onChange={(event) => change({ ...draft, displayName: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-base-branch">Base branch</Label>
          <Input
            id="settings-base-branch"
            className="font-mono"
            value={draft.baseBranch}
            disabled={proposing.disabled}
            onChange={(event) => change({ ...draft, baseBranch: event.target.value })}
          />
        </div>
      </div>
      {problems.length > 0 && (
        <ul className={cn("list-disc space-y-0.5 pl-4 text-xs", TONE_TEXT.bad)}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Save opens a PR against <span className="font-mono">{view.config?.baseBranch}</span>. The change applies once the PR is merged and the loops are restarted.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={edit === null || problems.length > 0 || save.kind === "saving" || proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? "Proposing…" : "Save"}
        </Button>
        <LocalOnlyNote route="/api/settings/project" />
        {save.kind === "done" && (
          <span className={cn("text-xs", TONE_TEXT[save.notice.tone])}>
            {save.notice.text}{" "}
            {save.notice.url && (
              <a className="inline-flex items-center gap-1 underline" href={save.notice.url} target="_blank" rel="noreferrer">
                Open the PR
                <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        )}
        {save.kind === "refused" && (
          // A div, not a span: the refusal's problems are a list.
          <div className={cn("text-xs", TONE_TEXT.bad)}>
            Not proposed: <CommandNotice error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown with the config: the gates are the config's, so an invalid one has none to list. */
function Gates({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const view = settings.read.state === "loading" ? null : settings.read.data;
  if (view === null || view.config === null) return null;
  const model = settingsModel(view);
  return (
    <div className="space-y-4">
      <GatesBody project={project} gates={model.gates ?? []} requiredChecks={model.requiredChecks ?? []} refuseFiles={model.refuseFiles ?? []} />
      <EditGates view={view} reload={settings.reload} />
    </div>
  );
}

/**
 * The project's latest run, read once on open (a run started earlier or from
 * another tab shows) and again every couple of seconds while it is in flight.
 * Never on the remote page: the route is local-only there and answers 403.
 */
function useGateRun(project: string) {
  const [run, setRun] = useState<GateRunView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const remote = isRemote();

  const read = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(gateRunUrl(project), { signal, cache: "no-store" });
        if (!response.ok) {
          setProblem(`The last run could not be read (HTTP ${response.status})`);
          return;
        }
        const body = (await response.json()) as Partial<GateRunAnswer> | null;
        setRun(body?.run ?? null);
        setProblem(null);
      } catch (error) {
        // An unmount aborts the read; that is not a problem worth showing.
        if (signal.aborted) return;
        setProblem(`The last run could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [project],
  );

  useEffect(() => {
    if (remote) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [remote, read]);

  const polling = !remote && keepPolling(run);
  useEffect(() => {
    if (!polling) return;
    const controller = new AbortController();
    const timer = setInterval(() => void read(controller.signal), GATE_RUN_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [polling, read]);

  // A read outside the poll, for a refusal: the run that caused it is one this
  // page has not seen yet (another tab started it), and reading it starts the poll.
  const refresh = useCallback(() => {
    if (remote) return;
    void read(new AbortController().signal);
  }, [remote, read]);

  return { run, setRun, problem, refresh };
}

function GatesBody({
  project,
  gates,
  requiredChecks,
  refuseFiles,
}: {
  project: string;
  gates: SettingsGate[];
  requiredChecks: string[];
  refuseFiles: string[];
}) {
  const { run, setRun, problem, refresh } = useGateRun(project);
  const running = useCommand("/api/settings/gates/run");
  const [refusal, setRefusal] = useState<CommandError | null>(null);
  const offered = gateRunAvailability(run, running);

  const start = async (gate: string) => {
    setRefusal(null);
    const result = await running.send<Partial<GateRunAnswer>>({ gate });
    if (!result.ok) {
      if (result.error.kind !== "Aborted") setRefusal(result.error);
      refresh();
      return;
    }
    // The answer is the run as it started; the poll takes it from there.
    if (result.value?.run) setRun(result.value.run);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Gates</h2>
      {gates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No gates in the config.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Gate</TableHead>
              <TableHead>Command</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {gates.map((gate) => {
              const result = gateRunResult(run, gate.name);
              return (
                <TableRow key={gate.name} className="align-top">
                  <TableCell>{gate.name}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-pre-wrap break-all">{gate.command}</TableCell>
                  <TableCell className="min-w-0 max-w-xl whitespace-normal">
                    {result === null ? <Absent /> : <GateResult result={result} />}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Run ${gate.name}`}
                      disabled={offered.disabled}
                      title={offered.why ?? undefined}
                      onClick={() => void start(gate.name)}
                    >
                      Run
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <LocalOnlyNote route="/api/settings/gates/run" />
      {refusal !== null && (
        // A div, not a span: the refusal's problems are a list.
        <div className={cn("text-xs", TONE_TEXT.bad)}>
          Not started: <CommandNotice error={refusal} />
        </div>
      )}
      {problem !== null && <p className="text-xs text-muted-foreground">{problem}</p>}
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Required checks</h3>
        {requiredChecks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No required checks.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-sm">
            {requiredChecks.map((check) => (
              <li key={check} className="font-mono text-xs leading-5">
                {check}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Refused files</h3>
        {refuseFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No refused files.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-sm">
            {refuseFiles.map((path, index) => (
              // By position: the schema does not forbid a repeated path.
              <li key={`${index}:${path}`} className="font-mono text-xs leading-5">
                {path}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The Gates section's edit form (#692): every change in it goes out as one
 * config PR, so the gates, required checks and refused files a loop reads
 * change together when it merges. Run above keeps running the saved gates,
 * not this draft.
 */
function EditGates({ view, reload }: { view: ProjectSettingsView; reload: () => void }) {
  const [draft, setDraft] = useState<GatesForm>(() => gatesFormFromView(view));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const proposing = useCommand("/api/settings/project");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    setDraft(gatesFormFromView(view));
  }, [view]);

  const edit = gatesEditFromForm(draft, view);
  const problems = gatesEditProblems(draft, view);
  const change = (next: GatesForm) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };
  const changeGate = (index: number, next: Partial<GatesForm["gates"][number]>) =>
    change({ ...draft, gates: draft.gates.map((gate, at) => (at === index ? { ...gate, ...next } : gate)) });

  const commit = async () => {
    if (edit === null || problems.length > 0) return;
    setSave({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeProjectResult>>(edit);
    // A refusal sets no new snapshot, so the draft stays as typed.
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not proposed: the proposal answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: projectSaveNotice(body as ProposeProjectResult) });
    // The list above still shows the base branch's config until the PR merges;
    // re-reading keeps the page on what a loop reads now.
    if (body.outcome !== "refused") reload();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-muted-foreground">Propose a change</h3>
      <div className="space-y-2">
        {draft.gates.map((gate, index) => (
          // By position: a row has no identity of its own while its name is being typed.
          <div key={index} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <Input
              aria-label={`Gate ${index + 1} name`}
              value={gate.name}
              // Disabled with Save on the remote page, so the whole form reads as unavailable there.
              disabled={proposing.disabled}
              placeholder="name"
              onChange={(event) => changeGate(index, { name: event.target.value })}
            />
            <Input
              aria-label={`Gate ${index + 1} command`}
              className="font-mono"
              value={gate.command}
              disabled={proposing.disabled}
              placeholder="command"
              onChange={(event) => changeGate(index, { command: event.target.value })}
            />
            <Button
              size="sm"
              variant="outline"
              aria-label={`Remove gate ${gate.name.trim() === "" ? index + 1 : gate.name}`}
              disabled={proposing.disabled}
              title={proposing.why ?? undefined}
              onClick={() => change({ ...draft, gates: draft.gates.filter((_, at) => at !== index) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={() => change({ ...draft, gates: [...draft.gates, { name: "", command: "" }] })}
        >
          Add gate
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="settings-required-checks">Required checks</Label>
          <Textarea
            id="settings-required-checks"
            className="font-mono"
            rows={3}
            value={draft.requiredChecks}
            disabled={proposing.disabled}
            placeholder="One check name per line"
            onChange={(event) => change({ ...draft, requiredChecks: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-refuse-files">Refused files</Label>
          <Textarea
            id="settings-refuse-files"
            className="font-mono"
            rows={3}
            value={draft.refuseFiles}
            disabled={proposing.disabled}
            placeholder="One path per line"
            onChange={(event) => change({ ...draft, refuseFiles: event.target.value })}
          />
        </div>
      </div>
      {problems.length > 0 && (
        <ul className={cn("list-disc space-y-0.5 pl-4 text-xs", TONE_TEXT.bad)}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Save opens one PR against <span className="font-mono">{view.config?.baseBranch}</span> with every change above. It applies once the PR is merged and the loops are restarted.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label="Save gates"
          disabled={edit === null || problems.length > 0 || save.kind === "saving" || proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? "Proposing…" : "Save"}
        </Button>
        <LocalOnlyNote route="/api/settings/project" />
        {save.kind === "done" && (
          // pre-line: a refusal lists every problem on its own line, and they must read as a list.
          <span className={cn("whitespace-pre-line text-xs", TONE_TEXT[save.notice.tone])}>
            {save.notice.text}{" "}
            {save.notice.url && (
              <a className="inline-flex items-center gap-1 underline" href={save.notice.url} target="_blank" rel="noreferrer">
                Open the PR
                <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        )}
        {save.kind === "refused" && (
          // A div, not a span: the refusal's problems are a list.
          <div className={cn("text-xs", TONE_TEXT.bad)}>
            Not proposed: <CommandNotice error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown with the config, as Gates is: the steps are the config's, so an invalid one has none to list. */
function WorktreeSetup({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const view = settings.read.state === "loading" ? null : settings.read.data;
  if (view === null || view.config === null) return null;
  const model = settingsModel(view);
  return (
    <div className="space-y-4">
      <WorktreeSetupBody steps={model.worktreeSetup ?? []} />
      <EditWorktreeSetup view={view} reload={settings.reload} />
    </div>
  );
}

function WorktreeSetupBody({ steps }: { steps: WorktreeSetupStepConfig[] }) {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Worktree setup</h2>
      <p className="text-xs text-muted-foreground">
        The steps run in order in a new agent worktree, right after <span className="font-mono">git worktree add</span>. A failing step stops the
        rest and keeps the worktree. <span className="font-mono">$RALPH_MAIN_CHECKOUT</span> names the main checkout, e.g. to copy an env file
        from it. Saving opens a config PR.
      </p>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No setup steps: a new worktree is used as <span className="font-mono">git worktree add</span> leaves it.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-0">#</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Command</TableHead>
              <TableHead>Limit</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step, index) => (
              <TableRow key={step.name} className="align-top">
                <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-mono text-xs">{step.name}</TableCell>
                <TableCell className="font-mono text-xs whitespace-pre-wrap break-all">{step.command}</TableCell>
                <TableCell className="text-xs">{step.timeoutSeconds} s</TableCell>
                <TableCell className="text-xs text-muted-foreground">{step.installsDependencies ? "installs dependencies" : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * The Worktree setup section's edit form (#694): the whole list goes out as
 * one config PR, as the Gates form's edits do, and the steps run in the order
 * the rows stand in.
 */
function EditWorktreeSetup({ view, reload }: { view: ProjectSettingsView; reload: () => void }) {
  const [draft, setDraft] = useState<SetupForm>(() => setupFormFromView(view));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const proposing = useCommand("/api/settings/project");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    setDraft(setupFormFromView(view));
  }, [view]);

  const edit = setupEditFromForm(draft, view);
  const problems = setupEditProblems(draft, view);
  const total = setupTotalSeconds(draft);
  const change = (steps: SetupForm["steps"]) => {
    setDraft({ steps });
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };
  const changeStep = (index: number, next: Partial<SetupForm["steps"][number]>) =>
    change(draft.steps.map((step, at) => (at === index ? { ...step, ...next } : step)));
  const move = (index: number, by: -1 | 1) => {
    const steps = [...draft.steps];
    const [step] = steps.splice(index, 1);
    if (step === undefined) return;
    steps.splice(index + by, 0, step);
    change(steps);
  };
  const label = (step: SetupForm["steps"][number], index: number) => (step.name.trim() === "" ? String(index + 1) : step.name);

  const commit = async () => {
    if (edit === null || problems.length > 0) return;
    setSave({ kind: "saving" });
    const result = await proposing.send<Partial<ProposeProjectResult>>(edit);
    // A refusal sets no new snapshot, so the draft stays as typed.
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const body = result.value;
    if (body === null || body.outcome === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not proposed: the proposal answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: projectSaveNotice(body as ProposeProjectResult) });
    // The list above still shows the base branch's config until the PR merges.
    if (body.outcome !== "refused") reload();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-xs font-medium text-muted-foreground">Propose a change</h3>
      <div className="space-y-2">
        {draft.steps.map((step, index) => (
          // By position: a row has no identity of its own while its name is being typed.
          <div key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_6rem_auto_auto] sm:items-center">
            <Input
              aria-label={`Step ${index + 1} name`}
              value={step.name}
              // Disabled with Save on the remote page, so the whole form reads as unavailable there.
              disabled={proposing.disabled}
              placeholder="name"
              onChange={(event) => changeStep(index, { name: event.target.value })}
            />
            <Input
              aria-label={`Step ${index + 1} command`}
              className="font-mono"
              value={step.command}
              disabled={proposing.disabled}
              placeholder="command"
              onChange={(event) => changeStep(index, { command: event.target.value })}
            />
            <Input
              aria-label={`Step ${index + 1} timeout seconds`}
              inputMode="numeric"
              value={step.timeoutSeconds}
              disabled={proposing.disabled}
              placeholder="120"
              onChange={(event) => changeStep(index, { timeoutSeconds: event.target.value })}
            />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                aria-label={`Step ${index + 1} installs dependencies`}
                checked={step.installsDependencies}
                disabled={proposing.disabled}
                onCheckedChange={(checked) => changeStep(index, { installsDependencies: checked === true })}
              />
              installs dependencies
            </label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                aria-label={`Move step ${label(step, index)} up`}
                disabled={proposing.disabled || index === 0}
                title={proposing.why ?? undefined}
                onClick={() => move(index, -1)}
              >
                Up
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Move step ${label(step, index)} down`}
                disabled={proposing.disabled || index === draft.steps.length - 1}
                title={proposing.why ?? undefined}
                onClick={() => move(index, 1)}
              >
                Down
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Remove step ${label(step, index)}`}
                disabled={proposing.disabled}
                title={proposing.why ?? undefined}
                onClick={() => change(draft.steps.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          disabled={proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={() => change([...draft.steps, { name: "", command: "", timeoutSeconds: "", installsDependencies: false }])}
        >
          Add step
        </Button>
      </div>
      <p className={cn("text-xs", total > SETUP_MAX_SECONDS ? TONE_TEXT.bad : "text-muted-foreground")}>
        {total} s of {SETUP_MAX_SECONDS} s
      </p>
      {problems.length > 0 && (
        <ul className={cn("list-disc space-y-0.5 pl-4 text-xs", TONE_TEXT.bad)}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Save opens one PR against <span className="font-mono">{view.config?.baseBranch}</span> with the steps above. No loop reads them: the dashboard reads them from the project's main checkout, so they apply to worktrees made after the PR is merged and the main checkout has pulled it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          aria-label="Save worktree setup"
          disabled={edit === null || problems.length > 0 || save.kind === "saving" || proposing.disabled}
          title={proposing.why ?? undefined}
          onClick={commit}
        >
          {save.kind === "saving" ? "Proposing…" : "Save"}
        </Button>
        <LocalOnlyNote route="/api/settings/project" />
        {save.kind === "done" && (
          // pre-line: a refusal lists every problem on its own line, and they must read as a list.
          <span className={cn("whitespace-pre-line text-xs", TONE_TEXT[save.notice.tone])}>
            {save.notice.text}{" "}
            {save.notice.url && (
              <a className="inline-flex items-center gap-1 underline" href={save.notice.url} target="_blank" rel="noreferrer">
                Open the PR
                <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        )}
        {save.kind === "refused" && (
          // A div, not a span: the refusal's problems are a list.
          <div className={cn("text-xs", TONE_TEXT.bad)}>
            Not proposed: <CommandNotice error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}

function GateResult({ result }: { result: GateRunResult }) {
  const facts = [result.exit, result.duration, `started ${result.started}`].filter((fact): fact is string => fact !== null);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={result.tone} />
          <span className={TONE_TEXT[result.tone]}>{result.label}</span>
        </span>
        <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>
      </div>
      {result.error !== null && <p className={cn("text-xs whitespace-pre-wrap", TONE_TEXT.bad)}>{result.error}</p>}
      {result.output !== "" && (
        <>
          {result.truncated && <p className="text-xs text-muted-foreground">(earlier lines cut)</p>}
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-4 whitespace-pre">
            {result.output}
          </pre>
        </>
      )}
    </div>
  );
}

/** Shown whenever the settings read: the folder lives in the registry, not in the config. */
function Worktrees({ project }: { project: string }) {
  const settings = useProjectSettings(project);
  const view = settings.read.state === "loading" ? null : settings.read.data;
  if (view === null) return null;
  return <WorktreesFolder view={view} reload={settings.reload} />;
}

function WorktreesFolder({ view, reload }: { view: ProjectSettingsView; reload: () => void }) {
  const [draft, setDraft] = useState<string>(() => worktreesFormFromView(view));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const setting = useCommand("/api/settings/worktrees");

  // Seeded per snapshot, not per render, so edits survive until a new read lands.
  useEffect(() => {
    setDraft(worktreesFormFromView(view));
  }, [view]);

  const edit = worktreesEditFromForm(draft, view);
  // Nothing typed over the folder in effect is nothing to check.
  const problems = edit === null ? [] : worktreesFolderProblems(draft);
  const change = (next: string) => {
    setDraft(next);
    if (save.kind !== "saving") setSave({ kind: "idle" });
  };

  const commit = async (body: { folder: string | null }) => {
    setSave({ kind: "saving" });
    const result = await setting.send<Partial<SetWorktreesResult>>(body);
    // A refusal sets no new snapshot, so the draft stays as typed.
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "refused", error: result.error });
      return;
    }
    const answer = result.value;
    if (answer === null || answer.worktreesDir === undefined) {
      setSave({ kind: "done", notice: { tone: "bad", text: "Not saved: the server answered nothing" } });
      return;
    }
    setSave({ kind: "done", notice: worktreesSaveNotice(answer as SetWorktreesResult) });
    reload();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">Agent worktrees</h2>
      <div className="space-y-1.5">
        <Label htmlFor="settings-worktrees-folder">Folder</Label>
        <Input
          id="settings-worktrees-folder"
          className="font-mono"
          value={draft}
          // Disabled with Save on the remote page, so the whole form reads as unavailable there.
          disabled={setting.disabled}
          placeholder={view.defaultWorktreesDir}
          onChange={(event) => change(event.target.value)}
        />
      </div>
      {problems.length > 0 && (
        <ul className={cn("list-disc space-y-0.5 pl-4 text-xs", TONE_TEXT.bad)}>
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        New agent worktrees are created here as <span className="font-mono">{"<agent>-loop"}</span>. Existing worktrees stay where they are; changing the
        folder only affects worktrees created after the change.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={edit === null || problems.length > 0 || save.kind === "saving" || setting.disabled}
          title={setting.why ?? undefined}
          onClick={() => {
            if (edit !== null && problems.length === 0) void commit(edit);
          }}
        >
          {save.kind === "saving" ? "Saving…" : "Save"}
        </Button>
        {!view.worktreesDefault && (
          <Button
            size="sm"
            variant="outline"
            disabled={save.kind === "saving" || setting.disabled}
            title={setting.why ?? undefined}
            onClick={() => void commit({ folder: null })}
          >
            Use default
          </Button>
        )}
        <LocalOnlyNote route="/api/settings/worktrees" />
        {save.kind === "done" && <span className={cn("text-xs", TONE_TEXT[save.notice.tone])}>{save.notice.text}</span>}
        {save.kind === "refused" && (
          // A div, not a span: the refusal's problems are a list.
          <div className={cn("text-xs", TONE_TEXT.bad)}>
            Not saved: <CommandNotice error={save.error} />
          </div>
        )}
      </div>
    </div>
  );
}

function Fields({ fields }: { fields: SettingsField[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className={cn("min-w-0 break-all", field.mono && "font-mono text-xs leading-5")}>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OverviewBody({ model }: { model: SettingsModel }) {
  return (
    <div className="space-y-4">
      {model.fields === null ? (
        <Alert className="bg-transparent">
          <TriangleAlert className={TONE_TEXT.warn} />
          <AlertTitle>The project config has problems</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {model.problems.map((problem, at) => (
                <li key={`${at}:${problem}`} className="whitespace-pre-wrap">
                  {problem}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <Fields fields={model.fields} />
      )}
      <Fields fields={model.location} />
      {model.rows === null ? (
        <Alert className="bg-transparent">
          <TriangleAlert className={TONE_TEXT.warn} />
          <AlertTitle>The worktrees could not be listed</AlertTitle>
          <AlertDescription>
            <p className="whitespace-pre-wrap">{model.worktreesProblem}</p>
          </AlertDescription>
        </Alert>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Worktree</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Loop</TableHead>
              <TableHead>Use</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No worktrees.
                </TableCell>
              </TableRow>
            ) : (
              model.rows.map((row) => (
                <TableRow key={row.path}>
                  <TableCell className="font-mono text-xs">{row.path}</TableCell>
                  <TableCell className={cn("font-mono text-xs", row.branch === "detached" && "text-muted-foreground")}>
                    {row.branch}
                  </TableCell>
                  <TableCell>{row.loop ?? <Absent />}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <Dot tone={row.tone} />
                      <span className={TONE_TEXT[row.tone]}>{row.use}</span>
                    </span>
                    {row.detail !== null && <div className="text-xs text-muted-foreground">{row.detail}</div>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
