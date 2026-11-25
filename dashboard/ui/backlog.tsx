/**
 * The project's backlog, as the loops' own frontier buckets it: what a loop
 * would start now, what waits behind that pick, what is in flight and under
 * whose claim, and what is blocked and by which ticket.
 *
 * It is the same picture `bun ~/ralph/frontier/next.ts -- --dry-run` prints,
 * read by the dashboard and drawn here. The picture is a read: nothing on
 * this panel claims, and a stale or unreadable read says so rather than
 * showing an empty backlog.
 */
import { createContext, useContext, useEffect, useId, useState } from "react";
import { CircleAlert, GitMerge, GitPullRequest, GitPullRequestDraft, Loader2, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  DashboardLoop,
  FrontierRead,
  FrontierTicket,
  FrontierTreeGroup,
  FrontierTreeNode,
  FrontierDroppedReference,
  FrontierView,
  HumanReason,
  PullState,
  PullStatusView,
  StuckReason,
  TreeState,
} from "../contracts";
import { noStuckGroups, parkLive, parkText, stuckGroups, stuckReasonsByNumber, stuckWord } from "./blocked-model";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { IssueLink, PullLink } from "./label";
import { Tip } from "./tip";
import { Talk } from "./chat";
import { blockingLoop } from "./chat-model";
import {
  type BacklogLoop,
  droppedByNumber,
  droppedTip,
  droppedWord,
  forPerson,
  forYouRows,
  inFlightTip,
  runningTickets,
  since,
  staleNote,
  stuckTip,
} from "./backlog-model";

/* ------------------------------------------------------------- primitives */

/**
 * A stuck ticket's chip. A migration block is a different colour and says what
 * it needs, because it is the one a person can clear in minutes; a flake block
 * is the ci-doctor's and reads as muted, because it is the one nobody here has
 * to act on; any other block keeps the loop's label in the warning colour.
 * A park outranks the kind, as it does in `stuckWord`: a live one reads muted
 * like the doctor's flake, because a probe watches it and nobody here has to
 * act yet; a spent one is a person's again and reads in the warning colour.
 * Hovering shows the reason the loop wrote.
 */
const stuckTint = (reason: StuckReason | undefined, nowMs: number): string =>
  reason?.park
    ? parkLive(reason.park, nowMs)
      ? "border-border bg-muted/40 text-muted-foreground"
      : "border-status-warn/30 bg-status-warn/10 text-status-warn"
    : reason?.kind === "migration"
    ? "border-status-info/30 bg-status-info/10 text-status-info"
    : reason?.kind === "ci-flake"
      ? "border-border bg-muted/40 text-muted-foreground"
      : "border-status-warn/30 bg-status-warn/10 text-status-warn";

/**
 * What every row's hover text measures against and reads from: the time the
 * dashboard read the loops, the loops themselves, and the claimed tickets.
 * One context instead of three props threaded through the tree's recursion.
 */
interface BacklogClock {
  nowMs: number;
  loops: readonly BacklogLoop[];
  inFlight: Map<number, FrontierView["inFlight"][number]>;
  running: Set<number>;
  /** Each ticket's PR standing; null when it could not be read, which draws no PR state at all. */
  prs: Map<number, PullStatusView> | null;
  /** The anchor a count has just jumped to; the Section with that id opens. */
  jump?: string | null;
}
const Clock = createContext<BacklogClock>({ nowMs: 0, loops: [], inFlight: new Map(), running: new Set(), prs: null });

/**
 * A PR's standing in the colours a reader already knows from GitHub and CI:
 * purple merged, green ready (or merging), yellow still being tested, red
 * failing. The word says it too, so the colour is never the only signal.
 */
const PULL_LOOK: Record<PullState, { word: string; why: string; tone: string }> = {
  merged: { word: "merged", why: "merged", tone: "border-status-done/40 bg-status-done/10 text-status-done" },
  queued: {
    word: "merging",
    why: "green and in the merge queue",
    tone: "border-status-good/40 bg-status-good/10 text-status-good",
  },
  green: {
    word: "ready to merge",
    why: "every check passed",
    tone: "border-status-good/40 bg-status-good/10 text-status-good",
  },
  testing: { word: "testing", why: "checks are still running", tone: "border-status-warn/40 bg-status-warn/10 text-status-warn" },
  failing: { word: "failing", why: "a check failed", tone: "border-status-bad/40 bg-status-bad/10 text-status-bad" },
  open: { word: "no checks", why: "no check has reported yet", tone: "border-border text-muted-foreground" },
};

function PullChip({ pull, repoUrl }: { pull: PullStatusView; repoUrl: string | null }) {
  const look = PULL_LOOK[pull.state];
  const Icon = pull.state === "merged" ? GitMerge : pull.draft ? GitPullRequestDraft : GitPullRequest;
  const body = (
    <>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span>#{pull.pr}</span>
      <span>{pull.draft ? `draft · ${look.word}` : look.word}</span>
    </>
  );
  const className = cn(
    "inline-flex shrink-0 items-center gap-1 self-center rounded border px-1 font-mono text-[10px] leading-4 whitespace-nowrap",
    look.tone,
    pull.draft && "opacity-80",
  );
  const title = `PR #${pull.pr}${pull.draft ? " (draft)" : ""}: ${look.why}`;
  if (repoUrl === null) {
    return (
      <Tip content={title}>
        <span className={className}>{body}</span>
      </Tip>
    );
  }
  return (
    <Tip content={title}>
      <a href={`${repoUrl}/pull/${pull.pr}`} target="_blank" rel="noreferrer" className={cn(className, "hover:brightness-125")}>
        {body}
      </a>
    </Tip>
  );
}

/** A ticket's PR chip, when its PR standing is known. */
function TicketPull({ ticket, repoUrl }: { ticket: number; repoUrl: string | null }) {
  const pull = useContext(Clock).prs?.get(ticket);
  return pull === undefined ? null : <PullChip pull={pull} repoUrl={repoUrl} />;
}

/**
 * A ticket that waits on the operator rather than a loop. One neutral, strong
 * chip for every reason — the point is to separate "mine" from "theirs" at a
 * glance — with the reason in the word and the longer why on hover.
 */
const HUMAN_WORD: Record<HumanReason, string> = {
  "ready-for-human": "for you",
  "needs-info": "needs info",
  held: "held by plan",
  untriaged: "to triage",
};

const HUMAN_TITLE: Record<HumanReason, string> = {
  "ready-for-human": "Labelled ready-for-human: a person's job, not a loop's.",
  "needs-info": "Labelled needs-info: waiting on an answer before anyone can start.",
  held: "Listed under Out of scope in plan.md: every loop skips it until the hold is lifted.",
  untriaged: "No triage label yet, and no triager runs: label it ready-for-agent or ready-for-human.",
};

function HumanChip({ reason }: { reason: HumanReason }) {
  return (
    <Tip content={HUMAN_TITLE[reason]}>
      <span className="shrink-0 rounded border border-foreground/40 bg-foreground/10 px-1 font-mono text-[10px] whitespace-nowrap text-foreground">
        {HUMAN_WORD[reason]}
      </span>
    </Tip>
  );
}

/**
 * A ticket with a `## Blocked by` / `## Parent` reference the frontier does not
 * count as an edge (another repository's or tracker's): without this it would
 * read as unblocked with no hint why it may not be.
 */
function DroppedChip({ references }: { references: FrontierDroppedReference[] }) {
  return (
    <Tip content={droppedTip(references)}>
      <span className="shrink-0 rounded border border-status-warn/40 bg-status-warn/10 px-1 font-mono text-[10px] whitespace-nowrap text-status-warn">
        {droppedWord(references)}
      </span>
    </Tip>
  );
}

/** A For you row that is there because its block reason says a person must act. */
function StuckForYouChip({ reason }: { reason: StuckReason }) {
  const { nowMs } = useContext(Clock);
  return (
    <Tip content={stuckTip(reason, nowMs)}>
      <span className="shrink-0 rounded border border-status-warn/40 bg-status-warn/10 px-1 font-mono text-[10px] whitespace-nowrap text-status-warn">
        stuck · needs you
      </span>
    </Tip>
  );
}

/**
 * The left-hand mark of a ticket that waits on the operator: a person, in the
 * page's strongest neutral like the "for you" chip, so "mine" stands out from
 * the grey open dots without borrowing a colour that already means something.
 */
const YouMark = () => (
  <UserRound className="inline size-3 text-foreground" strokeWidth={2.5} aria-label="waits on you" />
);

const humanByNumber = (view: FrontierView): Map<number, HumanReason> =>
  new Map(view.human.map((ticket) => [ticket.number, ticket.reason]));

const Quiet = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

/** The backlog below is the last census that read; its reason shows on hover. */
function StaleNote({ frontier }: { frontier: FrontierRead }) {
  const note = staleNote(frontier, (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
  if (note === null) return null;
  return (
    <Tip content={frontier.problem ?? "no reason was reported"}>
      <p className="flex items-center gap-1.5 text-xs text-status-warn">
        <CircleAlert className="size-3.5" />
        {note}
      </p>
    </Tip>
  );
}

/** A section's count, in the tone the bucket deserves. */
function Count({
  label,
  value,
  tone,
  onJump,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
  /** Scrolls to the rows the count counts; absent when nothing on the page lists them. */
  onJump?: () => void;
}) {
  const text = {
    good: "text-status-good",
    warn: "text-status-warn",
    bad: "text-status-bad",
    info: "text-status-info",
    neutral: "text-muted-foreground",
  }[tone];
  const body = (
    <>
      <span className={cn("text-2xl font-semibold tabular-nums tracking-tight", value > 0 && text)}>{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </>
  );
  // A zero has no rows to jump to, so it stays plain text.
  if (onJump === undefined || value === 0) return <div className="flex items-baseline gap-2">{body}</div>;
  return (
    <Tip content={`show the ${label} tickets`}>
      <Button
        type="button"
        variant="ghost"
        onClick={onJump}
        className="group/count -mx-1.5 flex h-auto items-baseline justify-start gap-2 rounded-md border-0 px-1.5 py-0 font-normal tracking-normal normal-case transition-colors hover:bg-muted/60 dark:hover:bg-muted/60 [&>span:last-child]:group-hover/count:text-foreground [&>span:last-child]:group-hover/count:underline"
      >
        {body}
      </Button>
    </Tip>
  );
}

function Section({
  id,
  title,
  detail,
  count,
  open = false,
  children,
}: {
  /** The anchor a count jumps to. */
  id?: string;
  title: string;
  detail: string;
  count: number;
  open?: boolean;
  children: React.ReactNode;
}) {
  const { jump } = useContext(Clock);
  const [shown, setShown] = useState(open);
  // A jump to this section opens it. A child's effects run before its
  // parent's, so it is open by the time the panel scrolls to it.
  useEffect(() => {
    if (id !== undefined && jump === id) setShown(true);
  }, [id, jump]);
  return (
    <Collapsible id={id} open={shown} onOpenChange={setShown} className="group scroll-mt-4 rounded-xl border">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-baseline gap-3 px-4 py-3 text-left select-none">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
        <span className="ml-auto text-xs text-muted-foreground group-data-[state=open]:hidden">show</span>
        <span className="ml-auto hidden text-xs text-muted-foreground group-data-[state=open]:inline">hide</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">{children}</CollapsibleContent>
    </Collapsible>
  );
}

const relative = (iso: string, nowMs: number): string => {
  const seconds = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
};

/* ------------------------------------------------------------------ ready */

function Ready({ view, repoUrl }: { view: FrontierView; repoUrl: string | null }) {
  const { nowMs } = useContext(Clock);
  const reasons = stuckReasonsByNumber(view);
  const human = humanByNumber(view);
  const dropped = droppedByNumber(view);
  if (view.ready.length === 0) {
    return (
      <div className="px-4 py-3">
        <Quiet>Nothing is ready. Every unblocked ticket is claimed, occupied or a spec.</Quiet>
      </div>
    );
  }
  return (
    <ul className="divide-y">
      {view.ready.map((group, index) => (
        <li key={group.spec?.number ?? `solo-${index}`} className="space-y-1.5 px-4 py-3">
          {group.spec && (
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{group.spec.title}</span>
              <span className="font-mono text-xs text-muted-foreground">
                <IssueLink repoUrl={repoUrl} issue={group.spec.number} />
              </span>
              {group.staffingGroup && <span className="text-xs text-muted-foreground">· {group.staffingGroup}</span>}
              {group.waiting > 0 && (
                <span className="text-xs text-muted-foreground">
                  · {group.waiting} sibling{group.waiting === 1 ? "" : "s"} behind this one
                </span>
              )}
            </p>
          )}
          {group.tickets.map((ticket) => (
            <p key={ticket.number} className={cn("flex items-baseline gap-2 text-sm", group.spec && "pl-4")}>
              <span className="font-mono text-xs text-status-good">
                <IssueLink repoUrl={repoUrl} issue={ticket.number} />
              </span>
              <span className="truncate" title={ticket.title}>
                {ticket.title}
              </span>
              {ticket.frees > 0 && (
                <span className="text-xs whitespace-nowrap text-muted-foreground">frees {ticket.frees}</span>
              )}
              {ticket.stuck && (
                <Tip content={stuckTip(reasons.get(ticket.number), nowMs)}>
                  <Badge variant="outline" className={stuckTint(reasons.get(ticket.number), nowMs)}>
                    {stuckWord(ticket.stuck, reasons.get(ticket.number), nowMs)}
                  </Badge>
                </Tip>
              )}
              {human.has(ticket.number) && <HumanChip reason={human.get(ticket.number)!} />}
              {dropped.has(ticket.number) && <DroppedChip references={dropped.get(ticket.number)!} />}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------- in flight */

function InFlight({ view, repoUrl }: { view: FrontierView; repoUrl: string | null }) {
  if (view.inFlight.length === 0) {
    return (
      <div className="px-4 py-3">
        <Quiet>No ticket is claimed.</Quiet>
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-20">Issue</TableHead>
          <TableHead className="w-24">Loop</TableHead>
          <TableHead className="w-40">Claim</TableHead>
          <TableHead className="w-36">PR</TableHead>
          <TableHead className="w-full">Title</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {view.inFlight.map((ticket) => (
          <TableRow key={ticket.number}>
            <TableCell className="font-mono text-xs">
              <span className="inline-flex items-center gap-1.5">
                <InFlightMark ticket={ticket.number} />
                <IssueLink repoUrl={repoUrl} issue={ticket.number} />
              </span>
            </TableCell>
            <TableCell>{ticket.loop ?? <span className="text-muted-foreground">—</span>}</TableCell>
            <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
              {ticket.claim}
              {!ticket.queued && " · off queue"}
            </TableCell>
            <TableCell>
              <TicketPull ticket={ticket.number} repoUrl={repoUrl} />
            </TableCell>
            <TableCell className="max-w-0 truncate" title={ticket.title}>
              {ticket.title}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ------------------------------------------------------- occupied/blocked */

function TicketRows({
  rows,
  repoUrl,
  note,
  empty,
  tone = "warn",
}: {
  rows: FrontierTicket[];
  repoUrl: string | null;
  note: (ticket: FrontierTicket) => React.ReactNode;
  empty: string;
  tone?: "warn" | "bad";
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-3">
        <Quiet>{empty}</Quiet>
      </div>
    );
  }
  return (
    <ul className="divide-y">
      {rows.map((ticket) => (
        <li
          key={ticket.number}
          className={cn("flex items-baseline gap-2 px-4 py-2 text-sm", tone === "bad" && "bg-status-bad/[0.06]")}
        >
          <span className={cn("font-mono text-xs", tone === "bad" ? "font-bold text-status-bad" : "text-status-warn")}>
            <IssueLink repoUrl={repoUrl} issue={ticket.number} />
          </span>
          <span className="truncate" title={ticket.title}>
            {ticket.title}
          </span>
          <span className="ml-auto inline-flex items-baseline gap-2">
            <TicketPull ticket={ticket.number} repoUrl={repoUrl} />
            <span className="text-xs whitespace-nowrap text-muted-foreground">{note(ticket)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const issues = (numbers: number[]): string => numbers.map((n) => `#${n}`).join(" ");

/* ------------------------------------------------------------------ stuck */

/**
 * Every ticket a loop gave up on, in the three groups an operator acts on
 * differently. A migration block shows the file to apply and the draft PR that
 * waits on it; a flake block is the ci-doctor's and wants nothing from anyone
 * here; any other block shows the reason the loop wrote, and is the only one of
 * the three that needs triage. A live park is a wait a probe watches, so it
 * gets its own muted panel and shows what it waits for instead of the reason.
 */
type StuckTone = "parked" | "migration" | "doctor" | "other";

/** A stuck row's Talk, when its block label names a loop on the roster. */
function StuckTalk({
  loop,
  ticket,
  loops,
  pushed,
}: {
  loop: string | null;
  ticket: number;
  loops: readonly Pick<DashboardLoop, "loop" | "supervisor">[];
  /** Nothing to its left takes the row's spare width, so it does. */
  pushed: boolean;
}) {
  if (loop === null) return null;
  const live = loops.find((entry) => entry.loop === loop)?.supervisor === "alive";
  return <Talk loop={loop} ticket={ticket} live={live} className={cn("shrink-0 self-center", pushed && "ml-auto")} />;
}

function Stuck({
  groups,
  repoUrl,
  view,
  loops,
  anchor,
}: {
  groups: ReturnType<typeof stuckGroups>;
  repoUrl: string | null;
  view: FrontierView;
  loops: readonly Pick<DashboardLoop, "loop" | "supervisor">[];
  /** The ids the counts jump to, per group. */
  anchor: (group: "migration" | "other") => string;
}) {
  const { nowMs, prs } = useContext(Clock);
  // The block names its PR; its standing is looked up by PR, not by ticket,
  // because that is the PR the reason is about.
  const pullOf = (pr: number): PullStatusView | undefined => [...(prs?.values() ?? [])].find((pull) => pull.pr === pr);
  if (
    groups.parked.length === 0 &&
    groups.migration.length === 0 &&
    groups.doctor.length === 0 &&
    groups.other.length === 0
  )
    return null;
  // One tone argument rather than a boolean per group: two booleans that can
  // disagree make an edit to the wrong one a silent change, which is the
  // argument `contracts.ts` makes about `RolePanels`.
  const NUMBER_TONE: Record<StuckTone, string> = {
    parked: "text-muted-foreground",
    migration: "text-status-info",
    doctor: "text-muted-foreground",
    other: "text-status-warn",
  };
  // The row's Talk opens a chat with the loop whose block label the ticket
  // wears (`blockingLoop`), about this ticket.
  const roster = loops.map((entry) => entry.loop);
  const talkTo = (ticket: number): string | null => blockingLoop(view, ticket, roster);
  const rows = (reasons: StuckReason[], tone: StuckTone) => (
    <ul className="divide-y">
      {reasons.map((reason) => (
        <li key={reason.number} className="space-y-0.5 px-4 py-2 text-sm">
          <p className="flex items-baseline gap-2">
            <span className={cn("font-mono text-xs", NUMBER_TONE[tone])}>
              <IssueLink repoUrl={repoUrl} issue={reason.number} />
            </span>
            <span className="truncate" title={reason.title}>
              {reason.title}
            </span>
            {forPerson(reason, nowMs) && (
              <Tip content="A person has to act on this one; it is listed under For you too.">
                <span className="shrink-0 rounded border border-foreground/40 bg-foreground/10 px-1 font-mono text-[10px] text-foreground">
                  for you
                </span>
              </Tip>
            )}
            {reason.pr !== null && (
              <span className="ml-auto inline-flex shrink-0 font-mono text-xs text-muted-foreground">
                {pullOf(reason.pr) ? (
                  <PullChip pull={pullOf(reason.pr)!} repoUrl={repoUrl} />
                ) : (
                  <PullLink repoUrl={repoUrl} pr={reason.pr} />
                )}
              </span>
            )}
            <StuckTalk loop={talkTo(reason.number)} ticket={reason.number} loops={loops} pushed={reason.pr === null} />
          </p>
          {/* A spent park in another group names the condition that never
              held, above the block reason, so the operator sees what the
              wait was for before deciding what to do. */}
          {tone !== "parked" && reason.park !== null && (
            <p className="text-xs leading-5 break-words text-status-warn">{parkText(reason.park, nowMs)}</p>
          )}
          {tone === "parked" && reason.park !== null ? (
            // Wrapped, not truncated, like the reason it stands in for: what
            // the probe waits for and how long it has left is the whole row.
            <p className="text-xs leading-5 break-words text-muted-foreground">{parkText(reason.park, nowMs)}</p>
          ) : tone === "migration" && reason.migration !== null ? (
            <p className="text-xs text-muted-foreground">
              apply <code className="font-mono text-foreground">{reason.migration}</code>
              {reason.pr !== null && <> · the draft PR waits on it</>}
            </p>
          ) : (
            // Wrapped, not truncated: the reason is what the operator acts on,
            // and the panel already says these are blocked.
            <Tip content={since(reason.at, nowMs) === null ? null : `stuck for ${since(reason.at, nowMs)}`}>
              <p className="w-fit text-xs leading-5 break-words text-foreground/80">
                {reason.reason === null ? (
                  <span className="text-muted-foreground">No block reason found on the ticket.</span>
                ) : (
                  reason.reason.replace(/^blocked:\s*/i, "")
                )}
              </p>
            </Tip>
          )}
        </li>
      ))}
    </ul>
  );
  // As many columns as groups on show, so a lone group gets the full width
  // its reasons need instead of a third of it.
  const shown = [groups.parked, groups.migration, groups.doctor, groups.other].filter((group) => group.length > 0).length;
  return (
    <div className={cn("grid grid-cols-1 gap-3", shown >= 2 && "md:grid-cols-2", shown >= 3 && "xl:grid-cols-3")}>
      {groups.migration.length > 0 && (
        <div id={anchor("migration")} className="scroll-mt-4 rounded-xl border border-status-info/30">
          <p className="flex items-baseline gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">Needs a migration</span>
            <span className="text-xs tabular-nums text-muted-foreground">{groups.migration.length}</span>
            <span className="text-xs text-muted-foreground">code is done; a person applies the migration</span>
          </p>
          {rows(groups.migration, "migration")}
        </div>
      )}
      {groups.parked.length > 0 && (
        <div className="rounded-xl border">
          <p className="flex items-baseline gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">Parked on a wake condition</span>
            <span className="text-xs tabular-nums text-muted-foreground">{groups.parked.length}</span>
            <span className="text-xs text-muted-foreground">a probe watches it; nobody has to act yet</span>
          </p>
          {rows(groups.parked, "parked")}
        </div>
      )}
      {groups.doctor.length > 0 && (
        <div className="rounded-xl border">
          <p className="flex items-baseline gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">Waiting on the ci-doctor</span>
            <span className="text-xs tabular-nums text-muted-foreground">{groups.doctor.length}</span>
            <span className="text-xs text-muted-foreground">parked on a flaky test; the doctor unparks it</span>
          </p>
          {rows(groups.doctor, "doctor")}
        </div>
      )}
      {groups.other.length > 0 && (
        <div id={anchor("other")} className="scroll-mt-4 rounded-xl border border-status-warn/30">
          <p className="flex items-baseline gap-3 border-b px-4 py-3">
            <span className="text-sm font-medium">Stuck for another reason</span>
            <span className="text-xs tabular-nums text-muted-foreground">{groups.other.length}</span>
            <span className="text-xs text-muted-foreground">needs triage</span>
          </p>
          {rows(groups.other, "other")}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- tree */

/** The terminal's marks, so the page and `--tree` read the same. */
const STATE_MARK: Record<TreeState, string> = {
  done: "✔",
  ready: "★",
  "in-flight": "●",
  occupied: "◐",
  blocked: "○",
  open: "·",
};

const STATE_TEXT: Record<TreeState, string> = {
  done: "text-status-done",
  ready: "text-status-good",
  "in-flight": "text-status-info",
  occupied: "text-muted-foreground",
  blocked: "text-status-bad font-bold",
  open: "text-muted-foreground",
};

const STATE_WORD: Record<TreeState, string> = {
  done: "done",
  ready: "ready",
  "in-flight": "in flight",
  occupied: "occupied",
  blocked: "blocked",
  open: "open",
};

/**
 * An in-flight ticket's mark: a spinner while its loop runs, the still dot
 * when it does not. Hovering says who holds it, for how long and what the
 * loop is doing on it.
 */
function InFlightMark({ ticket }: { ticket: number }) {
  const { nowMs, loops, inFlight, running } = useContext(Clock);
  const claimed = inFlight.get(ticket);
  const tip = claimed === undefined ? undefined : inFlightTip(claimed, loops, nowMs);
  return running.has(ticket) ? (
    <Tip content={tip}>
      <span className="inline-flex">
        <Loader2 className="size-3 text-status-info motion-safe:animate-spin" aria-label="running" />
      </span>
    </Tip>
  ) : (
    <Tip content={tip ?? "claimed, but its loop is not running"}>
      <span className="text-muted-foreground">{STATE_MARK["in-flight"]}</span>
    </Tip>
  );
}

/** A ticket whose PR is in the merge queue; it pulses while a loop still runs it. */
function MergingMark({ ticket }: { ticket: number }) {
  const { running } = useContext(Clock);
  return (
    <GitMerge
      className={cn("inline size-3 text-status-good", running.has(ticket) && "motion-safe:animate-pulse")}
      aria-label="merging"
    />
  );
}

/**
 * The tree guides, as borders rather than box characters: a glyph is shorter
 * than its line box, so `│` printed row after row leaves gaps. A border on a
 * column that stretches to the row's full height joins seamlessly with the
 * row above and below.
 */
function Guides({ guides, last, held }: { guides: boolean[]; last: boolean; held: boolean }) {
  const line = "border-muted-foreground/40";
  // A held ticket hangs under the ticket holding its group, not under a
  // blocker, and the dashed edge is what keeps the two relations apart.
  const edge = held ? "border-dashed" : "";
  return (
    <span className="flex shrink-0 self-stretch" aria-hidden>
      {guides.map((open, index) => (
        <span key={index} className={cn("block w-4", open && `border-l ${line}`)} />
      ))}
      <span className="relative block w-4">
        <span className={cn("absolute top-0 left-0 block border-l", line, edge, last ? "h-1/2" : "h-full")} />
        <span className={cn("absolute top-1/2 left-0 block w-3 border-t", line, edge)} />
      </span>
    </span>
  );
}

/**
 * Hang each occupied ticket under the ticket holding its staffing group,
 * when that holder is a root of the same spec. The script nests by
 * dependency only; on a page, "behind #1095" reads better as a subtree than
 * as eight repeated notes. The relation is carried on the node (`held`), so
 * the row can draw it differently from a blocking edge.
 */
type DrawnNode = Omit<FrontierTreeNode, "children"> & { held: boolean; children: DrawnNode[] };

function nestHeld(roots: FrontierTreeNode[]): DrawnNode[] {
  const drawn = new Map<number, DrawnNode>();
  const asDrawn = (node: FrontierTreeNode): DrawnNode => {
    const copy: DrawnNode = { ...node, held: false, children: node.children.map(asDrawn) };
    drawn.set(copy.number, copy);
    return copy;
  };
  const top = roots.map(asDrawn);
  const kept: DrawnNode[] = [];
  for (const node of top) {
    const holder = node.heldBy === null ? undefined : drawn.get(node.heldBy);
    if (holder !== undefined && holder !== node && top.includes(holder)) {
      holder.children.push({ ...node, held: true });
    } else {
      kept.push(node);
    }
  }
  return kept;
}

/**
 * One ticket row, drawn the way the terminal draws it: a column of `│` guides
 * for each ancestor that still has siblings below, then `├─` or `└─` for this
 * node. The guides are monospace text so the columns line up whatever the
 * title says.
 */
function TreeRow({
  node,
  guides,
  last,
  repoUrl,
  reasons,
  dropped,
}: {
  node: DrawnNode;
  /** For each ancestor depth, whether a guide line continues past this row. */
  guides: boolean[];
  last: boolean;
  repoUrl: string | null;
  reasons: Map<number, StuckReason>;
  dropped: Map<number, FrontierDroppedReference[]>;
}) {
  const { nowMs, prs } = useContext(Clock);
  const pull = prs?.get(node.number);
  // A closed ticket's mark says how it closed: merged through a PR, or not.
  const merged = node.state === "done" && pull?.state === "merged";
  const closedUnmerged = node.state === "done" && prs !== null && !merged;
  // In the merge queue is the furthest an open ticket gets, so the mark says
  // it too, not only the chip at the row's end.
  const merging = node.state !== "done" && pull?.state === "queued";
  // Only where the state mark says nothing more urgent: a blocked, claimed or
  // closed ticket keeps its own mark and the chip says the rest.
  const yours = node.human !== null && (node.state === "open" || node.state === "ready" || node.state === "occupied");
  const notes: string[] = [];
  // Under its holder, the position already says what the note would; and a
  // "PR #n" holder is what the PR chip already says, in colour.
  if (node.detail && !node.held && !(pull && node.detail === `PR #${pull.pr}`)) notes.push(node.detail);
  const blockedBy = node.otherBlockers.length > 0 ? `← ${issues(node.otherBlockers)}` : null;
  if (node.frees > 0) notes.push(`frees ${node.frees}`);

  return (
    <>
      <li
        className={cn(
          "flex items-stretch gap-1.5 px-3 text-[13px] leading-6 hover:bg-muted/40",
          node.state === "done" && "text-muted-foreground",
          node.state === "blocked" && "bg-status-bad/[0.06]",
        )}
      >
        <Guides guides={guides} last={last} held={node.held} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {/* An in-flight mark carries its own, longer tooltip. */}
          <Tip
            content={
              merging
                ? `merging: PR #${pull!.pr} is ${PULL_LOOK.queued.why}`
                : node.state === "in-flight"
                  ? null
                  : merged
                    ? `merged in PR #${pull!.pr}`
                    : closedUnmerged
                      ? "closed without a merged PR"
                      : yours
                        ? "waits on you"
                        : STATE_WORD[node.state]
            }
          >
            <span
              className={cn(
                "w-3 shrink-0 text-center font-mono text-sm leading-none",
                STATE_TEXT[node.state],
                closedUnmerged && "text-muted-foreground",
              )}
            >
              {merging ? (
                <MergingMark ticket={node.number} />
              ) : node.state === "in-flight" ? (
                <InFlightMark ticket={node.number} />
              ) : merged ? (
                <GitMerge className="inline size-3 text-status-done" aria-label="merged" />
              ) : yours ? (
                <YouMark />
              ) : (
                STATE_MARK[node.state]
              )}
            </span>
          </Tip>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            <IssueLink repoUrl={repoUrl} issue={node.number} />
          </span>
          <span className="truncate" title={node.title}>
            {node.title}
          </span>
          {node.stuck && (
            <Tip content={stuckTip(reasons.get(node.number), nowMs)}>
              <span className={cn("shrink-0 rounded border px-1 font-mono text-[10px]", stuckTint(reasons.get(node.number), nowMs))}>
                {stuckWord(node.stuck, reasons.get(node.number), nowMs)}
              </span>
            </Tip>
          )}
          {node.human && <HumanChip reason={node.human} />}
          {dropped.has(node.number) && <DroppedChip references={dropped.get(node.number)!} />}
          {pull && node.state !== "done" && <PullChip pull={pull} repoUrl={repoUrl} />}
          {(blockedBy !== null || notes.length > 0) && (
            <span className="ml-auto shrink-0 pl-3 text-xs whitespace-nowrap text-muted-foreground">
              {blockedBy !== null && <span className="font-medium text-status-bad">blocked {blockedBy}</span>}
              {blockedBy !== null && notes.length > 0 && " · "}
              {notes.join(" · ")}
            </span>
          )}
        </span>
      </li>
      {node.children.map((child, index) => (
        <TreeRow
          key={child.number}
          node={child}
          guides={[...guides, !last]}
          last={index === node.children.length - 1}
          repoUrl={repoUrl}
          reasons={reasons}
          dropped={dropped}
        />
      ))}
    </>
  );
}

const countNodes = (nodes: FrontierTreeNode[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);

function TreeGroupView({
  group,
  repoUrl,
  reasons,
  dropped,
}: {
  group: FrontierTreeGroup;
  repoUrl: string | null;
  reasons: Map<number, StuckReason>;
  dropped: Map<number, FrontierDroppedReference[]>;
}) {
  const { nowMs } = useContext(Clock);
  const open = countNodes(group.roots);
  const done = group.total - open;
  const heading = group.spec ? (group.spec.title ?? `#${group.spec.number}`) : (group.roots[0]?.title ?? "standalone");
  const notes: string[] = [];
  if (group.spec) notes.push(`${group.total} ticket${group.total === 1 ? "" : "s"}${done > 0 ? `, ${done} done` : ""}`);
  if (group.under !== null) notes.push(`under #${group.under}`);
  if (group.subSpecs.length > 0)
    notes.push(`${group.subSpecs.length} sub-spec${group.subSpecs.length === 1 ? "" : "s"}`);
  // A spec's own standing matters only when it is something other than open.
  if (group.spec?.state && group.spec.state !== "open") notes.push(STATE_WORD[group.spec.state]);
  if (group.spec?.detail) notes.push(group.spec.detail);
  if (group.spec && group.spec.blockers.length > 0) notes.push(`← ${issues(group.spec.blockers)}`);
  if (group.complete) notes.push(group.specStillOpen ? "complete, spec still open" : "complete");
  return (
    <li className="py-1.5">
      <p className="flex items-baseline gap-x-2 px-3 text-[13px] leading-5">
        {group.spec && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            <IssueLink repoUrl={repoUrl} issue={group.spec.number} />
          </span>
        )}
        <span className={cn("truncate font-medium", group.complete && "text-muted-foreground")} title={heading}>
          {group.spec ? heading : "Standalone"}
        </span>
        {group.spec?.stuck && (
          <Tip content={stuckTip(reasons.get(group.spec.number), nowMs)}>
            <span
              className={cn("shrink-0 rounded border px-1 font-mono text-[10px]", stuckTint(reasons.get(group.spec.number), nowMs))}
            >
              {stuckWord(group.spec.stuck, reasons.get(group.spec.number), nowMs)}
            </span>
          </Tip>
        )}
        {notes.length > 0 && (
          <span className="ml-auto shrink-0 pl-3 text-xs whitespace-nowrap text-muted-foreground">
            {notes.join(" · ")}
          </span>
        )}
      </p>
      {group.roots.length > 0 && (
        <ul className="mt-0.5">
          {nestHeld(group.roots).map((node, index, drawn) => (
            <TreeRow
              key={node.number}
              node={node}
              guides={[]}
              last={index === drawn.length - 1}
              repoUrl={repoUrl}
              reasons={reasons}
              dropped={dropped}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Tree({ view, repoUrl }: { view: FrontierView; repoUrl: string | null }) {
  const reasons = stuckReasonsByNumber(view);
  const dropped = droppedByNumber(view);
  const live = view.tree.filter((group) => !group.complete && group.spec !== null);
  const finished = view.tree.filter((group) => group.complete);
  // A parentless ticket is its own group in the script; on a page, a row each
  // under one heading reads better than a heading each.
  const standalone = view.tree
    .filter((group) => !group.complete && group.spec === null)
    .flatMap((group) => group.roots);
  if (view.tree.length === 0) return <Quiet>No specs or tickets to draw.</Quiet>;
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <GitMerge className="size-3 text-status-done" aria-hidden />
          merged
        </span>
        <span className="inline-flex items-center gap-1.5">
          <UserRound className="size-3 text-foreground" strokeWidth={2.5} aria-hidden />
          for you
        </span>
        {(Object.keys(STATE_MARK) as TreeState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span className={cn("font-mono", STATE_TEXT[state], state === "done" && "text-muted-foreground")}>
              {STATE_MARK[state]}
            </span>
            {state === "done" ? "closed" : STATE_WORD[state]}
          </span>
        ))}
      </p>
      <div className="rounded-xl border">
        <ul className="divide-y">
          {live.map((group) => (
            <TreeGroupView key={group.spec!.number} group={group} repoUrl={repoUrl} reasons={reasons} dropped={dropped} />
          ))}
          {standalone.length > 0 && (
            <li className="py-1.5">
              <p className="flex items-baseline gap-x-2 px-3 text-[13px] leading-5">
                <span className="font-medium">Standalone</span>
                <span className="ml-auto shrink-0 pl-3 text-xs whitespace-nowrap text-muted-foreground">
                  {standalone.length} ticket{standalone.length === 1 ? "" : "s"} with no spec
                </span>
              </p>
              <ul className="mt-0.5">
                {nestHeld(standalone).map((node, index, drawn) => (
                  <TreeRow
                    key={node.number}
                    node={node}
                    guides={[]}
                    last={index === drawn.length - 1}
                    repoUrl={repoUrl}
                    reasons={reasons}
                    dropped={dropped}
                  />
                ))}
              </ul>
            </li>
          )}
        </ul>
      </div>
      {finished.length > 0 && (
        <Section title="Finished specs" detail="every child has closed" count={finished.length}>
          <ul className="divide-y">
            {finished.map((group) => (
              <TreeGroupView key={group.spec?.number ?? "solo"} group={group} repoUrl={repoUrl} reasons={reasons} dropped={dropped} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ViewToggle({ mode, onChange }: { mode: "tree" | "buckets"; onChange: (mode: "tree" | "buckets") => void }) {
  const button = (value: "tree" | "buckets", label: string) => (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onChange(value)}
      aria-pressed={mode === value}
      className={cn(
        "h-auto rounded-md border-0 px-2.5 py-1 font-normal tracking-normal normal-case transition-colors",
        mode === value
          ? "bg-muted font-medium hover:bg-muted dark:hover:bg-muted"
          : "text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent",
      )}
    >
      {label}
    </Button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border p-0.5">
      {button("tree", "By spec")}
      {button("buckets", "By state")}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export function Backlog({
  frontier,
  repoUrls,
  nowMs,
  loops = [],
}: {
  frontier: FrontierRead | null;
  repoUrls: Record<string, string | null>;
  nowMs: number;
  /**
   * The roster: for the stuck rows' Talk (which loop a block label names, and
   * whether it runs) and the in-flight rows' spinner and hover text.
   */
  loops?: readonly BacklogLoop[];
}) {
  // Every loop works one repo; any loop's link is the ticket's.
  const repoUrl = Object.values(repoUrls).find((url) => url !== null) ?? null;
  const view = frontier?.view ?? null;
  const readyCount = view === null ? 0 : view.ready.reduce((sum, group) => sum + group.tickets.length, 0);
  const stuck = view === null ? noStuckGroups() : stuckGroups(view, nowMs);
  const running = view === null ? new Set<number>() : runningTickets(view, loops);
  const reasons = view === null ? new Map<number, StuckReason>() : stuckReasonsByNumber(view);
  const forYou = view === null ? [] : forYouRows(view, nowMs);
  const clock: BacklogClock = {
    nowMs,
    loops,
    inFlight: new Map((view?.inFlight ?? []).map((ticket) => [ticket.number, ticket])),
    running,
    prs: frontier?.prs ? new Map(frontier.prs.map((pull) => [pull.issue, pull])) : null,
  };
  // A count jumps to its rows. The state buckets exist only in the By state
  // view, so a jump there switches to it first and scrolls once it has drawn.
  const ids = useId();
  const anchor = (target: string) => `${ids}-${target}`;
  const [jump, setJump] = useState<string | null>(null);
  clock.jump = jump === null ? null : anchor(jump);
  useEffect(() => {
    if (jump === null) return;
    const element = document.getElementById(anchor(jump));
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
    setJump(null);
  });
  const [mode, setMode] = useState<"tree" | "buckets">(() => {
    try {
      return localStorage.getItem("ralph.backlog.mode") === "buckets" ? "buckets" : "tree";
    } catch {
      return "tree";
    }
  });
  const choose = (next: "tree" | "buckets") => {
    setMode(next);
    try {
      localStorage.setItem("ralph.backlog.mode", next);
    } catch {
      // A blocked store only loses the remembered tab.
    }
  };
  const toBucket = (target: string) => () => {
    if (mode !== "buckets") choose("buckets");
    setJump(target);
  };
  const toPanel = (target: string) => () => setJump(target);
  return (
    <Clock.Provider value={clock}>
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium">Backlog</h2>
            <p className="text-sm text-muted-foreground">
              The frontier as the loops read it: what starts now, what waits behind a pick, what is claimed and what is
              blocked.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {frontier && (
              <Tip content={new Date(frontier.readAt).toLocaleString()}>
                <p className="text-xs text-muted-foreground">read {relative(frontier.readAt, nowMs)}</p>
              </Tip>
            )}
            {view && <ViewToggle mode={mode} onChange={choose} />}
          </div>
        </div>

        {frontier === null ? (
          <Quiet>Unknown: this server does not read the frontier.</Quiet>
        ) : view === null ? (
          <Alert className="bg-transparent">
            <CircleAlert className="text-status-warn" />
            <AlertTitle>The frontier could not be read</AlertTitle>
            <AlertDescription>
              <p className="font-mono text-xs break-all">{frontier.problem ?? "no reason was reported"}</p>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <StaleNote frontier={frontier} />
            <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
              <Count label="ready" value={readyCount} tone="good" onJump={toBucket("ready")} />
              <Count label="in flight" value={view.inFlight.length} tone="info" onJump={toBucket("in-flight")} />
              <Count label="occupied" value={view.occupied.length} tone="neutral" onJump={toBucket("occupied")} />
              <Count label="blocked" value={view.blocked.length} tone="bad" onJump={toBucket("blocked")} />
              {stuck.migration.length > 0 && (
                <Count
                  label="need a migration"
                  value={stuck.migration.length}
                  tone="info"
                  onJump={toPanel("migration")}
                />
              )}
              {stuck.other.length > 0 && (
                <Count label="stuck" value={stuck.other.length} tone="warn" onJump={toPanel("other")} />
              )}
              <Count label="for you" value={forYou.length} tone="neutral" onJump={toPanel("for-you")} />
            </div>

            <Stuck groups={stuck} repoUrl={repoUrl} view={view} loops={loops} anchor={anchor} />

            {forYou.length > 0 && (
              <Section
                id={anchor("for-you")}
                title="For you"
                detail="no loop will start or finish these; they wait on you"
                count={forYou.length}
                open
              >
                <ul className="divide-y">
                  {forYou.map((row) => (
                    <li key={row.number} className="flex items-baseline gap-2 px-4 py-2 text-sm">
                      <span className="w-3 shrink-0 self-center">
                        <YouMark />
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        <IssueLink repoUrl={repoUrl} issue={row.number} />
                      </span>
                      <span className="truncate" title={row.title}>
                        {row.title}
                      </span>
                      {/* "for you" is the section's own name; only a more specific reason earns a chip. */}
                      {row.kind === "stuck" ? (
                        <span className="ml-auto shrink-0">
                          <StuckForYouChip reason={row.stuck} />
                        </span>
                      ) : (
                        row.reason !== "ready-for-human" && (
                          <span className="ml-auto shrink-0">
                            <HumanChip reason={row.reason} />
                          </span>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {mode === "tree" ? (
              <Tree view={view} repoUrl={repoUrl} />
            ) : (
              <div className="space-y-3">
                <Section id={anchor("ready")} title="Ready now" detail="one agent per group, in parallel" count={readyCount} open>
                  <Ready view={view} repoUrl={repoUrl} />
                </Section>
                <Section
                  id={anchor("in-flight")}
                  title="In flight"
                  detail="claimed by a loop, an assignee or a PR"
                  count={view.inFlight.length}
                  open
                >
                  <InFlight view={view} repoUrl={repoUrl} />
                </Section>
                <Section
                  id={anchor("occupied")}
                  title="Occupied"
                  detail="unblocked, but their staffing group is taken"
                  count={view.occupied.length}
                >
                  <TicketRows
                    rows={view.occupied}
                    repoUrl={repoUrl}
                    note={(ticket) => `held by #${(ticket as FrontierView["occupied"][number]).heldBy}`}
                    empty="Nothing is waiting behind a pick."
                  />
                </Section>
                <Section id={anchor("blocked")} title="Blocked" detail="open blockers, claimed ones included" count={view.blocked.length}>
                  <TicketRows
                    rows={view.blocked}
                    repoUrl={repoUrl}
                    note={(ticket) => {
                      const row = ticket as FrontierView["blocked"][number];
                      const stuckAs = row.stuck ? stuckWord(row.stuck, reasons.get(row.number), nowMs) : null;
                      return `← ${issues(row.blockers)}${stuckAs ? ` · ${stuckAs}` : ""}`;
                    }}
                    empty="Nothing is blocked."
                    tone="bad"
                  />
                  {view.gates.length > 0 && (
                    <div className="border-t px-4 py-3">
                      <p className="text-xs text-muted-foreground">Gates work but are not queued for an agent:</p>
                      <ul className="mt-1 space-y-1">
                        {view.gates.map((gate) => (
                          <li key={gate.number} className="flex items-baseline gap-2 text-sm">
                            <span className="font-mono text-xs text-status-warn">
                              ⚠ <IssueLink repoUrl={repoUrl} issue={gate.number} />
                            </span>
                            <span className="truncate" title={gate.title}>
                              {gate.title}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </Section>
                {(view.specs.length > 0 || view.stuck.length > 0) && (
                  <Section
                    title="Specs and stuck"
                    detail="containers, not work; and tickets wedged off the queue"
                    count={view.specs.length + view.stuck.length}
                  >
                    <TicketRows
                      rows={[...view.specs, ...view.stuck]}
                      repoUrl={repoUrl}
                      note={(ticket) =>
                        "children" in ticket
                          ? `spec · parent of ${(ticket as FrontierView["specs"][number]).children}`
                          : stuckWord(
                              (ticket as FrontierView["stuck"][number]).label,
                              reasons.get(ticket.number),
                              nowMs,
                            )
                      }
                      empty=""
                    />
                  </Section>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </Clock.Provider>
  );
}
