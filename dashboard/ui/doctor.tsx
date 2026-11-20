import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, CircleDashed, CircleX, LoaderCircle, RefreshCw, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DOCTOR_DISABLE_REPAIR as DISABLE, type DoctorAction, type DoctorCheckView, type DoctorPluginView, type DoctorView } from "../contracts";
import { STEP_TONE, historyRows, mergeDoctorView, type Tone } from "./doctor-model";
import { CommandNotice, LocalOnlyNote, send, useCommandAvailability } from "./command";
import type { CommandError } from "./command-model";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-status-good",
  bad: "text-status-bad",
  warn: "text-status-warn",
  neutral: "text-muted-foreground",
};

const STATUS_ICON: Record<DoctorCheckView["status"], { icon: typeof CircleCheck; tone: Tone; word: string }> = {
  pass: { icon: CircleCheck, tone: "good", word: "passed" },
  fail: { icon: CircleX, tone: "bad", word: "failed" },
  skipped: { icon: CircleDashed, tone: "neutral", word: "not checked" },
};

interface Request {
  action: DoctorAction;
  plugin?: string;
  check?: string;
  repair?: string;
  confirm?: boolean;
}

/**
 * Fix: one panel per enabled plugin that has a doctor, naming which of its
 * checks failed and offering the repair that fits each. Absent entirely when
 * no plugin is enabled for the project.
 *
 * The page asks the harness's plugin doctor and nothing else; what the checks
 * are and what each repair does arrive in its answer. A repair here never
 * holds, stops or slows the loop — the loop's controls do not go through any
 * plugin.
 *
 * The doctor runs on the machine, can take minutes and edits its config, so
 * where its route is not offered (the remote page) the page asks nothing and
 * shows the panel's buttons disabled. Every request goes through the command
 * module.
 */
export function PluginDoctor({ loop }: { loop: string }) {
  const [view, setView] = useState<DoctorView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const { disabled } = useCommandAvailability("/api/doctor");

  const ask = useCallback(
    async (request: Request, key: string) => {
      setBusy(key);
      setError(null);
      try {
        const result = await send<DoctorView>("/api/doctor", { loop, ...request });
        if (!result.ok) {
          // A server without the doctor mounted (the preview's) has no panel to show.
          if (request.action === "diagnose" && (result.error.status === 404 || result.error.status === 405)) return null;
          if (result.error.kind !== "Aborted") setError(result.error);
          return null;
        }
        const body = result.value;
        if (body === null) return null;
        setView((previous) => mergeDoctorView(previous, body, request.action === "diagnose" ? null : (request.plugin ?? null)));
        return body;
      } finally {
        setBusy(null);
      }
    },
    [loop],
  );

  // Once per loop: every diagnosis is recorded in the loop's repair history,
  // so an effect run twice (StrictMode does) must not ask twice.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (disabled || asked.current === loop) return;
    asked.current = loop;
    setView(null);
    void ask({ action: "diagnose" }, "diagnose");
  }, [loop, ask, disabled]);

  if (disabled) return <RemoteFix />;
  if (view === null && error === null) return null;
  if (view !== null && view.problem === null && view.plugins.length === 0) return null;

  return (
    <div className="space-y-4">
      {error !== null && (
        <div className="rounded-md border border-status-bad/40 px-3 py-2 text-xs text-status-bad">
          Fix: <CommandNotice error={error} />
        </div>
      )}
      {view?.problem != null && (
        <p className="rounded-md border border-status-warn/40 px-3 py-2 text-xs text-status-warn">
          The plugin doctor could not be read: {view.problem}
        </p>
      )}
      {view?.plugins.map((plugin) => (
        <PluginPanel
          key={plugin.plugin}
          plugin={plugin}
          view={view}
          busy={busy}
          onDiagnose={() => void ask({ action: "diagnose" }, "diagnose")}
          onFixAll={() => void ask({ action: "fix-all", plugin: plugin.plugin }, `fix-all:${plugin.plugin}`)}
          onRepair={async (check, repair) => {
            const answer = await ask(
              { action: "repair", plugin: plugin.plugin, check, repair, ...(repair === DISABLE ? { confirm: true } : {}) },
              `repair:${plugin.plugin}:${check}:${repair}`,
            );
            // Off for the project means no panel: ask again, so it goes.
            if (repair === DISABLE && answer?.steps[0]?.result === "repaired") void ask({ action: "diagnose" }, "diagnose");
          }}
        />
      ))}
    </div>
  );
}

/** The Fix panel on the remote page: what it would offer, off. */
function RemoteFix() {
  return (
    <Card className="gap-4 py-5 shadow-none" data-remote-fix>
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wrench className="size-4 text-muted-foreground" />
          Fix
        </CardTitle>
        <CardDescription className="text-xs">
          The plugin doctor checks and repairs on the machine. The loop's controls work either way.
        </CardDescription>
        <CardAction className="flex items-center gap-1.5">
          <LocalOnlyNote route="/api/doctor" />
          <Button variant="ghost" size="xs" disabled>
            <RefreshCw />
            Re-check
          </Button>
          <Button size="xs" disabled>
            <Wrench />
            Fix all
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

function PluginPanel({
  plugin,
  view,
  busy,
  onDiagnose,
  onFixAll,
  onRepair,
}: {
  plugin: DoctorPluginView;
  view: DoctorView;
  busy: string | null;
  onDiagnose: () => void;
  onFixAll: () => void;
  onRepair: (check: string, repair: string) => void;
}) {
  const failing = plugin.checks.filter((check) => check.status === "fail");
  const [armed, setArmed] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const rows = historyRows(view.history, plugin.plugin);
  const steps = view.steps;
  const working = busy !== null;

  return (
    <Card className="gap-4 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Wrench className="size-4 text-muted-foreground" />
          Fix · {plugin.title} plugin
        </CardTitle>
        <CardDescription className="text-xs">
          {plugin.problem !== null
            ? "The plugin's doctor did not answer."
            : failing.length === 0
              ? "Every check that could be asked passed."
              : `${failing.length} check${failing.length === 1 ? "" : "s"} failed. The loop's controls work either way.`}
        </CardDescription>
        <CardAction className="flex gap-1.5">
          <Button variant="ghost" size="xs" onClick={onDiagnose} disabled={working}>
            {busy === "diagnose" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Re-check
          </Button>
          {failing.length > 0 && (
            <Button size="xs" onClick={onFixAll} disabled={working}>
              {busy === `fix-all:${plugin.plugin}` ? <LoaderCircle className="animate-spin" /> : <Wrench />}
              Fix all
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {plugin.problem !== null && <p className="text-sm text-status-bad">{plugin.problem}</p>}
        <ol className="divide-y">
          {plugin.checks.map((check, index) => {
            const look = STATUS_ICON[check.status];
            const Icon = look.icon;
            return (
              <li key={check.id} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2.5">
                  <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[look.tone])} aria-label={look.word} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
                      <span className="font-medium">{check.label}</span>
                      <span className={cn("text-xs", TONE_TEXT[look.tone])}>{look.word}</span>
                    </div>
                    {check.detail && <p className="text-xs break-words text-muted-foreground">{check.detail}</p>}
                    {check.status === "fail" && check.repairs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {check.repairs.map((repair) => {
                          const key = `repair:${plugin.plugin}:${check.id}:${repair.id}`;
                          const confirmFirst = repair.id === DISABLE;
                          const isArmed = armed === key;
                          return (
                            <Button
                              key={repair.id}
                              size="xs"
                              variant={confirmFirst ? (isArmed ? "destructive" : "outline") : repair.default ? "secondary" : "outline"}
                              disabled={working}
                              onClick={() => {
                                if (confirmFirst && !isArmed) {
                                  setArmed(key);
                                  return;
                                }
                                setArmed(null);
                                onRepair(check.id, repair.id);
                              }}
                            >
                              {busy === key && <LoaderCircle className="animate-spin" />}
                              {isArmed ? `Confirm: ${repair.label.toLowerCase()}` : repair.label}
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {(steps.length > 0 || view.stopped !== null) && (
          <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
            {steps.map((step, index) => (
              <p key={`${step.check}-${step.action ?? ""}-${index}`} className="break-words">
                <span className="font-mono">{step.action ?? step.check}</span>{" "}
                <span className={TONE_TEXT[STEP_TONE[step.result]]}>{step.result}</span>
                {step.why && <span className="text-muted-foreground"> — {step.why}</span>}
              </p>
            ))}
            {view.stopped !== null && <p className="break-words text-status-warn">Fix all stopped: {view.stopped}</p>}
          </div>
        )}

        <div>
          <Button
            variant="ghost"
            size="xs"
            className="-ml-2 text-muted-foreground"
            onClick={() => setShowHistory((value) => !value)}
            aria-expanded={showHistory}
          >
            <ChevronDown className={cn("transition-transform", showHistory && "rotate-180")} />
            Repair history ({rows.length})
          </Button>
          {showHistory &&
            (rows.length === 0 ? (
              <p className="pt-1 text-xs text-muted-foreground">Nothing diagnosed or repaired yet.</p>
            ) : (
              <ul className="divide-y pt-1">
                {rows.map((row) => (
                  <li key={row.key} className="space-y-0.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 text-xs">
                      <span className="font-mono">{row.what}</span>
                      <span className={TONE_TEXT[row.tone]}>{row.result}</span>
                      <span className="ml-auto text-muted-foreground">{row.at.replace("T", " ").slice(0, 19)}</span>
                    </div>
                    {row.why && <p className="text-xs break-words text-muted-foreground">{row.why}</p>}
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
