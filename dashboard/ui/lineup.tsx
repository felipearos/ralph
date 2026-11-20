/**
 * The lineup editor: which model runs which stage of one loop, on which harness.
 *
 * It is a form over `GET /api/lineup`, `POST /api/lineup/preview` and
 * `POST /api/lineup/save`; both writes go through the command module, so
 * whether the remote page may send them is the route's, not this view's. The
 * form constrains its choices from the runtime schema the read returns —
 * per-stage runner set, the Agent-tool alias set —
 * rather than a copy that could drift, and every candidate is judged by the
 * resolver through preview before the operator is offered a save.
 *
 * The lineup is keyed by project, and the API serves this project's view of
 * `models.json`: its loop blocks and the `default` they fall back to. A save
 * writes back that project's keys and nothing else.
 *
 * Edits are made to a client-side copy of that view the same way the
 * server's edit layer does them: a named loop's block is created from
 * `default`, complete, before a stage in it is changed, so a partial block
 * can never be written.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Loader2, Plus, RefreshCw, RotateCcw, TriangleAlert, X } from "lucide-react";

import type {
  HarnessCatalogView,
  JsonObject,
  LineupPreview,
  LineupRead,
  RunnerCatalogView,
  RuntimeSchema,
  Shadow,
} from "../../lineup/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HarnessMark, harnessName } from "./harness-marks";
import { HelpTip } from "./help-tip";
import { changedCount, changedFields, effortName, harnessVersion, stageGroups, type ChangedFields, type StageValues } from "./lineup-model";
import { groupModels, modelName } from "./model-groups";
import { isRemote } from "./api";
import { CommandNotice, LocalOnlyNote, send, useCommand, useCommandAvailability } from "./command";
import { noticeText, type CommandError } from "./command-model";
import { useLineup, useLineupCatalog } from "./use-reads";

/* ------------------------------------------------------------ config edits */

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function readStageNode(block: JsonObject, stage: string): JsonObject | undefined {
  let node: unknown = block;
  for (const part of stage.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return isObject(node) ? node : undefined;
}

function ensureStageNode(block: JsonObject, stage: string): JsonObject {
  let node = block;
  for (const part of stage.split(".")) {
    const next = node[part];
    if (isObject(next)) {
      node = next;
    } else {
      const created: JsonObject = {};
      node[part] = created;
      node = created;
    }
  }
  return node;
}

/** A named loop's block, created complete from `default` when it is missing. */
function ensureLoopBlock(config: JsonObject, loop: string, stages: readonly string[]): JsonObject {
  if (loop === "default") return isObject(config.default) ? config.default : (config.default = {});
  const base = isObject(config.default) ? config.default : {};
  const existing = config[loop];
  const block = isObject(existing) ? existing : (config[loop] = {});
  for (const stage of stages) {
    if (readStageNode(block, stage) === undefined) {
      const source = readStageNode(base, stage);
      if (source) Object.assign(ensureStageNode(block, stage), clone(source));
    }
  }
  return block;
}

export interface StageChange {
  runner?: string;
  model?: string;
  effort?: string | null;
  fallback?: string[] | null;
  fallbackEfforts?: Record<string, string> | null;
}

/**
 * `seed` is what the stage resolves to today, written first when neither the
 * loop's block nor `default` names the stage: a stage with a built-in default
 * (the clerk's `code-context`) is absent from both, and a change to its model
 * alone would otherwise write a node with no runner, which the resolver refuses.
 */
export function setStage(
  config: JsonObject,
  loop: string,
  stage: string,
  change: StageChange,
  stages: readonly string[],
  seed?: { runner: string; model: string; effort?: string },
): JsonObject {
  const next = clone(config);
  const block = ensureLoopBlock(next, loop, stages);
  const unnamed = readStageNode(block, stage) === undefined;
  const node = ensureStageNode(block, stage);
  if (unnamed && seed) {
    node.runner = seed.runner;
    node.model = seed.model;
    if (seed.effort !== undefined) node.effort = seed.effort;
  }
  if (change.runner !== undefined) node.runner = change.runner;
  if (change.model !== undefined) node.model = change.model;
  if (change.effort !== undefined) {
    if (change.effort === null) delete node.effort;
    else node.effort = change.effort;
  }
  if (change.fallbackEfforts !== undefined) {
    if (change.fallbackEfforts === null) delete node.fallbackEfforts;
    else node.fallbackEfforts = { ...change.fallbackEfforts };
  }
  if (change.fallback !== undefined) {
    if (change.fallback === null) delete node.fallback;
    else node.fallback = change.fallback;
    if (isObject(node.fallbackEfforts)) {
      const kept = Object.fromEntries(Object.entries(node.fallbackEfforts)
        .filter(([id]) => change.fallback?.includes(id)));
      if (Object.keys(kept).length) node.fallbackEfforts = kept;
      else delete node.fallbackEfforts;
    }
  }
  return next;
}

/** The stage as written in the block the loop resolves from, if any. */
function configuredStage(config: JsonObject, loop: string, stage: string): JsonObject | undefined {
  const block = isObject(config[loop]) ? config[loop] : isObject(config.default) ? config.default : undefined;
  return block ? readStageNode(block, stage) : undefined;
}

/** Every model id the file already names for a runner, as typing suggestions. */
function knownModels(config: JsonObject, runner: string): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    if (node.runner === runner && typeof node.model === "string") found.add(node.model);
    for (const value of Object.values(node)) walk(value);
  };
  walk(config);
  return [...found].sort();
}

const STAGE_HELP: Record<string, string> = {
  orchestrator: "Claude Code or Codex running the iteration prompt; takes an effort.",
  executor: "Writes the code. A process delegate.sh starts on the stage's runner.",
  mapper: "Maps the relevant code before implementation. Read-only.",
  "review.standards": "Pre-PR review against the repo's coding standards. Read-only.",
  "review.spec": "Pre-PR review against the issue's requirements. Read-only.",
  "review.correctness": "Pre-PR bug hunt over the diff: races, failure paths, missing checks. Read-only; defaults to Opus at high effort.",
  "code-context": "The clerk's read of the code behind a filed ticket, one session per ticket. Claude only; defaults to Opus at high effort.",
};

/** What a stage is called in the table; its group heading carries any `review.` prefix. */
const STAGE_NAMES: Record<string, string> = {
  orchestrator: "Orchestrator",
  executor: "Executor",
  mapper: "Mapper",
  "review.standards": "Standards",
  "review.spec": "Spec",
  "review.correctness": "Correctness",
  "code-context": "Code context",
};

/** The one line under a stage's name; the full sentence (STAGE_HELP) is its tooltip. */
const STAGE_BRIEF: Record<string, string> = {
  orchestrator: "Runs the iteration prompt",
  executor: "Writes the code",
  mapper: "Maps the relevant code first · read-only",
  "review.standards": "Against the repo's coding standards · read-only",
  "review.spec": "Against the issue's requirements · read-only",
  "review.correctness": "Bug hunt over the diff · read-only",
  "code-context": "Reads the code behind a filed ticket",
};

function stageValues(
  config: JsonObject,
  loop: string,
  stage: string,
  resolved: LineupRead["resolved"]["stages"][string] | undefined,
  schema: RuntimeSchema,
): StageValues {
  const node = configuredStage(config, loop, stage) ?? {};
  return {
    runner: typeof node.runner === "string" ? node.runner : (resolved?.runner ?? schema.runners[0] ?? "claude"),
    model: typeof node.model === "string" ? node.model : (resolved?.model ?? ""),
    effort: typeof node.effort === "string" ? node.effort : "",
    fallback: Array.isArray(node.fallback)
      ? node.fallback.filter((value): value is string => typeof value === "string")
      : typeof node.fallback === "string"
        ? [node.fallback]
        : [],
    fallbackEfforts: isObject(node.fallbackEfforts)
      ? Object.fromEntries(Object.entries(node.fallbackEfforts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
  };
}

/** Which of a stage's cells a config changes against the file, as the row marks them. */
function stageChanges(
  config: JsonObject,
  original: StageValues,
  loop: string,
  stage: string,
  resolved: LineupRead["resolved"]["stages"][string] | undefined,
  schema: RuntimeSchema,
): ChangedFields {
  const now = stageValues(config, loop, stage, resolved, schema);
  return changedFields(now, original, {
    effort: takesEffort(schema, stage, now.runner),
    fallback: schema.agentToolStages.includes(stage) && now.runner !== "claude",
  });
}

/** What `claude --help` printed last time; used only until the catalogue answers. */
const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const CUSTOM = "__custom";

/**
 * The ids the picker offers for one stage on one runner, from the harness's
 * catalogue and the resolver's rules together:
 *
 *   claude + Agent-tool stage   a named agent: full ids and the aliases; an
 *                               older resolver's ad-hoc call: aliases only
 *   claude + executor           full ids only; an alias is refused there
 *   claude + orchestrator       full ids, and the aliases `claude -p` accepts
 *   opencode / codex            whatever that harness listed
 */
function choicesFor(
  stage: string,
  runner: string,
  schema: RuntimeSchema,
  runnerCatalog: RunnerCatalogView | undefined,
): { id: string; label?: string }[] {
  const agentTool = schema.agentToolStages.includes(stage);
  // An ad-hoc Agent call takes an alias and nothing else, so the value stays
  // the alias; the label says which full model the harness resolves it to today.
  if (runner === "claude" && agentTool && !isNamedAgent(schema, stage, runner)) {
    // The harness's own alias map wins over the resolver's copy of it.
    return schema.aliases.map((id) => {
      const target = runnerCatalog?.aliases[id] ?? schema.aliasTargets[id];
      return { id, label: target ?? id };
    });
  }
  const listed = (runnerCatalog?.available ? runnerCatalog.models : []).map((model) => ({
    id: model.id,
    label: runner === "opencode"
      ? model.id.slice(model.id.indexOf("/") + 1)
      : runner !== "claude" && model.label && model.label.toLowerCase() !== model.id.toLowerCase() ? `${model.id}  — ${model.label}` : model.id,
  }));
  if (runner !== "claude") return listed;
  const isAlias = (id: string) => !id.startsWith("claude-");
  const full = listed.filter((model) => !isAlias(model.id));
  if (stage === "executor") return full;
  return [...full, ...listed.filter((model) => isAlias(model.id))];
}

/** Whether the resolver runs this stage as a named agent, which carries a full id and an effort. */
function isNamedAgent(schema: RuntimeSchema, stage: string, runner: string): boolean {
  return runner === "claude" && schema.agentNames?.[stage] !== undefined && schema.claudeIdPrefix !== undefined;
}

/** Whether the resolver passes an effort to this stage on this runner. */
function takesEffort(schema: RuntimeSchema, stage: string, runner: string): boolean {
  return schema.effortRunnersFor?.[stage]?.includes(runner) ?? (stage === "orchestrator" || runner === "codex");
}

function fallbackRunnerFor(model: string, schema: RuntimeSchema): string {
  if (schema.aliases.includes(model) || model.startsWith("claude-")) return "claude";
  return model.includes("/") ? "opencode" : "codex";
}

/** Every route a read-only stage can fall through to, grouped by harness. */
function fallbackChoicesFor(
  stage: string,
  primaryRunner: string,
  primaryModel: string,
  schema: RuntimeSchema,
  catalog: HarnessCatalogView | null,
  config: JsonObject,
): { id: string; runner: string; label: string }[] {
  const choices: { id: string; runner: string; label: string }[] = [];
  const runners = [...(schema.runnersFor[stage] ?? [])].sort((left, right) => {
    if (left === primaryRunner) return -1;
    if (right === primaryRunner) return 1;
    if (left === "claude") return 1;
    if (right === "claude") return -1;
    return 0;
  });
  for (const runner of runners) {
    if (runner === "claude") {
      for (const id of schema.aliases) {
        const target = catalog?.runners.claude?.aliases[id] ?? schema.aliasTargets[id];
        choices.push({ id, runner, label: target ?? id });
      }
      continue;
    }
    const listed = choicesFor(stage, runner, schema, catalog?.runners[runner]);
    if (runner === primaryRunner && primaryModel.includes("/")) {
      const provider = primaryModel.split("/", 1)[0] + "/";
      listed.sort((left, right) => Number(right.id.startsWith(provider)) - Number(left.id.startsWith(provider)));
    }
    const ids: { id: string; label?: string }[] = listed.length
      ? listed
      : knownModels(config, runner).map((id) => ({ id }));
    for (const choice of ids) choices.push({ id: choice.id, runner, label: choice.label ?? choice.id });
  }
  return choices;
}

/* -------------------------------------------------------------- component */

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "failed"; error: CommandError };

/**
 * `role` is the loop's role from the dashboard's roster read.
 *
 * It is passed because the resolver cannot work it out from here: the lineup
 * adapter edits HARNESS checkouts, and a loop's role is declared in the
 * PROJECT's `.ralph/config.json`. Without it a triager's form offers five
 * stages, three of which it never runs — and the resolver then refuses the
 * block the form just helped write.
 */
export function LineupEditor({ loop, role }: { loop: string; role?: string }) {
  // The reads go through the store (#614); the POSTs below go through the command module (#621).
  const lineup = useLineup(loop, role);
  const [fresh, setFresh] = useState(false);
  const catalogRead = useLineupCatalog(fresh);
  const read = lineup.read.state === "loading" ? null : lineup.read.data;
  // Only a read that never landed replaces the editor: a failed re-read after a save keeps the form.
  const loadError = lineup.read.state === "error" && lineup.read.data === null ? lineup.read.message : null;
  const [draft, setDraft] = useState<JsonObject | null>(null);
  const [preview, setPreview] = useState<LineupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const previewRoute = useCommandAvailability("/api/lineup/preview");
  const saving = useCommand("/api/lineup/save");

  // Seeded per snapshot, not per render: an operator's edits survive until a
  // new read lands (the first one, or the re-read after a save).
  useEffect(() => {
    if (!read) return;
    setDraft(clone(read.config));
    setPreview(null);
  }, [read]);

  // Asking the harnesses is local only; the remote page shows the lineup as read.
  const catalogState: "loading" | "ready" | "failed" = isRemote()
    ? "failed"
    : catalogRead.busy || catalogRead.read.state === "loading"
      ? "loading"
      : catalogRead.read.state === "error"
        ? "failed"
        : "ready";
  // The last catalogue the harnesses gave stays on screen while a Refresh
  // asks again and after one fails: the first Refresh moves to a new URL,
  // whose entry starts empty, and the model pickers would drop to free text.
  const [lastCatalog, setLastCatalog] = useState<HarnessCatalogView | null>(null);
  const catalogData = catalogRead.read.state === "loading" ? null : catalogRead.read.data;
  useEffect(() => {
    if (catalogData !== null) setLastCatalog(catalogData);
  }, [catalogData]);
  const catalog = catalogData ?? lastCatalog;
  // The first Refresh moves to the `?refresh=1` read, which fetches on subscribe; later ones re-read it.
  const refreshCatalog = () => {
    if (fresh) catalogRead.reload();
    else setFresh(true);
  };

  const dirty = useMemo(
    () => read !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(read.config),
    [read, draft],
  );

  // Every edit is judged by the resolver before a save is offered.
  useEffect(() => {
    // The resolver runs on the machine only: where the route is not offered the
    // page cannot judge an edit, or save one.
    if (!read || !draft || !dirty || previewRoute.disabled) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    // One controller per preview: an edit that supersedes it aborts it, so a
    // stale answer can never land over a newer draft's.
    const controller = new AbortController();
    setPreviewing(true);
    const timer = setTimeout(async () => {
      const result = await send<LineupPreview>("/api/lineup/preview", { loop, role, config: draft }, { signal: controller.signal });
      if (controller.signal.aborted || (!result.ok && result.error.kind === "Aborted")) return;
      if (result.ok && result.value !== null) {
        setPreview(result.value);
      } else {
        const problems = result.ok
          ? ["the resolver answered nothing"]
          : result.error.problems !== undefined && result.error.problems.length > 0
            ? result.error.problems
            : [result.error.message === "" ? noticeText(result.error) : result.error.message];
        setPreview({ root: read.root, project: read.project, loop, valid: false, problems, resolved: null, schema: read.schema, shadows: [] });
      }
      setPreviewing(false);
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, dirty, loop, read, previewRoute.disabled]);

  const change = (stage: string, edit: StageChange) => {
    if (!read || !draft) return;
    setSave({ kind: "idle" });
    // Seeded only from the resolver's own default, never from an environment
    // one-off, which belongs to this run and not in the file.
    const current = (preview?.resolved ?? read.resolved).stages[stage];
    const seed = current?.source === "default" ? current : undefined;
    const next = setStage(draft, loop, stage, edit, read.schema.stages, seed);
    // Putting every cell back leaves the block the first edit copied in; drop
    // it, so a fully reverted lineup is the file again and there is nothing to save.
    const live = (preview?.resolved ?? read.resolved).stages;
    const unchanged = read.schema.stages.every((name) => {
      const saved = stageValues(read.config, loop, name, read.resolved.stages[name], read.schema);
      return changedCount(stageChanges(next, saved, loop, name, live[name], read.schema)) === 0;
    });
    setDraft(unchanged ? clone(read.config) : next);
  };

  const commit = async () => {
    if (!draft) return;
    setSave({ kind: "saving" });
    const result = await saving.send({ loop, role, config: draft });
    if (!result.ok) {
      setSave(result.error.kind === "Aborted" ? { kind: "idle" } : { kind: "failed", error: result.error });
      return;
    }
    setSave({ kind: "saved", at: new Date() });
    lineup.reload();
  };

  const reset = () => {
    if (!read) return;
    setDraft(clone(read.config));
    setSave({ kind: "idle" });
  };

  if (loadError) {
    return (
      <BadPanel title="The lineup could not be read">
        <p className="whitespace-pre-wrap">{loadError}</p>
      </BadPanel>
    );
  }

  if (!read || !draft) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
    );
  }

  const { schema } = read;
  const hasOwnBlock = isObject(read.config[loop]);
  const resolved = (preview?.resolved ?? read.resolved).stages;
  const problems = preview?.problems ?? [];
  const valid = preview ? preview.valid : true;
  const originals = Object.fromEntries(
    schema.stages.map((stage) => [stage, stageValues(read.config, loop, stage, read.resolved.stages[stage], schema)]),
  );
  const groups = stageGroups(schema.stages);
  // Counted per cell, the way the table marks them, so the bar and the blue cells agree.
  const changedCells = schema.stages.reduce(
    (count, stage) => count + changedCount(stageChanges(draft, originals[stage]!, loop, stage, resolved[stage], schema)),
    0,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border px-3 py-2.5 text-xs">
        <p className="min-w-0 text-muted-foreground">
          Using <span className="font-medium text-foreground">{hasOwnBlock ? "its own settings" : "the shared defaults"}</span>
          {hasOwnBlock
            ? ` · ${read.project} → ${loop} in models.json`
            : ` · ${read.project}'s default in models.json; the first edit copies them into this loop's own`}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {catalog ? (
            Object.entries(catalog.runners).map(([name, runner]) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5"
                title={runner.available ? (runner.version ?? undefined) : (runner.reason ?? "unavailable")}
              >
                <span className={cn("size-1.5 rounded-full", runner.available ? "bg-status-good" : "bg-status-bad")} />
                {harnessName(name)}
                {runner.available && harnessVersion(runner.version) !== null && ` ${harnessVersion(runner.version)}`}
                {!runner.available && " unavailable"}
              </span>
            ))
          ) : (
            <span>
              {catalogState === "failed"
                ? "The harnesses could not be asked; model fields are free text."
                : "Asking the harnesses what they can run…"}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground"
            disabled={catalogState === "loading" || isRemote()}
            onClick={refreshCatalog}
            title="Ask the harnesses again"
          >
            <RefreshCw className={cn("size-3", catalogState === "loading" && "animate-spin")} />
            <span className="sr-only">Refresh models</span>
          </Button>
        </div>
      </div>

        {read.shadows.length > 0 && (
          <div role="status" className="flex items-start gap-2.5 border border-l-2 border-status-warn/35 border-l-status-warn bg-status-warn/[0.05] px-3 py-2 text-sm">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-warn" />
            <p>
              {read.shadows.length === 1 ? "1 setting is" : `${read.shadows.length} settings are`} overridden on this machine
              and won't apply until {read.shadows.length === 1 ? "it's" : "they're"} unset. Hover the ⚠ for which.
            </p>
          </div>
        )}

        <div className="border" role="group" aria-label="Stages">
          <div className="hidden grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_6.5rem] gap-x-2 border-b py-2 pr-2.5 pl-3 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase sm:grid">
            <span>Stage</span>
            <span className="px-2">Harness</span>
            <span className="px-2">Model</span>
            <span className="px-2">Effort</span>
          </div>
          {groups.map((group) => (
            <div key={group.label} role="group" aria-label={groups.length > 1 ? group.label : undefined}>
              {groups.length > 1 && (
                <p className="px-3 pt-3 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </p>
              )}
              {group.stages.map((stage) => (
                <StageRow
                  key={stage}
                  stage={stage}
                  schema={schema}
                  config={draft}
                  loop={loop}
                  resolved={resolved[stage]}
                  original={originals[stage]!}
                  overrides={read.shadows.filter((shadow) => shadow.stage === stage)}
                  catalog={catalog}
                  onChange={(edit) => change(stage, edit)}
                />
              ))}
            </div>
          ))}
        </div>

        {dirty && problems.length > 0 && (
          <BadPanel title="The resolver refuses this lineup">
            <ul className="list-disc space-y-1 pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </BadPanel>
        )}

        {save.kind === "failed" && (
          <BadPanel title="Not saved">
            <div className="whitespace-pre-wrap">
              <CommandNotice error={save.error} />
            </div>
          </BadPanel>
        )}

        <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background px-4 py-3 sm:flex-nowrap">
          <div className="min-w-0 basis-full sm:basis-auto sm:flex-1" aria-live="polite">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {dirty ? (
                <>
                  <span className="size-1.5 rounded-full bg-status-info" aria-hidden />
                  <span className="font-semibold">
                    {changedCells === 1 ? "1 unsaved change" : `${changedCells} unsaved changes`}
                  </span>
                  <span className="text-muted-foreground/50" aria-hidden>·</span>
                  {previewing ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                      Checking with the resolver…
                    </span>
                  ) : valid ? (
                    <span className="inline-flex items-center gap-1.5 text-status-good">
                      <CircleCheck aria-hidden className="size-3.5" />
                      Valid
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-status-bad">
                      <CircleAlert aria-hidden className="size-3.5" />
                      The resolver refuses it — see above
                    </span>
                  )}
                </>
              ) : save.kind === "saved" ? (
                <span className="inline-flex items-center gap-1.5 text-status-good">
                  <CircleCheck aria-hidden className="size-3.5" />
                  Saved at {save.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              ) : (
                <span className="text-muted-foreground">No unsaved changes</span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Executor and reviewers pick it up on their next call; the orchestrator on the loop's next start.
              <HelpTip label="Where the lineup is saved" className="ml-1.5 align-[-2px]">
                Saving rewrites {read.root}/models.json atomically, and only this project's keys.
              </HelpTip>
            </p>
            <LocalOnlyNote route="/api/lineup/save" className="mt-0.5 block" />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!dirty || save.kind === "saving"} onClick={reset}>
              <RotateCcw />
              Discard
            </Button>
            <Button
              size="sm"
              disabled={!dirty || !valid || previewing || save.kind === "saving" || saving.disabled}
              title={saving.why ?? undefined}
              onClick={commit}
            >
              {save.kind === "saving" ? "Saving…" : "Save lineup"}
            </Button>
          </div>
        </div>

    </div>
  );
}

/** A refusal, in the square red-edged panel the dashboard's other notices use. */
function BadPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 border border-l-2 border-status-bad/35 border-l-status-bad bg-status-bad/[0.05] px-3 py-2.5 text-sm">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-bad" />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold text-status-bad">{title}</p>
        <div className="break-words text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- one stage */

/**
 * A table cell reads as plain text until its row is hovered, focused or
 * edited; small screens have no hover, so there it is always a box.
 */
function cellTrigger(changed: boolean): string {
  return cn(
    "h-8 w-full min-w-0 border border-transparent px-2 py-0 text-sm",
    "group-hover/row:border-border group-focus-within/row:border-border group-data-[edited]/row:border-border max-sm:border-border data-[state=open]:border-border",
    "[&>svg:last-child]:opacity-0 group-hover/row:[&>svg:last-child]:opacity-100 group-focus-within/row:[&>svg:last-child]:opacity-100 group-data-[edited]/row:[&>svg:last-child]:opacity-100 max-sm:[&>svg:last-child]:opacity-100",
    changed && "text-status-info",
  );
}

/** One editable value, with a button that puts just this cell back while it differs from the file. */
function Cell({
  changed,
  revertTo,
  onRevert,
  override,
  children,
}: {
  changed: boolean;
  revertTo: string;
  onRevert: () => void;
  /** Set when an environment variable makes the stage run something else, so this value will not apply. */
  override?: { variable: string; actual: string };
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div
        className={cn(
          "min-w-0 flex-1",
          override &&
            "[&_[data-slot=select-value]]:text-status-warn [&_[data-slot=select-value]]:line-through [&_[data-slot=select-value]]:decoration-status-warn/50 [&_input]:text-status-warn [&_input]:line-through [&_input]:decoration-status-warn/50",
        )}
      >
        {children}
      </div>
      {override && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Overridden by ${override.variable}`}
              className="inline-flex size-6 shrink-0 items-center justify-center text-status-warn outline-none"
            >
              <TriangleAlert aria-hidden className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className="block max-w-72 leading-relaxed">
            <span className="font-semibold">Overridden on this machine.</span> {override.variable} makes it run{" "}
            {override.actual || "something else"}. Unset it for this setting to apply.
          </TooltipContent>
        </Tooltip>
      )}
      {changed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRevert}
              aria-label={`Back to ${revertTo}`}
              className="inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
            >
              <RotateCcw aria-hidden className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Back to {revertTo}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function StageRow({
  stage,
  schema,
  config,
  loop,
  resolved,
  original,
  overrides,
  catalog,
  onChange,
}: {
  stage: string;
  schema: RuntimeSchema;
  config: JsonObject;
  loop: string;
  resolved: LineupRead["resolved"]["stages"][string] | undefined;
  /** The stage as last read, so an unsaved edit can be marked and put back cell by cell. */
  original: StageValues;
  /** Environment variables that win over this stage's fields while the supervisor runs. */
  overrides: readonly Shadow[];
  catalog: HarnessCatalogView | null;
  onChange: (edit: StageChange) => void;
}) {
  const { runner, model, effort, fallback, fallbackEfforts } = stageValues(config, loop, stage, resolved, schema);
  const runners = schema.runnersFor[stage] ?? schema.runners;
  const agentTool = schema.agentToolStages.includes(stage);
  const runnerCatalog = catalog?.runners[runner];
  const choices = choicesFor(stage, runner, schema, runnerCatalog);
  // A model the catalogue does not list is still shown and kept: the harness
  // may know it, or the operator may be ahead of the catalogue.
  const listed = choices.some((choice) => choice.id === model);
  const [custom, setCustom] = useState(false);
  const suggestions = knownModels(config, runner);
  const listId = `models-${stage.replace(/\./g, "-")}-${runner}`;
  // The chosen model's own effort levels when the harness reports them per
  // model (Opus 4.6 has no xhigh, for example), else what the CLI accepts.
  const effortCatalog = catalog?.runners[runner];
  const modelEfforts = effortCatalog?.models.find((entry) => entry.id === model)?.efforts;
  const efforts = modelEfforts?.length ? modelEfforts : effortCatalog?.efforts.length ? effortCatalog.efforts : FALLBACK_EFFORTS;
  const pickerChoices = [...choices, ...(model !== "" && !listed ? [{ id: model, label: `${model} (not in catalogue)` }] : [])];
  const useSelect = choices.length > 0 && !custom;
  const aliasOnly = agentTool && runner === "claude" && !isNamedAgent(schema, stage, runner);
  const fallbackChoices = fallbackChoicesFor(stage, runner, model, schema, catalog, config);

  const setFallbackAt = (index: number, value: string) => {
    const next = [...fallback];
    next[index] = value;
    // Effort belongs to the selected model; a replacement starts at its default.
    const efforts = { ...fallbackEfforts };
    delete efforts[fallback[index]!];
    onChange({ fallback: next, fallbackEfforts: Object.keys(efforts).length ? efforts : null });
  };
  const moveFallback = (index: number, direction: -1 | 1) => {
    const next = [...fallback];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange({ fallback: next });
  };

  const changed = stageChanges(config, original, loop, stage, resolved, schema);
  const edited = changed.runner || changed.model || changed.effort || changed.fallback;
  const name = STAGE_NAMES[stage] ?? stage;
  // What the environment makes this stage run instead, cell by cell: the
  // resolver reports the stage as it runs, so its value is the variable's.
  const override = (field: Shadow["field"]): { variable: string; actual: string } | undefined => {
    const shadow = overrides.find((entry) => entry.field === field);
    if (shadow === undefined) return undefined;
    const actual =
      field === "runner"
        ? harnessName(resolved?.runner ?? "")
        : field === "model"
          ? modelName(resolved?.model ?? "", resolved?.runner ?? runner, catalog?.runners[resolved?.runner ?? runner], schema.aliasTargets)
          : effortName(resolved?.effort ?? "");
    return { variable: shadow.variable, actual };
  };
  // The harness is put back with its model, effort and fallbacks: they were chosen for it.
  const revertHarness = () =>
    onChange({
      runner: original.runner,
      model: original.model,
      effort: original.effort === "" ? null : original.effort,
      fallback: original.fallback.length ? original.fallback : null,
      fallbackEfforts: Object.keys(original.fallbackEfforts).length ? original.fallbackEfforts : null,
    });

  return (
    <div
      data-edited={edited || undefined}
      className={cn(
        "group/row border-b border-border/50 last:border-b-0",
        edited && "bg-status-info/[0.06] shadow-[inset_2px_0_0_var(--color-status-info)]",
      )}
    >
      <div className="grid grid-cols-1 items-center gap-x-2 gap-y-1.5 py-2 pr-2.5 pl-3 sm:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_6.5rem]">
        <div className="min-w-0 py-0.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {name}
            {edited && (
              <>
                <span className="size-1.5 rounded-full bg-status-info" aria-hidden />
                <span className="sr-only">unsaved</span>
              </>
            )}
          </p>
          {STAGE_BRIEF[stage] !== undefined &&
            (STAGE_HELP[stage] !== undefined ? (
              <Tooltip>
                {/* Focusable, so the full sentence reaches keyboard users too, not only a hover. */}
                <TooltipTrigger asChild>
                  <button type="button" className="block text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
                    {STAGE_BRIEF[stage]}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4} className="block max-w-72 leading-relaxed">
                  {STAGE_HELP[stage]}
                </TooltipContent>
              </Tooltip>
            ) : (
              <p className="text-xs text-muted-foreground">{STAGE_BRIEF[stage]}</p>
            ))}
        </div>

        <Cell changed={changed.runner} revertTo={harnessName(original.runner)} onRevert={revertHarness} override={override("runner")}>
          <Select
            value={runner}
            onValueChange={(next) => {
              // A runner change arrives with a model that runner accepts, so
              // the resolver is not asked to judge an opencode id on claude.
              const nextChoices = choicesFor(stage, next, schema, catalog?.runners[next]);
              const nextModel = nextChoices.some((choice) => choice.id === model)
                ? model
                : (nextChoices[0]?.id ?? knownModels(config, next)[0] ?? "");
              setCustom(false);
              onChange({
                runner: next,
                ...(!takesEffort(schema, stage, next) ? { effort: null } : {}),
                model: nextModel,
                ...(agentTool && next === "claude" ? { fallback: null, fallbackEfforts: null } : {}),
              });
            }}
          >
            <SelectTrigger id={`${stage}-runner`} aria-label={`${name} harness`} className={cellTrigger(changed.runner)}>
              <SelectValue>
                <HarnessMark runner={runner} className="size-3.5" />
                {harnessName(runner)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {runners.map((option) => (
                <SelectItem key={option} value={option}>
                  <HarnessMark runner={option} className="size-3.5" />
                  {harnessName(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Cell>

        <Cell
          changed={changed.model}
          revertTo={modelName(original.model, original.runner, catalog?.runners[original.runner], schema.aliasTargets)}
          onRevert={() => onChange({ model: original.model })}
          override={override("model")}
        >
          {useSelect ? (
            <Select
              value={model}
              onValueChange={(next) => {
                if (next === CUSTOM) {
                  setCustom(true);
                  return;
                }
                onChange({ model: next });
              }}
            >
              <SelectTrigger id={`${stage}-model`} aria-label={`${name} model`} className={cellTrigger(changed.model)}>
                <SelectValue placeholder="Pick a model">
                  {model === "" ? undefined : modelName(model, runner, runnerCatalog, schema.aliasTargets)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {groupModels(pickerChoices, runner, runnerCatalog, schema.aliasTargets).map(group => (
                  <SelectGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.choices.map(choice => {
                      const shown = modelName(choice.id, runner, runnerCatalog, schema.aliasTargets);
                      return (
                        <SelectItem key={choice.id} value={choice.id}>
                          {shown}
                          {!shown.includes(choice.id) && <span className="text-xs text-muted-foreground">{choice.id}</span>}
                          {!listed && choice.id === model && <span className="text-xs text-muted-foreground">not in catalogue</span>}
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                ))}
                {!aliasOnly && (
                  <SelectGroup>
                    <SelectLabel>Custom model</SelectLabel>
                    <SelectItem value={CUSTOM}>Other id…</SelectItem>
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={`${stage}-model`}
              aria-label={`${name} model`}
              list={listId}
              value={model}
              spellCheck={false}
              autoComplete="off"
              placeholder={runner === "opencode" ? "provider/model" : "model id"}
              onChange={(event) => onChange({ model: event.target.value })}
              className={cn("h-8 w-full min-w-0 border border-border px-2 py-0 text-sm", changed.model && "text-status-info")}
            />
          )}
        </Cell>

        {takesEffort(schema, stage, runner) ? (
          <Cell
            changed={changed.effort}
            revertTo={effortName(original.effort)}
            onRevert={() => onChange({ effort: original.effort === "" ? null : original.effort })}
            override={override("effort")}
          >
            <Select
              value={effort === "" ? "__none" : effort}
              onValueChange={(next) => onChange({ effort: next === "__none" ? null : next })}
            >
              <SelectTrigger id={`${stage}-effort`} aria-label={`${name} effort`} className={cellTrigger(changed.effort)}>
                <SelectValue>{effortName(effort)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Default</SelectItem>
                {[...new Set([...efforts, ...(effort ? [effort] : [])])].map((option) => (
                  <SelectItem key={option} value={option}>
                    {effortName(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Cell>
        ) : (
          <span className="hidden px-2 text-sm text-muted-foreground/50 sm:block">
            <span aria-hidden>—</span>
            <span className="sr-only">No effort for this stage</span>
          </span>
        )}
      </div>

      {!useSelect && (
        <>
          <datalist id={listId}>
            {[...new Set([...choices.map((choice) => choice.id), ...suggestions])].map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {custom && choices.length > 0 ? (
            <p className="-mt-1 pb-2 pl-3 text-xs sm:pl-[calc(50%+1rem)]">
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setCustom(false)}>
                Back to the catalogue
              </button>
            </p>
          ) : runnerCatalog && !runnerCatalog.available ? (
            <p className="-mt-1 pb-2 pl-3 text-xs text-status-warn" title={runnerCatalog.reason ?? undefined}>
              {harnessName(runner)} could not be asked for its models; type the id.
            </p>
          ) : null}
        </>
      )}
      {useSelect && aliasOnly && (
        <p className="-mt-1 pb-2 pl-3 text-xs text-muted-foreground">Agent-tool call on Claude Code: takes an alias, not a full id.</p>
      )}

      {agentTool && runner !== "claude" && (
        <div className="mr-2.5 mb-2 ml-6 border-t border-border/50 pt-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                Fallback order
                {changed.fallback && (
                  <>
                    <span className="size-1.5 rounded-full bg-status-info" aria-hidden />
                    <span className="sr-only">unsaved</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Back to the saved fallback order"
                          onClick={() =>
                            onChange({
                              fallback: original.fallback.length ? original.fallback : null,
                              fallbackEfforts: Object.keys(original.fallbackEfforts).length ? original.fallbackEfforts : null,
                            })
                          }
                          className="inline-flex size-5 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                        >
                          <RotateCcw aria-hidden className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={4}>Back to the saved fallback order</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Tried top to bottom when {modelName(model, runner, runnerCatalog, schema.aliasTargets) || "the primary model"} fails.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={fallbackChoices.every((choice) => fallback.includes(choice.id) || (choice.id === model && choice.runner === runner))}
              onClick={() => {
                const next = fallbackChoices.find((choice) => !fallback.includes(choice.id) && !(choice.id === model && choice.runner === runner));
                if (next) onChange({ fallback: [...fallback, next.id] });
              }}
            >
              <Plus className="size-3" /> Add fallback
            </Button>
          </div>

          {fallback.length === 0 ? (
            <p className="border-l py-1.5 pl-3 text-xs text-muted-foreground">
              Default route: {schema.defaultFallbacks.map((id) => modelName(id, fallbackRunnerFor(id, schema), catalog?.runners[fallbackRunnerFor(id, schema)], schema.aliasTargets)).join(" → ")}
            </p>
          ) : (
            <ol className="border-l">
              {fallback.map((value, index) => {
                const routeRunner = fallbackRunnerFor(value, schema);
                const available = fallbackChoices.filter(
                  (choice) => choice.id === value || (!fallback.includes(choice.id) && !(choice.id === model && choice.runner === runner)),
                );
                const options = fallbackChoices.filter((choice) => choice.runner === routeRunner);
                if (!options.some((choice) => choice.id === value)) {
                  options.push({ id: value, runner: routeRunner, label: value });
                }
                const routeCatalog = catalog?.runners[routeRunner];
                const modelEfforts = routeCatalog?.models.find((entry) => entry.id === value)?.efforts;
                const routeEfforts = modelEfforts?.length ? modelEfforts : routeCatalog?.efforts.length ? routeCatalog.efforts : FALLBACK_EFFORTS;
                const routeEffort = fallbackEfforts[value] ?? "";
                const position = `Fallback ${index + 1}`;
                return (
                  <li key={`${value}-${index}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 py-0.5 pl-2.5 sm:grid-cols-[1.25rem_9.5rem_minmax(0,1fr)_6.5rem_auto]">
                    <span className="text-right text-xs text-muted-foreground">{index + 1}</span>
                    <Select
                      value={routeRunner}
                      onValueChange={(runner) => {
                        const choice = available.find((entry) => entry.runner === runner);
                        if (choice) setFallbackAt(index, choice.id);
                      }}
                    >
                      <SelectTrigger aria-label={`${position} harness for ${name}`} className={cellTrigger(false)}>
                        <SelectValue>
                          <HarnessMark runner={routeRunner} className="size-3.5" />
                          {harnessName(routeRunner)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {runners.map((option) => (
                          <SelectItem key={option} value={option} disabled={option !== routeRunner && !available.some((choice) => choice.runner === option)}>
                            <HarnessMark runner={option} className="size-3.5" />
                            {harnessName(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={value} onValueChange={(value) => setFallbackAt(index, value)}>
                      <SelectTrigger aria-label={`${position} model for ${name}`} className={cn(cellTrigger(false), "max-sm:col-start-2")}>
                        <SelectValue>{modelName(value, routeRunner, routeCatalog, schema.aliasTargets)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {groupModels(options, routeRunner, routeCatalog, schema.aliasTargets).map(group => (
                          <SelectGroup key={group.label}>
                            <SelectLabel>{group.label}</SelectLabel>
                            {group.choices.map(choice => {
                              const shown = modelName(choice.id, routeRunner, routeCatalog, schema.aliasTargets);
                              return (
                                <SelectItem key={choice.id} value={choice.id} disabled={!available.some((entry) => entry.id === choice.id && entry.runner === routeRunner) && choice.id !== value}>
                                  {shown}
                                  {!shown.includes(choice.id) && <span className="text-xs text-muted-foreground">{choice.id}</span>}
                                  {choice.id !== value && fallback.includes(choice.id) && <span className="text-xs text-muted-foreground">already in the chain</span>}
                                  {choice.id !== value && choice.id === model && routeRunner === runner && <span className="text-xs text-muted-foreground">primary model</span>}
                                </SelectItem>
                              );
                            })}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Only Codex takes an effort per fallback; elsewhere the column holds a dash, as the table does. */}
                    {routeRunner === "codex" ? (
                      <Select
                        value={routeEffort || "__none"}
                        onValueChange={(effort) => {
                          const efforts = { ...fallbackEfforts };
                          if (effort === "__none") delete efforts[value];
                          else efforts[value] = effort;
                          onChange({ fallbackEfforts: Object.keys(efforts).length ? efforts : null });
                        }}
                      >
                        <SelectTrigger aria-label={`${position} effort for ${name}`} className={cn(cellTrigger(false), "max-sm:col-start-2")}>
                          <SelectValue>{effortName(routeEffort)}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">Default</SelectItem>
                          {[...new Set([...routeEfforts, ...(routeEffort ? [routeEffort] : [])])].map((effort) => (
                            <SelectItem key={effort} value={effort}>{effortName(effort)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="hidden px-2 text-sm text-muted-foreground/50 sm:block" title="Only Codex takes an effort per fallback">—</span>
                    )}
                    <div className="col-start-3 row-start-1 flex shrink-0 sm:col-start-auto sm:row-start-auto">
                      <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === 0} onClick={() => moveFallback(index, -1)}>
                        <ArrowUp className="size-3" /><span className="sr-only">Move fallback up</span>
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="size-7" disabled={index === fallback.length - 1} onClick={() => moveFallback(index, 1)}>
                        <ArrowDown className="size-3" /><span className="sr-only">Move fallback down</span>
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => {
                        const next = fallback.filter((_, candidate) => candidate !== index);
                        const efforts = { ...fallbackEfforts };
                        delete efforts[value];
                        onChange({ fallback: next.length ? next : null, fallbackEfforts: Object.keys(efforts).length ? efforts : null });
                      }}>
                        <X className="size-3" /><span className="sr-only">Remove fallback</span>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
