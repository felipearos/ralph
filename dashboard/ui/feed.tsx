/**
 * The notification feed and the audit history: what the loops raised, and
 * what operators did to them.
 *
 * Each panel polls its own route and renders whatever it gets. A route that
 * cannot be reached, or a record that cannot be read, is a sentence in the
 * panel — never an exception that takes the page down with it.
 */
import { useState } from "react";
import { Bell, CheckCheck, History, LoaderCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { NotificationView } from "../contracts";
import {
  DELIVERY_TONE,
  deliveryLine,
  emptyFeed,
  historyNotes,
  newestAt,
  outcomeTone,
  refusalLine,
  SOURCE_WORD,
  unreadMarks,
  type Tone,
} from "./feed-model";
import { CommandNotice, useCommand, type Command } from "./command";
import type { CommandError } from "./command-model";
import { RELAY_QUEUED } from "./remote-model";
import { issueHref, issueRef } from "./issue-link";
import { useLoopHistory, useLoopNotifications, useNotifications, type Polled } from "./use-reads";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  warn: "text-status-warn",
  bad: "text-status-bad",
  info: "text-status-info",
  neutral: "text-muted-foreground",
};

const TONE_TINT: Record<Tone, string> = {
  good: "border-status-good/30 bg-status-good/10 text-status-good",
  warn: "border-status-warn/30 bg-status-warn/10 text-status-warn",
  bad: "border-status-bad/30 bg-status-bad/10 text-status-bad",
  info: "border-status-info/30 bg-status-info/10 text-status-info",
  neutral: "border-border bg-muted/40 text-muted-foreground",
};

/**
 * A named read as the panels draw it: the data to show (an error keeps the
 * last data, so a failed poll does not blank the feed) and the error, if any.
 */
function recordOf<T>({ read, refresh }: Polled<T>): { data: T | null; error: string | null; reload: () => void } {
  const data = read.state === "loading" ? null : read.data;
  return { data, error: read.state === "error" ? read.message : null, reload: refresh };
}

function ageOf(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="tabular-nums" title={new Date(iso).toLocaleString()}>
      {ageOf(iso, Date.now())}
    </time>
  );
}

const Quiet = ({ children, tone = "neutral" }: { children: React.ReactNode; tone?: Tone }) => (
  <p className={cn("text-sm", TONE_TEXT[tone])}>{children}</p>
);

/**
 * Mark alerts read, one loop at a time; answers the first failure, if any.
 * Relaying is the route's: on the remote page `send` follows a mark to the
 * machine and tells `onQueued` while it waits. A 2xx `why` is this panel's
 * own result (the mark was not taken), so it is read off the answer.
 */
async function markRead(
  marks: { loop: string; through: string }[],
  command: Command,
  onQueued: () => void,
): Promise<CommandError | string | null> {
  for (const mark of marks) {
    const result = await command.send<{ why?: string | null }>(mark, { onQueued });
    if (!result.ok) return result.error.kind === "Aborted" ? null : result.error;
    if (result.value?.why) return result.value.why;
  }
  return null;
}

function MarkReadButton({ marks, onDone }: { marks: { loop: string; through: string }[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<CommandError | string | null>(null);
  const command = useCommand("/api/notifications/read");
  if (marks.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      {error !== null && (
        // A div, not a span: a refusal's problems are a list.
        <div className="text-xs text-status-bad">{typeof error === "string" ? error : <CommandNotice error={error} />}</div>
      )}
      {queued && <span className="text-xs text-muted-foreground">{RELAY_QUEUED}…</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={busy || command.disabled}
        title={command.disabled ? (command.why ?? undefined) : undefined}
        onClick={async () => {
          setBusy(true);
          setError(await markRead(marks, command, () => setQueued(true)));
          setQueued(false);
          setBusy(false);
          onDone();
        }}
      >
        {busy ? <LoaderCircle className="animate-spin" /> : <CheckCheck />}
        Mark read
      </Button>
    </div>
  );
}

function AlertRow({
  alert,
  repoUrl,
  onLoop,
}: {
  alert: NotificationView;
  repoUrl: string | null;
  /** Set on the overview, where the loop that raised it is named and links to its page. */
  onLoop?: (loop: string) => void;
}) {
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span
          aria-label={alert.read ? "read" : "unread"}
          className={cn("size-2 shrink-0 rounded-full", alert.read ? "bg-transparent" : "bg-status-info")}
        />
        <Badge variant="outline" className={cn("font-mono text-[11px]", TONE_TINT[alert.priority === "high" ? "warn" : "neutral"])}>
          {alert.kind}
        </Badge>
        {onLoop !== undefined && (
          <Button
            type="button"
            variant="link"
            className="h-auto border-0 p-0 text-sm font-medium tracking-normal text-current no-underline normal-case hover:underline"
            onClick={() => onLoop(alert.loop)}
          >
            {alert.loop}
          </Button>
        )}
        <span className={cn("min-w-0 flex-1 break-words", alert.read ? "text-muted-foreground" : "font-medium")}>{alert.subject}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {alert.ticket !== null &&
            (issueHref(repoUrl, alert.ticket) === null ? (
              <span>{issueRef(alert.ticket)}</span>
            ) : (
              <a href={issueHref(repoUrl, alert.ticket)!} target="_blank" rel="noreferrer" className="hover:underline">
                {issueRef(alert.ticket)}
              </a>
            ))}
          <span>{alert.iteration === null ? "no iteration" : `iteration ${alert.iteration}`}</span>
          <When iso={alert.at} />
        </span>
      </div>
      {alert.body !== "" && alert.body !== alert.subject && (
        <p className="line-clamp-3 pl-4 text-xs break-words whitespace-pre-wrap text-muted-foreground">{alert.body}</p>
      )}
      <div className="flex flex-wrap gap-1.5 pl-4">
        {alert.unsent !== null ? (
          <Badge variant="outline" className={cn("h-auto max-w-full text-[11px] font-normal whitespace-normal", TONE_TINT.warn)}>
            Sent nowhere else: {alert.unsent}
          </Badge>
        ) : alert.deliveries.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">Feed only: no plugin or ticket comment was due.</span>
        ) : (
          alert.deliveries.map((delivery) => (
            <Badge
              key={`${delivery.channel}:${delivery.name}`}
              variant="outline"
              className={cn("h-auto max-w-full text-[11px] font-normal whitespace-normal", TONE_TINT[DELIVERY_TONE[delivery.state]])}
            >
              {deliveryLine(delivery)}
            </Badge>
          ))
        )}
      </div>
    </li>
  );
}

/** One loop's feed, on its page. */
export function NotificationsPanel({ loop, repoUrl }: { loop: string; repoUrl: string | null }) {
  const { data, error, reload } = recordOf(useLoopNotifications(loop));
  const through = data === null ? null : newestAt(data.notifications.filter((alert) => !alert.read));

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bell className="size-4" />
          Notifications
          {data !== null && data.unread > 0 && (
            <Badge variant="outline" className={TONE_TINT.info}>
              {data.unread} unread
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">Every alert this loop raised, and whether each plugin and the ticket got it.</CardDescription>
        <CardAction>
          <MarkReadButton marks={data !== null && through !== null && data.unread > 0 ? [{ loop, through }] : []} onDone={reload} />
        </CardAction>
      </CardHeader>
      <CardContent className="px-5">
        {data === null ? (
          <Quiet tone={error === null ? "neutral" : "warn"}>{error === null ? "Loading…" : `The feed could not be loaded: ${error}`}</Quiet>
        ) : data.notifications.length === 0 ? (
          <Quiet tone={emptyFeed(data.problem).tone}>{emptyFeed(data.problem).text}</Quiet>
        ) : (
          <ul className="divide-y">
            {data.notifications.map((alert) => (
              <AlertRow key={alert.id} alert={alert} repoUrl={repoUrl} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Every loop's newest alerts, on the overview. */
export function NotificationsOverview({
  repoUrls,
  navigate,
}: {
  repoUrls: Record<string, string | null>;
  navigate: (path: string) => void;
}) {
  const { data, error, reload } = recordOf(useNotifications());
  const unreadable = data?.loops.filter((feed) => feed.problem?.kind === "unreadable") ?? [];

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bell className="size-4" />
          Notifications
          {data !== null && data.unread > 0 && (
            <Badge variant="outline" className={TONE_TINT.info}>
              {data.unread} unread
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">The newest alerts across every loop.</CardDescription>
        <CardAction>
          <MarkReadButton marks={data === null ? [] : unreadMarks(data.loops)} onDone={reload} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {data === null ? (
          <Quiet tone={error === null ? "neutral" : "warn"}>{error === null ? "Loading…" : `The feed could not be loaded: ${error}`}</Quiet>
        ) : data.recent.length === 0 ? (
          <Quiet>No loop has raised an alert yet.</Quiet>
        ) : (
          <ul className="divide-y">
            {data.recent.map((alert) => (
              <AlertRow
                key={`${alert.loop}:${alert.id}`}
                alert={alert}
                repoUrl={repoUrls[alert.loop] ?? null}
                onLoop={(loop) => navigate(`/loops/${encodeURIComponent(loop)}`)}
              />
            ))}
          </ul>
        )}
        {unreadable.map((feed) => (
          <Quiet key={feed.loop} tone="warn">
            {feed.loop}: {emptyFeed(feed.problem).text}
          </Quiet>
        ))}
      </CardContent>
    </Card>
  );
}

/** What operators did to one loop, and what came of it. */
export function AuditHistory({ loop }: { loop: string }) {
  const { data, error } = recordOf(useLoopHistory(loop));
  const notes = data === null ? null : historyNotes(data);

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4" />
          History
        </CardTitle>
        <CardDescription className="text-xs">Commands, Stop now signals and plugin repairs, newest first, with what each came to.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        {data === null || notes === null ? (
          <Quiet tone={error === null ? "neutral" : "warn"}>{error === null ? "Loading…" : `The history could not be loaded: ${error}`}</Quiet>
        ) : data.entries.length === 0 ? (
          <Quiet>{notes.empty}</Quiet>
        ) : (
          <ol className="divide-y">
            {data.entries.map((entry) => {
              const why = refusalLine(entry);
              return (
                <li key={`${entry.source}:${entry.id}`} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
                      {SOURCE_WORD[entry.source]}
                    </Badge>
                    <span className="font-mono text-xs">{entry.action}</span>
                    <span className={cn("text-xs font-medium", TONE_TEXT[outcomeTone(entry.outcome)])}>{entry.outcome}</span>
                    {why !== null && <span className="text-xs text-status-bad">({why})</span>}
                    {entry.issue !== null && <span className="text-xs text-muted-foreground">#{entry.issue}</span>}
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {entry.via !== null && <span>via {entry.via}</span>}
                      <When iso={entry.at} />
                    </span>
                  </div>
                  {entry.reason !== null && (
                    <p className="text-xs break-words">
                      <span className="text-muted-foreground">Reason: </span>
                      {entry.reason}
                    </p>
                  )}
                  {entry.detail !== null && <p className="text-xs break-words text-muted-foreground">{entry.detail}</p>}
                  {(entry.signals.length > 0 || entry.run !== null) && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {[entry.signals.length > 0 ? entry.signals.join(" → ") : null, entry.run].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {notes?.warnings.map((warning) => (
          <Quiet key={warning} tone="warn">
            {warning}
          </Quiet>
        ))}
      </CardContent>
    </Card>
  );
}
