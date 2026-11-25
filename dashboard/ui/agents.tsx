/**
 * Growing and shrinking a project's crew: the Add agent dialog, the setup
 * cards of agents the roster does not list yet, Create checkout, Delete agent
 * worktree, and Remove project.
 *
 * Every refusal is the server's; the page only offers what it would accept
 * and paints the answer through `agents-model.ts`.
 *
 * Every write goes through the command module (`command.tsx`), which knows
 * each route's remote behaviour: on the remote dashboard only Start goes on
 * to the machine; adding, checking out, deleting and removing make or remove
 * worktrees and open PRs, so they stay local and show disabled.
 */
import { useCallback, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpen,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Code,
  ExternalLink,
  FolderPlus,
  GitMerge,
  GitPullRequest,
  HeartPulse,
  Inbox,
  Info,
  ListChecks,
  Play,
  Plus,
  RotateCw,
  ShieldCheck,
  Siren,
  Stethoscope,
  Tag,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { LOOP_ROLES, ROLE_SUMMARIES, type LoopRole } from "../contracts";
import type {
  AddAgentResult,
  AgentPreflightView,
  AgentsView,
  PendingAgentView,
  CreateCheckoutResult,
  DeleteAgentResult,
  RemoveProjectResult,
  RerunSetupResult,
  StartResult,
  WorktreeSetupRecord,
} from "../contracts";
import { api } from "./api";
import { AgentGuide } from "./agent-guide";
import { CommandNotice, LocalOnlyNote, useCommand, useCommandAvailability } from "./command";
import { decodeAnswer, EMPTY_ANSWER, noticeText, type CommandError } from "./command-model";
import { RELAY_QUEUED } from "./remote-model";
import {
  addNotice,
  agentNameProblem,
  checkoutNotice,
  deleteNotice,
  FLOW_STEP_LABELS,
  FLOW_STEPS,
  pendingCard,
  preflightLine,
  removeNotice,
  rerunNotice,
  resumeStep,
  setupLines,
  startNotice,
  type FlowStep,
  type Notice,
  type PendingCard,
  type ReadinessLine,
  type Tone,
} from "./agents-model";
import { useAgents } from "./use-reads";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-status-info",
  neutral: "text-muted-foreground",
};

/** A notice's box: a faint wash and border in its tone, and a solid left edge to mark which. */
const TONE_PANEL: Record<Tone, string> = {
  good: "border-status-good/35 border-l-status-good bg-status-good/[0.05]",
  warn: "border-status-warn/35 border-l-status-warn bg-status-warn/[0.05]",
  bad: "border-status-bad/35 border-l-status-bad bg-status-bad/[0.05]",
  info: "border-status-info/35 border-l-status-info bg-status-info/[0.05]",
  neutral: "border-border border-l-muted-foreground bg-muted/20",
};

/** What a panel shows: the server's answer painted by the model, or a command that failed. */
export type Said = Notice | { failure: CommandError };

export function Answer({ notice }: { notice: Said }) {
  const failure = "failure" in notice ? notice.failure : null;
  const { tone, title, detail }: Notice =
    "failure" in notice ? { tone: "bad", title: "The request failed", detail: "" } : notice;
  const Icon = tone === "good" ? CircleCheck : tone === "bad" ? CircleAlert : TriangleAlert;
  return (
    <div role="status" className={cn("flex items-start gap-2.5 border border-l-2 px-3 py-2.5 text-sm", TONE_PANEL[tone])}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[tone])} />
      <div className="min-w-0 space-y-0.5">
        <p className={cn("font-semibold", TONE_TEXT[tone])}>{title}</p>
        {/* A div, not a p: the failure's problems are a list. */}
        <div className="break-words whitespace-pre-wrap text-muted-foreground">
          {failure === null ? detail : <CommandNotice error={failure} />}
        </div>
      </div>
    </div>
  );
}

/** A failure worth showing; a cancelled send was given up on and says nothing. */
export const shown = (error: CommandError): Said | null => (error.kind === "Aborted" ? null : { failure: error });

/** A two-step destructive button: the first click arms it, the second sends. */
export function Confirming({
  label,
  confirm,
  busy,
  why = null,
  unavailable = false,
  armedDetails,
  onConfirm,
}: {
  label: string;
  confirm: string;
  /** A send in flight: every button waits. */
  busy: boolean;
  /**
   * The command cannot be sent now (remote, nothing to act on). It disables
   * arming and confirming but never Cancel, so a control armed before the
   * condition changed can always be put down.
   */
  unavailable?: boolean;
  /** Why the command is not offered here; availability leaves it null while it is. */
  why?: string | null;
  /** What the confirm click will act on, shown above the buttons once armed, so nothing is sent unseen. */
  armedDetails?: ReactNode;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <Button
        size="sm"
        variant="outline"
        className={TONE_TEXT.bad}
        disabled={busy || unavailable}
        title={why ?? undefined}
        onClick={() => setArmed(true)}
      >
        <Trash2 className="size-3.5" />
        {label}
      </Button>
    );
  }
  const buttons = (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || unavailable}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirm}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </Button>
    </span>
  );
  if (armedDetails === undefined) return buttons;
  return (
    <div className="space-y-2">
      {armedDetails}
      {buttons}
    </div>
  );
}

const READINESS_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warn: TriangleAlert,
  bad: CircleAlert,
  info: CircleDashed,
  neutral: CircleDashed,
};

/**
 * One agent's readiness checklist: the steps of the guide the dashboard can
 * check for it.
 *
 * Nothing here blocks Start — the gate that refuses one is preflight's, and
 * the worktree item Start fixes by itself — so an item that is not a pass
 * reads as a warning with the reason beside it, and an item nothing could be
 * read for reads as neither.
 */
/**
 * Readiness as a bordered list: one row per item, its label over its reason,
 * the state named on the right. Only the glyph and the state word take the
 * tone, so a long list stays readable. The counted header is for the whole
 * list; a lone preflight line goes without it.
 */
function Readiness({ lines, counted = false }: { lines: ReadinessLine[]; counted?: boolean }) {
  if (lines.length === 0) return null;
  const passing = lines.filter((line) => line.state === "pass").length;
  return (
    <div className="border">
      {counted && (
        <p className="flex items-center justify-between border-b px-3 py-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          <span>Readiness</span>
          <span>
            {passing} of {lines.length} pass
          </span>
        </p>
      )}
      <ul aria-label="Readiness">
        {lines.map((line) => {
          const Icon = READINESS_ICON[line.tone];
          return (
            <li key={line.key} className="grid grid-cols-[1rem_1fr_auto] items-start gap-2.5 border-b px-3 py-2 text-xs last:border-b-0">
              <Icon className={cn("mt-px size-3.5 shrink-0", TONE_TEXT[line.tone])} aria-hidden />
              <span className="min-w-0">
                <span className="block font-semibold">{line.label}</span>
                <span className="mt-px block break-words text-muted-foreground">{line.reason}</span>
              </span>
              <span className={cn("text-[10px] font-semibold tracking-wide uppercase", TONE_TEXT[line.tone])}>{line.state}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * A setup run's steps, each with how it ended and, behind a toggle, the tail
 * of what it printed — the part that says why a step stopped.
 */
function SetupSteps({ record }: { record: WorktreeSetupRecord | null }) {
  const lines = setupLines(record);
  if (lines.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label="Setup steps">
      {lines.map((line, index) => (
        <li key={`${index}-${line.name}`} className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono">{line.name}</span>
            <Badge variant="outline" className={TONE_TEXT[line.tone]}>
              {line.state}
            </Badge>
            <span className="text-muted-foreground">{line.summary}</span>
          </div>
          {line.output !== "" && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Output</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
                {line.output}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The preflight item, asked for rather than polled.
 *
 * `GET /api/agents` is re-read every five seconds and preflight makes three
 * network calls for each agent it judges, so it is a button and not a line:
 * the operator asks once, before pressing Start.
 */
function PreflightCheck({ name }: { name: string }) {
  // A read, but it only serves the add flow, so it is offered where Add agent is.
  const { disabled, why } = useCommandAvailability("/api/agents");
  const [line, setLine] = useState<ReadinessLine | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(api(`/api/agents/preflight?name=${encodeURIComponent(name)}`), { cache: "no-store" });
      // The command module's decoder, so a refusal reads as every notice does.
      const answer = await decodeAnswer<AgentPreflightView>(response);
      if (!answer.ok) setFailure(noticeText(answer.error));
      else if (answer.value === null) setFailure(noticeText(EMPTY_ANSWER));
      else setLine(preflightLine(answer.value));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" disabled={busy || disabled} title={disabled ? (why ?? undefined) : undefined} onClick={() => void ask()}>
        <Stethoscope className="size-3.5" />
        {busy ? "Running preflight…" : line === null ? "Check preflight" : "Check preflight again"}
      </Button>
      {/* The preflight GET is no command route; it serves the add flow, so it shares Add agent's lock above. */}
      <LocalOnlyNote route="/api/agents" className="ml-2" />
      {line !== null && <Readiness lines={[line]} />}
      {failure !== null && <p className="text-xs text-status-bad">{failure}</p>}
    </div>
  );
}

/** A glyph per role, so the choices can be told apart before their summaries are read. */
const ROLE_ICON: Record<LoopRole, LucideIcon> = {
  coder: Code,
  triager: ListChecks,
  "ci-doctor": Activity,
  "pr-medic": HeartPulse,
  clerk: Inbox,
  verifier: ShieldCheck,
  // It watches the error reporter for new or regressed production errors.
  sentinel: Siren,
};

/**
 * The role picker: every role with its summary, since the choice is made once
 * and is hard to undo. One joined grid, like the setup form's toggles; a
 * summary is cut at two lines so the rows stay even, and its title holds the rest.
 */
function RolePicker({ role, onPick }: { role: LoopRole; onPick: (role: LoopRole) => void }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden border sm:grid-cols-2" role="group" aria-label="New agent role">
      {LOOP_ROLES.map((option) => {
        const Icon = ROLE_ICON[option];
        const picked = option === role;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={picked}
            title={ROLE_SUMMARIES[option]}
            onClick={() => onPick(option)}
            className={cn(
              "-mr-px -mb-px border-r border-b px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
              picked && "bg-foreground/[0.07] shadow-[inset_2px_0_0_var(--foreground)] hover:bg-foreground/[0.07]",
            )}
          >
            <span className="flex items-center gap-2">
              <Icon aria-hidden className={cn("size-4 shrink-0", picked ? "text-foreground" : "text-muted-foreground")} />
              <span className="flex-1 font-mono text-xs font-semibold">{option}</span>
              {picked && <Check aria-hidden className="size-4 shrink-0" />}
            </span>
            <span className="mt-1 line-clamp-2 block pl-6 text-xs text-muted-foreground">{ROLE_SUMMARIES[option]}</span>
          </button>
        );
      })}
    </div>
  );
}

const PR_BADGE: Record<"merged" | "open" | "closed", string> = {
  merged: "Merged",
  open: "Waiting to merge",
  closed: "Closed unmerged",
};

const BADGE_TONE: Record<Tone, string> = {
  good: "border-status-good/45 bg-status-good/10 text-status-good",
  warn: "border-status-warn/45 bg-status-warn/10 text-status-warn",
  bad: "border-status-bad/45 bg-status-bad/10 text-status-bad",
  info: "border-status-info/45 bg-status-info/10 text-status-info",
  neutral: "border-border bg-muted/20 text-muted-foreground",
};

/**
 * The roster PR step as one status card: the PR and its state, what Start
 * will do about it, and — while it waits — that the card refreshes itself,
 * with a Refresh for whoever just merged and will not wait for the poll.
 * "Merged" follows the agent's status, not the PR's own state: the base
 * branch naming the agent is what lets Start through.
 */
function RosterPrCard({
  name,
  base,
  status,
  card,
  refreshing,
  onRefresh,
}: {
  name: string;
  base: string;
  status: PendingAgentView["status"];
  card: PendingCard;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const merged = status === "ready";
  const state = merged ? "merged" : card.pr?.state === "closed" ? "closed" : "open";
  const Icon = merged ? GitMerge : GitPullRequest;
  return (
    <div className="border">
      <div className="flex items-center gap-3 border-b px-3.5 py-3">
        <Icon aria-hidden className={cn("size-4.5 shrink-0", TONE_TEXT[card.tone])} />
        <div className="min-w-0 flex-1">
          {card.pr === null ? (
            <p className="text-sm font-semibold">No roster PR found for {name}</p>
          ) : (
            <a href={card.pr.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold hover:underline">
              {card.pr.title}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
          <p className="font-mono text-xs text-muted-foreground">
            {merged ? `${name} is on ${base}'s roster` : `adds ${name} to ${base}'s roster`}
          </p>
        </div>
        {(card.pr !== null || merged) && (
          <span className={cn("border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase", BADGE_TONE[card.tone])}>
            {PR_BADGE[state]}
          </span>
        )}
      </div>
      <p className="px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">{card.startHint}</p>
      {!merged && (
        <p className="flex items-center gap-2 border-t px-3.5 py-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-status-info" />
          <span className="flex-1">Checking every few seconds · you can close this and come back from {name}'s setup card</span>
          {/* Never disabled: the poll keeps a read out most of the time, and a click then is still a fresh ask. */}
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRefresh}>
            <RotateCw aria-hidden className={cn("size-3.5", refreshing && "animate-spin")} />
            Refresh
          </Button>
        </p>
      )}
    </div>
  );
}

/** One thing Create agent makes, as a titled row with its glyph. */
function CreateItem({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-3 border-b px-3 py-2.5 last:border-b-0">
      <span className="flex size-8 items-center justify-center border text-muted-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function FlowSteps({ step }: { step: FlowStep }) {
  const at = FLOW_STEPS.indexOf(step);
  return (
    <ol className="flex gap-1" aria-label="Steps">
      {FLOW_STEPS.map((each, index) => (
        <li
          key={each}
          aria-current={index === at ? "step" : undefined}
          className={cn("flex-1 text-[11px] text-muted-foreground", index === at && "font-semibold text-foreground")}
        >
          <span className={cn("mb-1 block h-0.5 rounded-full bg-border", index <= at && "bg-foreground")} />
          {index + 1} {FLOW_STEP_LABELS[each]}
        </li>
      ))}
    </ol>
  );
}

/** What is open: a fresh Add agent, or the setup of an agent that exists already. */
type FlowTarget = { kind: "new" } | { kind: "resume"; name: string };

/**
 * Add agent, as one dialog: name and role, a review of what Create makes, the
 * roster PR, then readiness and Start.
 *
 * Only the first two steps hold state of their own. From Create on, the agent
 * is a worktree the server lists under `pending`, so the later steps paint the
 * polled view and closing the dialog loses nothing: the agent's setup card
 * reopens it at `resumeStep`.
 */
function AddAgentFlow({
  target,
  view,
  refreshing,
  onClose,
  onChanged,
}: {
  target: FlowTarget;
  view: AgentsView | null;
  /** A read of the agents view is out: the roster PR step's Refresh spins meanwhile. */
  refreshing: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<FlowStep>(() => {
    if (target.kind === "new") return "name";
    const agent = view?.pending.find((each) => each.name === target.name);
    return agent === undefined ? "pr" : resumeStep(agent);
  });
  const [name, setName] = useState(target.kind === "resume" ? target.name : "");
  const [role, setRole] = useState<LoopRole>("coder");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Said | null>(null);
  // The last Add agent answer's setup run, painted under its notice.
  const [setup, setSetup] = useState<WorktreeSetupRecord | null>(null);
  const [guide, setGuide] = useState(false);
  const adding = useCommand("/api/agents");
  const starting = useCommand("/api/agents/start");
  const problem = agentNameProblem(name);
  const agent = view?.pending.find((each) => each.name === name) ?? null;
  const card = agent === null ? null : pendingCard(agent);
  const base = view?.baseBranch ?? "the base branch";

  const create = async () => {
    setBusy(true);
    setSetup(null);
    const result = await adding.send<AddAgentResult>({ name, role });
    setBusy(false);
    if (!result.ok) {
      setNotice(shown(result.error));
      return;
    }
    // An empty answer says nothing to paint; the poll shows what happened.
    if (result.value === null) {
      setNotice(null);
      onChanged();
      return;
    }
    setNotice(addNotice(result.value));
    setSetup(result.value.setup);
    onChanged();
    // A refusal created nothing, so the review stays up with the reason.
    if (result.value.outcome !== "refused") setStep("pr");
  };

  const start = async () => {
    setBusy(true);
    // Relayed on the remote page: the module follows it, and `starting.queued` says so meanwhile.
    const result = await starting.send<StartResult>({ name });
    setBusy(false);
    if (!result.ok) {
      setNotice(shown(result.error));
      return;
    }
    setNotice(result.value === null ? null : startNotice(result.value));
    onChanged();
  };

  const go = (next: FlowStep) => {
    setNotice(null);
    setStep(next);
  };

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="gap-4 sm:max-w-xl">
          {/* Clear of the dialog's close button, which sits over the top-right corner. */}
          <DialogHeader className="pr-10">
            <DialogTitle>{step === "name" || step === "review" ? `Add an agent to ${view?.project ?? "this project"}` : `Setting up ${name}`}</DialogTitle>
            <DialogDescription className="sr-only">Add a new agent, step by step.</DialogDescription>
            <FlowSteps step={step} />
          </DialogHeader>

          <div className="min-h-56 space-y-3">
            {step === "name" && (
              <form
                id="add-agent-name"
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (problem === null) go("review");
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="new-agent-name">Name</Label>
                  <Input
                    id="new-agent-name"
                    autoFocus
                    placeholder="one lowercase word"
                    className="font-mono"
                    value={name}
                    onChange={(event) => setName(event.target.value.trim())}
                    aria-invalid={name !== "" && problem !== null}
                  />
                  {name !== "" && problem !== null ? (
                    <p className="text-xs text-status-bad">{problem}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      One lowercase word. It names the agent, its worktree and its{" "}
                      <code className="font-mono text-foreground/85">{name === "" ? "<name>" : name}-wip</code> claim label.
                    </p>
                  )}
                </div>
                <div className="space-y-1.5 pt-2">
                  <Label>Role</Label>
                  <p className="text-xs text-muted-foreground">Hard to undo once the roster PR merges, so each role says what it does.</p>
                  <RolePicker role={role} onPick={setRole} />
                </div>
              </form>
            )}

            {step === "review" && (
              <>
                <p className="text-xs text-muted-foreground">
                  Nothing has been created yet. <span className="font-semibold text-foreground">Create agent</span> does these
                  three things:
                </p>
                <ol className="border" aria-label="What Create agent makes">
                  <CreateItem icon={FolderPlus} title="Worktree">
                    <span className="font-mono">{name}</span>'s checkout at the workspace path, detached at{" "}
                    <span className="font-mono">{base}</span>, with its <code className="font-mono">.ralph/loop-name</code> and log
                    directory.
                  </CreateItem>
                  <CreateItem icon={GitPullRequest} title="Roster PR">
                    Adds <span className="font-mono">{name}</span> as a <span className="font-mono">{role}</span> to the project's{" "}
                    <code className="font-mono">loops</code>.
                  </CreateItem>
                  <CreateItem icon={Tag} title="Labels">
                    The labels its role needs. Preflight refuses to start an agent that has none.
                  </CreateItem>
                </ol>
                <p className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                  From here on the agent has a setup card on the Agents page, so you can close this dialog at any step and pick it
                  up from there.
                </p>
              </>
            )}

            {step === "pr" && (
              <>
                {agent === null ? (
                  <p className="text-sm text-muted-foreground">Reading {name}'s worktree…</p>
                ) : (
                  <RosterPrCard name={name} base={base} status={agent.status} card={card!} refreshing={refreshing} onRefresh={onChanged} />
                )}
              </>
            )}

            {step === "ready" && (
              <>
                {agent === null ? (
                  <p className="text-sm text-muted-foreground">
                    {name} is no longer listed as a new agent; it shows on the Agents page once its supervisor runs.
                  </p>
                ) : (
                  <>
                    <Readiness lines={card!.readiness} counted />
                    <PreflightCheck name={name} />
                    <p className="text-xs text-muted-foreground">Warnings do not block Start; a failing preflight does.</p>
                  </>
                )}
              </>
            )}

            {starting.queued && <p className="text-xs text-muted-foreground">{RELAY_QUEUED}…</p>}
            {notice && <Answer notice={notice} />}
            <SetupSteps record={setup} />
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <Button variant="ghost" size="sm" onClick={() => setGuide(true)}>
              <BookOpen className="size-3.5" />
              Manual steps
            </Button>
            <span className="flex flex-wrap items-center justify-end gap-2">
              <LocalOnlyNote route="/api/agents" />
              {step === "review" && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => go("name")}>
                  Back
                </Button>
              )}
              {step === "ready" && (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => go("pr")}>
                  Back
                </Button>
              )}
              {step === "name" && (
                <Button type="submit" form="add-agent-name" size="sm" disabled={problem !== null}>
                  Next
                </Button>
              )}
              {step === "review" && (
                <Button
                  size="sm"
                  disabled={busy || adding.disabled}
                  title={adding.disabled ? (adding.why ?? undefined) : undefined}
                  onClick={() => void create()}
                >
                  <Plus className="size-3.5" />
                  {busy ? "Creating…" : "Create agent"}
                </Button>
              )}
              {step === "pr" && (
                // Not gated on the poll: Start fetches the base branch afresh,
                // so a merge the last read missed still unlocks it.
                <Button size="sm" variant={agent?.status === "ready" ? "default" : "outline"} onClick={() => go("ready")}>
                  {agent?.status === "ready" ? "Next" : "Continue anyway"}
                </Button>
              )}
              {step === "ready" && (
                <Button
                  size="sm"
                  disabled={busy || agent === null || starting.disabled}
                  title={starting.disabled ? (starting.why ?? undefined) : undefined}
                  onClick={() => void start()}
                >
                  <Play className="size-3.5" />
                  {busy ? "Starting…" : `Start ${name}`}
                </Button>
              )}
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet open={guide} onOpenChange={setGuide}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Manual steps</SheetTitle>
            <SheetDescription>What Add agent automates, step by step, with this project's values.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <AgentGuide name={name === "" || problem !== null ? null : name} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The agents page's Add agent button, and a setup card for each agent its
 * roster does not list yet. Both open the Add agent dialog: the button fresh,
 * a card at the step its agent has reached.
 */
export function AgentsAdmin({ onChanged }: { onChanged: () => void }) {
  const agents = useAgents();
  // A failed read keeps the last roster on screen, and says it is stale.
  const view = agents.read.state === "loading" ? null : agents.read.data;
  const unreadable = agents.read.state === "error" ? agents.read.message : null;
  const { refresh } = agents;
  const [flow, setFlow] = useState<FlowTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, Said>>({});
  const adding = useCommandAvailability("/api/agents");
  const deleting = useCommand("/api/agents/delete");
  const changed = useCallback(() => {
    refresh();
    onChanged();
  }, [refresh, onChanged]);
  const remove = async (name: string) => {
    setBusy(name);
    const result = await deleting.send<DeleteAgentResult>({ name, confirm: true });
    const notice = !result.ok ? shown(result.error) : result.value === null ? null : deleteNotice(result.value);
    setNotices((current) => {
      const { [name]: _old, ...rest } = current;
      return notice === null ? rest : { ...rest, [name]: notice };
    });
    setBusy(null);
    changed();
  };

  return (
    <section className="space-y-3" aria-label="Add and set up agents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Right-click an agent for actions.</p>
        <span className="flex items-center gap-2">
          <LocalOnlyNote route="/api/agents" />
          <Button
            size="sm"
            disabled={adding.disabled}
            title={adding.disabled ? (adding.why ?? undefined) : undefined}
            onClick={() => setFlow({ kind: "new" })}
          >
            <Plus className="size-3.5" />
            Add agent
          </Button>
        </span>
      </div>
      {unreadable !== null && <p className="text-xs text-muted-foreground">The agents could not be read: {unreadable}</p>}
      {view?.problem && <p className="text-xs text-muted-foreground">{view.problem}</p>}
      {view !== null && view.pending.length > 0 && (
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Agents being set up">
          {view.pending.map((agent) => {
            const card = pendingCard(agent);
            return (
              <div key={agent.name} className="space-y-3 rounded-xl border border-dashed bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold">{agent.name}</span>
                  <span className="flex items-center gap-2">
                    {/* The count before the list: whether there is anything
                        to work through, without opening the dialog. */}
                    {card.readiness.length > 0 && (
                      <span className={cn("text-xs", card.outstanding === 0 ? TONE_TEXT.good : TONE_TEXT.warn)}>
                        {card.outstanding === 0
                          ? `all ${card.readiness.length} checks pass`
                          : `${card.outstanding} of ${card.readiness.length} outstanding`}
                      </span>
                    )}
                    <Badge variant="outline" className={TONE_TEXT[card.tone]}>
                      {card.badge}
                    </Badge>
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {agent.role ?? "role unknown"} · setting up
                </p>
                {card.pr && (
                  <a href={card.pr.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-status-info hover:underline">
                    <GitPullRequest className="size-3.5" />
                    {card.pr.label}
                    <ExternalLink className="size-3" />
                  </a>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => setFlow({ kind: "resume", name: agent.name })}>
                    Resume setup
                  </Button>
                  <Confirming
                    label="Delete worktree…"
                    confirm={`Delete ${agent.name}'s worktree`}
                    busy={busy !== null || deleting.disabled}
                    why={deleting.why}
                    onConfirm={() => void remove(agent.name)}
                  />
                </div>
                {notices[agent.name] && <Answer notice={notices[agent.name]!} />}
                {/* A pending agent has never been started, so it cannot be
                    running: the setup a failed Add agent left is rerun here. */}
                <RerunAgentSetup loop={agent.name} live={false} onDone={changed} />
              </div>
            );
          })}
        </div>
      )}
      {flow !== null && (
        <AddAgentFlow
          key={flow.kind === "new" ? "new" : flow.name}
          target={flow}
          view={view}
          refreshing={agents.busy}
          onClose={() => setFlow(null)}
          onChanged={changed}
        />
      )}
    </section>
  );
}

/**
 * Give a roster loop the checkout it has none of, from its page — the case a
 * project onboarded through the dashboard leaves behind, where every name in
 * `loops` came from the setup PR and Add agent refuses it for being on the
 * roster already (felipearos/ralph#189).
 *
 * One click, not two: it creates a worktree and removes nothing.
 */
export function CreateAgentCheckout({ loop, onCreated }: { loop: string; onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Said | null>(null);
  const [setup, setSetup] = useState<WorktreeSetupRecord | null>(null);
  const command = useCommand("/api/agents/checkout");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Makes {loop}'s worktree at the workspace path, detached at the project's base branch, with its{" "}
        <code>.ralph/loop-name</code> and log directory — the same checkout Add agent makes. No roster PR: {loop} is on
        the roster already.
      </p>
      <Button
        size="sm"
        disabled={busy || command.disabled}
        title={command.disabled ? (command.why ?? undefined) : undefined}
        onClick={async () => {
          setBusy(true);
          setSetup(null);
          const result = await command.send<CreateCheckoutResult>({ name: loop });
          setBusy(false);
          if (!result.ok) {
            setNotice(shown(result.error));
            return;
          }
          setNotice(result.value === null ? null : checkoutNotice(result.value));
          setSetup(result.value?.setup ?? null);
          onCreated();
        }}
      >
        <FolderPlus className="size-3.5" />
        {busy ? "Creating checkout…" : "Create checkout"}
      </Button>
      <LocalOnlyNote route="/api/agents/checkout" className="ml-2" />
      {notice && <Answer notice={notice} />}
      <SetupSteps record={setup} />
    </div>
  );
}

/**
 * Re-run the project's worktree setup steps in a roster loop's worktree, from
 * its page — for a setup that stopped, once whatever stopped it is fixed. The
 * server refuses while its supervisor runs: the steps install into the
 * worktree it is working in.
 */
export function RerunAgentSetup({ loop, live, onDone }: { loop: string; live: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Said | null>(null);
  const [setup, setSetup] = useState<WorktreeSetupRecord | null>(null);
  const command = useCommand("/api/agents/setup");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Runs the project's worktree setup steps again in {loop}'s worktree, in order, stopping at the first one that does
        not pass. Refused while its supervisor runs.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || live || command.disabled}
        title={command.disabled ? (command.why ?? undefined) : live ? `Stop ${loop} first.` : undefined}
        onClick={async () => {
          setBusy(true);
          setSetup(null);
          const result = await command.send<RerunSetupResult>({ name: loop });
          setBusy(false);
          if (!result.ok) {
            setNotice(shown(result.error));
            return;
          }
          setNotice(result.value === null ? null : rerunNotice(result.value));
          setSetup(result.value?.setup ?? null);
          onDone();
        }}
      >
        <RotateCw className="size-3.5" />
        {busy ? "Running setup…" : "Rerun setup"}
      </Button>
      <LocalOnlyNote route="/api/agents/setup" className="ml-2" />
      {live && <p className="text-xs text-muted-foreground">Stop {loop} first.</p>}
      {notice && <Answer notice={notice} />}
      <SetupSteps record={setup} />
    </div>
  );
}

/** Delete a roster loop's worktree, from its page. The server refuses while its supervisor runs. */
export function DeleteAgentWorktree({ loop, live, onDeleted }: { loop: string; live: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Said | null>(null);
  const command = useCommand("/api/agents/delete");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Removes this agent's worktree with <code>git worktree remove</code>, which refuses one with changes in it, and
        opens a PR taking {loop} out of the project's <code>loops</code>. Refused while its supervisor runs.
      </p>
      <Confirming
        label="Delete agent worktree…"
        confirm={`Delete ${loop}'s worktree`}
        busy={busy || live || command.disabled}
        why={command.why}
        onConfirm={async () => {
          setBusy(true);
          const result = await command.send<DeleteAgentResult>({ name: loop, confirm: true });
          setBusy(false);
          if (!result.ok) {
            setNotice(shown(result.error));
            return;
          }
          setNotice(result.value === null ? null : deleteNotice(result.value));
          onDeleted();
        }}
      />
      <LocalOnlyNote route="/api/agents/delete" />
      {live && <p className="text-xs text-muted-foreground">Stop {loop} first.</p>}
      {notice && <Answer notice={notice} />}
    </div>
  );
}

/** Unregister the project. Nothing on disk, in its worktrees or on GitHub is touched. */
export function RemoveProject({ project }: { project: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Said | null>(null);
  // Top-level: the module addresses it without the project scope.
  const command = useCommand("/api/projects/remove");
  return (
    <section className="space-y-2" aria-label="Remove project">
      <p className="text-sm text-muted-foreground">
        Remove <span className="font-mono">{project}</span> from the dashboard. Only the project registry changes: its
        checkout, worktrees and GitHub repo stay as they are. Refused while any of its agents runs.
      </p>
      <Confirming
        label="Remove project…"
        confirm={`Remove ${project}`}
        busy={busy || command.disabled}
        why={command.why}
        onConfirm={async () => {
          setBusy(true);
          const result = await command.send<RemoveProjectResult>({ project, confirm: true });
          setBusy(false);
          if (!result.ok) {
            setNotice(shown(result.error));
            return;
          }
          if (result.value === null) {
            setNotice(null);
            return;
          }
          setNotice(removeNotice(result.value));
          if (result.value.outcome === "removed") window.location.assign("/");
        }}
      />
      <LocalOnlyNote route="/api/projects/remove" />
      {notice && <Answer notice={notice} />}
    </section>
  );
}
