/**
 * The setup form's Tracker section (felipearos/ralph#338): where a project's
 * tickets live. GitHub issues need nothing here. For Linear or Jira the
 * operator pastes a token, the server asks `tracker.ts` what that token can
 * see, and the operator picks the team or project and the two workflow states
 * from those lists. Saving stores the token on this host for the loops; the
 * `tracker` block itself rides on the setup PR with the rest of the config.
 *
 * The token stays in this component and the two requests that carry it. The
 * view logic is in `onboarding-model.ts`.
 */
import { CheckCircle2, Loader2, Ticket } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TrackerConnectReport } from "../contracts";
import { CommandNotice, send } from "./command";
import { EMPTY_ANSWER, type CommandError } from "./command-model";
import { FormSection } from "./form-section";
import { connectRequest, defaultStates, EMPTY_TRACKER, TRACKER_KINDS, trackerHold, type TrackerDraft } from "./onboarding-model";
import { TrackerMark } from "./tracker-marks";

export function TrackerSection({
  draft,
  onDraft,
  saved,
  onSaved,
}: {
  draft: TrackerDraft;
  onDraft: (draft: TrackerDraft) => void;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const [report, setReport] = useState<TrackerConnectReport | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null);

  // A new tracker or token invalidates what was tested and what was saved;
  // a pick from the tested lists (team, states, scope) is config, not
  // credential, and keeps both.
  const CREDENTIAL: (keyof TrackerDraft)[] = ["kind", "apiKey", "site", "email", "apiToken"];
  const change = (patch: Partial<TrackerDraft>) => {
    onDraft({ ...draft, ...patch });
    setFailure(null);
    if (Object.keys(patch).some((field) => CREDENTIAL.includes(field as keyof TrackerDraft))) {
      onSaved(false);
      setReport(null);
    }
  };

  const test = async (withKey: TrackerDraft = draft) => {
    const request = connectRequest(withKey);
    if (request === null) return;
    setBusy("test");
    setFailure(null);
    const answer = await send<TrackerConnectReport>("/api/setup/tracker/test", request);
    setBusy(null);
    if (!answer.ok) {
      setFailure(answer.error);
      return;
    }
    if (answer.value === null) {
      setFailure(EMPTY_ANSWER);
      return;
    }
    const tested = answer.value;
    setReport(tested);
    if (tested.ok) {
      const states = tested.states === undefined ? {} : defaultStates(tested.states);
      onDraft({ ...withKey, workspace: tested.workspace ?? "", ...states });
    }
  };

  const save = async () => {
    setBusy("save");
    setFailure(null);
    const answer = await send("/api/setup/tracker/save", connectRequest(draft));
    setBusy(null);
    if (!answer.ok) {
      setFailure(answer.error);
      return;
    }
    onSaved(true);
  };

  const ok = report !== null && report.ok ? report : null;
  const noun = draft.kind === "linear" ? "team" : "project";
  const hold = trackerHold(draft, true);

  return (
    <FormSection title="Tracker" blurb="Where the loops find and claim tickets." icon={Ticket}>
      <div className="grid content-start gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Where this project's tickets live"
          value={draft.kind}
          // Radix reports "" when the active item is clicked again; a tracker is always picked, so ignore it.
          onValueChange={(kind) => kind && change({ ...EMPTY_TRACKER, kind: kind as TrackerDraft["kind"] })}
        >
          {TRACKER_KINDS.map(({ kind, label }) => (
            <ToggleGroupItem key={kind} value={kind} className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
              <TrackerMark kind={kind} className="size-3.5" />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {draft.kind === "github" ? (
          <p className="text-xs text-muted-foreground">Loops read and claim the repository's GitHub issues with gh. Nothing to connect.</p>
        ) : (
          <>
            {draft.kind === "linear" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="tracker-api-key">Linear API key</Label>
                <Input
                  id="tracker-api-key"
                  type="password"
                  autoComplete="off"
                  className="font-mono"
                  value={draft.apiKey}
                  onChange={(event) => change({ apiKey: event.target.value, key: "" })}
                />
                <p className="text-xs text-muted-foreground">A personal key from Linear's Settings → API. Stored on this machine only, never in the repo.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-site">Jira site</Label>
                  <Input id="tracker-site" className="font-mono" placeholder="acme.atlassian.net" value={draft.site} onChange={(event) => change({ site: event.target.value, key: "" })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-email">Account email</Label>
                  <Input id="tracker-email" value={draft.email} onChange={(event) => change({ email: event.target.value, key: "" })} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-token">API token</Label>
                  <Input
                    id="tracker-token"
                    type="password"
                    autoComplete="off"
                    className="font-mono"
                    value={draft.apiToken}
                    onChange={(event) => change({ apiToken: event.target.value, key: "" })}
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={busy !== null || connectRequest(draft) === null} onClick={() => void test()}>
                {busy === "test" && <Loader2 className="animate-spin" />}
                Test connection
              </Button>
              {ok !== null && (
                <span className="text-sm text-muted-foreground">
                  Connected as {ok.user}
                  {ok.workspace ? ` in ${ok.workspace}` : ""}
                </span>
              )}
            </div>

            {report !== null && !report.ok && (
              <Alert variant="destructive">
                <AlertTitle>The tracker did not accept this</AlertTitle>
                <AlertDescription>{report.message}</AlertDescription>
              </Alert>
            )}

            {ok !== null && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-key">{draft.kind === "linear" ? "Team" : "Project"}</Label>
                  {/* Radix forbids an empty item, so "" (nothing picked yet) shows
                      the placeholder instead of an option. */}
                  <Select
                    value={draft.key}
                    onValueChange={(key) => {
                      const next = { ...draft, key, claimed: "", done: "" };
                      onDraft(next);
                      if (next.key !== "") void test(next);
                    }}
                  >
                    <SelectTrigger id="tracker-key" className="w-full">
                      <SelectValue placeholder={`Pick a ${noun}…`} />
                    </SelectTrigger>
                    <SelectContent>
                      {ok.options.map((option) => (
                        <SelectItem key={option.key} value={option.key}>
                          {option.key} — {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="tracker-scope">Scope label (optional)</Label>
                  <Input
                    id="tracker-scope"
                    className="font-mono"
                    value={draft.scopeLabel}
                    list="tracker-labels"
                    onChange={(event) => change({ scopeLabel: event.target.value })}
                  />
                  <datalist id="tracker-labels">
                    {(ok.labels ?? []).map((label) => (
                      <option key={label} value={label} />
                    ))}
                  </datalist>
                  <p className="text-xs text-muted-foreground">
                    When the {noun} holds other repositories' tickets too, only those carrying this label are this project's.
                  </p>
                </div>
                {ok.states !== undefined &&
                  (["claimed", "done"] as const).map((which) => (
                    <div key={which} className="grid gap-1.5">
                      <Label htmlFor={`tracker-${which}`}>{which === "claimed" ? "Claimed moves to" : "Finished moves to"}</Label>
                      <Select value={draft[which]} onValueChange={(state) => change({ [which]: state })}>
                        <SelectTrigger id={`tracker-${which}`} className="w-full">
                          <SelectValue placeholder="Pick a state…" />
                        </SelectTrigger>
                        <SelectContent>
                          {ok.states!.map((state) => (
                            <SelectItem key={state} value={state}>
                              {state}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
              </div>
            )}

            {failure !== null && (
              <Alert variant="destructive">
                <AlertTitle>The connector could not finish</AlertTitle>
                <AlertDescription className="whitespace-pre-wrap break-words">
                  <div>
                    <CommandNotice error={failure} />
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" disabled={busy !== null || ok === null || hold !== null || saved} onClick={() => void save()}>
                {busy === "save" && <Loader2 className="animate-spin" />}
                Save connection
              </Button>
              {saved ? (
                <span className="flex items-center gap-1 text-sm text-status-success">
                  <CheckCircle2 className="size-4" />
                  Saved on this machine for the project's loops
                </span>
              ) : (
                hold !== null && ok !== null && <span className="text-xs text-muted-foreground">{hold}</span>
              )}
            </div>
          </>
        )}
      </div>
    </FormSection>
  );
}
