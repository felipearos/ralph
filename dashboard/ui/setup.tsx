/**
 * What a project that is not ready shows in place of its agents: the setup
 * form while it needs setup, and the setup PR while that is open. The panel
 * logic is in `onboarding-model.ts`; validation is `project-config`'s, run by
 * the server.
 */
import { CheckCircle2, ExternalLink, File, FolderGit2, GitBranch, GitPullRequest, KeyRound, Loader2, Repeat2, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ProjectSetupView, SetupSubmitResult, SetupValidation } from "../contracts";
import { CommandNotice, LocalOnlyNote, send, useCommandAvailability } from "./command";
import { EMPTY_ANSWER, type CommandError } from "./command-model";
import {
  configFromForm,
  EMPTY_TRACKER,
  formFromConfig,
  gateChips,
  listChips,
  mergesWithoutCi,
  SECRETS_CHOICES,
  setupFiles,
  setupPanel,
  trackerBlock,
  trackerHold,
  type SetupForm,
  type TrackerDraft,
} from "./onboarding-model";
import { FormSection } from "./form-section";
import { TrackerSection } from "./tracker-connector";
import { useSetupDefaults } from "./use-reads";

/** The form or the pending PR; nothing once the project is ready. */
export function SetupPanel({ setup, onSubmitted }: { setup: ProjectSetupView; onSubmitted: () => void }) {
  const panel = setupPanel(setup);
  if (panel.kind === "none") return null;
  if (panel.kind === "pending") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-status-info" />
            Setup PR open
          </CardTitle>
          <CardDescription>
            Agents can start once the setup PR is merged into <code className="font-mono">{panel.baseBranch}</code>. This
            page notices the merge by itself.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <a href={panel.url} target="_blank" rel="noreferrer">
              Review {panel.number === null ? "the setup PR" : `PR #${panel.number}`}
              <ExternalLink />
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }
  return <SetupFormCard baseBranch={panel.baseBranch} onSubmitted={onSubmitted} />;
}

type FieldKey = Exclude<keyof SetupForm, "gates" | "secretsRunner" | "secretsFile">;

/**
 * The form's fields in two sections, each pair a row: where the config lands
 * beside who it is for, then who works the backlog beside what must pass. The
 * hints are kept to one line so a row's inputs line up.
 */
const SECTIONS: { title: string; blurb: string; icon: LucideIcon; fields: { key: FieldKey; label: string; hint: string }[] }[] = [
  {
    title: "Repository",
    icon: FolderGit2,
    blurb: "Where the config lands and who claims are assigned to.",
    fields: [
      { key: "repo", label: "Repository", hint: "owner/name on GitHub" },
      { key: "baseBranch", label: "Base branch", hint: "where the config must land" },
      { key: "owner", label: "Owner", hint: "GitHub login claims go to" },
      { key: "displayName", label: "Display name", hint: "used in journal headings" },
    ],
  },
  {
    title: "Loops & merging",
    icon: Repeat2,
    blurb: "Who works the backlog and what must pass before a loop merges.",
    fields: [
      { key: "loops", label: "Loops", hint: "comma-separated roster" },
      { key: "requiredChecks", label: "Required checks", hint: "CI checks a PR must pass · read from the base branch" },
    ],
  },
];

/** How a list field will be split, one chip per name; a repeat is flagged in the warning tone. */
function ListChips({ form, field }: { form: SetupForm; field: "loops" | "requiredChecks" }) {
  const chips = listChips(form, field);
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={`${field === "loops" ? "Loops" : "Required checks"} as the config will hold them`}>
      {chips.map((chip, index) => (
        <li
          key={`${chip.name}-${index}`}
          className={chip.repeated ? WARN_CHIP : CHIP}
        >
          {chip.name}
          {chip.repeated && " · repeated"}
        </li>
      ))}
    </ul>
  );
}

/**
 * The gates textarea in a filled box with a line-number gutter. It grows to
 * its lines rather than scrolling, and does not wrap, so the gutter stays
 * level with the text without syncing a scroll position.
 */
function GatesEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const lines = Math.max(3, value.split("\n").length);
  return (
    <div className="grid grid-cols-[2rem_1fr] border bg-foreground/[0.03] font-mono text-sm leading-6 focus-within:border-ring">
      <div aria-hidden className="select-none border-r py-2 pr-2 text-right text-muted-foreground/60">
        {Array.from({ length: lines }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <Textarea
        id="setup-gates"
        rows={lines}
        wrap="off"
        spellCheck={false}
        className="resize-none overflow-x-auto overflow-y-hidden border-0 px-3 py-2 font-mono leading-6 whitespace-pre md:text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Each gate's name as the config gets it; a line the server will refuse is flagged in the warning tone. */
function GateChips({ form }: { form: SetupForm }) {
  const chips = gateChips(form);
  if (chips.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Gates as the config will hold them">
      {chips.map((chip) => (
        <li key={chip.line} className={chip.problem === null ? CHIP : WARN_CHIP}>
          {chip.problem === "no-colon" ? `line ${chip.line} · no "name:"` : chip.name}
          {chip.problem === "repeated" && " · repeated"}
        </li>
      ))}
    </ul>
  );
}

const HEADER_CHIP = "inline-flex items-center gap-1.5 border bg-foreground/[0.04] px-2 py-0.5 font-mono text-foreground";
const CHIP = "border bg-secondary px-1.5 py-0.5 font-mono text-xs";
const WARN_CHIP = "border border-status-warn/60 px-1.5 py-0.5 font-mono text-xs text-status-warn";

const loopCount = (form: SetupForm): string => {
  const count = listChips(form, "loops").length;
  return count === 0 ? "" : ` · ${count} loop${count === 1 ? "" : "s"}`;
};

function SetupFormCard({ baseBranch, onSubmitted }: { baseBranch: string; onSubmitted: () => void }) {
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<"check" | "submit" | null>(null);
  const [failure, setFailure] = useState<CommandError | null>(null);
  // Opening the PR needs the machine's checkout, so the remote page is not offered it.
  const setup = useCommandAvailability("/api/setup");
  // Merging without CI is a choice the operator makes on sight of the warning.
  const [noChecksAcknowledged, setNoChecksAcknowledged] = useState(false);
  // Where the tickets live; GitHub until the operator connects Linear or Jira.
  const [tracker, setTracker] = useState<TrackerDraft>(EMPTY_TRACKER);
  const [trackerSaved, setTrackerSaved] = useState(false);
  const trackerWaits = trackerHold(tracker, trackerSaved);
  const withoutCi = form !== null && mergesWithoutCi(form);
  // A long form puts the Check result off-screen; it is brought into view.
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problems === null && failure === null) return;
    result.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [problems, failure]);

  // The defaults are read from the checkout, and the PR opened from it: the
  // remote page offers neither, and the hook reads nothing there.
  const { read: defaultsRead } = useSetupDefaults();
  const loaded = defaultsRead.state === "ready" ? defaultsRead.data : null;
  const loadError = defaultsRead.state === "error" ? defaultsRead.message : null;
  useEffect(() => {
    // Seeded when the read's data object changes, not on every snapshot: the
    // operator's edits in the form must survive a re-render.
    if (loaded === null) return;
    setDefaults(loaded.config);
    setForm(formFromConfig(loaded.config));
  }, [loaded]);

  const body = () => ({
    config: configFromForm(defaults!, form!, trackerBlock(tracker)),
    ...(withoutCi && noChecksAcknowledged ? { acknowledgeNoRequiredChecks: true } : {}),
  });

  const check = async () => {
    setBusy("check");
    setFailure(null);
    const answer = await send<SetupValidation>("/api/setup/validate", body());
    setBusy(null);
    if (!answer.ok) setFailure(answer.error);
    // An empty 2xx is not an answer validate gives; it is shown as one
    // rather than read as a clean check.
    else if (answer.value === null) setFailure(EMPTY_ANSWER);
    else setProblems(answer.value.problems);
  };

  const submit = async () => {
    setBusy("submit");
    setFailure(null);
    const answer = await send<SetupSubmitResult>("/api/setup", body());
    setBusy(null);
    if (answer.ok) {
      onSubmitted();
      return;
    }
    // A config the server rejects comes back as its problems, listed like a Check's.
    if (answer.error.problems !== undefined) setProblems(answer.error.problems);
    else setFailure(answer.error);
  };

  const edit = (key: keyof SetupForm, value: string) => {
    setForm((previous) => (previous === null ? previous : { ...previous, [key]: value }));
    setProblems(null);
    if (key === "requiredChecks") setNoChecksAcknowledged(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up this project</CardTitle>
        <CardDescription className="grid gap-3">
          <p>
            No <code className="font-mono text-foreground/85">.ralph/config.json</code> on{" "}
            <code className="font-mono text-foreground/85">origin/{baseBranch}</code> yet. Opening the setup PR writes:
          </p>
          {/* What the PR will hold, as chips: the paragraph this replaced buried them in a sentence. */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {setupFiles(defaults).map((file) => (
              <span key={file} className={HEADER_CHIP}>
                <File aria-hidden className="size-3 text-muted-foreground" />
                {file}
              </span>
            ))}
            <span className="px-1">on</span>
            <span className={HEADER_CHIP}>
              <GitBranch aria-hidden className="size-3 text-muted-foreground" />
              ralph-setup
            </span>
            <span className="px-1">→ PR into {baseBranch}</span>
          </div>
          <p className="text-xs">Secrets: none, unless the Secrets section below points the loops at a dotenv file.</p>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {setup.disabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled>
              Open setup PR
            </Button>
            <LocalOnlyNote route="/api/setup" />
          </div>
        ) : loadError !== null ? (
          <Alert variant="destructive">
            <AlertTitle>Could not read the defaults</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : form === null ? (
          <p className="text-sm text-muted-foreground">Reading git, gh and package.json…</p>
        ) : (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {SECTIONS.map((section) => (
              <FormSection key={section.title} title={section.title} blurb={section.blurb} icon={section.icon}>
                <div className="grid gap-4 sm:grid-cols-2">
                  {section.fields.map((field) => (
                    <div key={field.key} className="grid gap-1.5">
                      <Label htmlFor={`setup-${field.key}`}>{field.label}</Label>
                      <Input
                        id={`setup-${field.key}`}
                        className="font-mono"
                        value={form[field.key]}
                        onChange={(event) => edit(field.key, event.target.value)}
                      />
                      {(field.key === "loops" || field.key === "requiredChecks") && (
                        <ListChips form={form} field={field.key} />
                      )}
                      <p className="text-xs text-muted-foreground">
                        {field.hint}
                        {field.key === "loops" && loopCount(form)}
                      </p>
                    </div>
                  ))}
                  {/* Gates belong with what must pass before a merge, so they close that section. */}
                  {section.fields.some((field) => field.key === "requiredChecks") && (
                    <div className="grid gap-1.5 sm:col-span-2">
                      <Label htmlFor="setup-gates">Gates</Label>
                      <GatesEditor value={form.gates} onChange={(value) => edit("gates", value)} />
                      <GateChips form={form} />
                      <p className="text-xs text-muted-foreground">One per line, as name: command.</p>
                    </div>
                  )}
                </div>
              </FormSection>
            ))}

            <TrackerSection
              draft={tracker}
              onDraft={(next) => {
                setTracker(next);
                setProblems(null);
              }}
              saved={trackerSaved}
              onSaved={setTrackerSaved}
            />

            <FormSection title="Secrets" blurb="Where the loops' commands read their credentials from." icon={KeyRound}>
              <div className="grid content-start gap-3">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  aria-label="Where the loops' secrets come from"
                  value={form.secretsRunner}
                  // Radix reports "" when the active item is clicked again; a runner is always picked, so ignore it.
                  onValueChange={(runner) => runner && edit("secretsRunner", runner)}
                >
                  {SECRETS_CHOICES.map(({ runner, label }) => (
                    <ToggleGroupItem key={runner} value={runner} className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                      {label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {form.secretsRunner === "dotenv" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="setup-secretsFile">Dotenv file</Label>
                    <Input
                      id="setup-secretsFile"
                      className="font-mono"
                      placeholder="/etc/ralph/project.env"
                      value={form.secretsFile}
                      onChange={(event) => edit("secretsFile", event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      absolute path on this host, outside the worktree · relative paths start at the project root and must be git-ignored
                    </p>
                  </div>
                ) : form.secretsRunner === "none" ? (
                  <p className="text-xs text-muted-foreground">The loops' commands run with no secrets added.</p>
                ) : (
                  // A runner the defaults name but the form does not offer (doppler) goes on the PR as it is.
                  <p className="text-xs text-muted-foreground">
                    Keeps the defaults' <code className="font-mono">{form.secretsRunner}</code> runner unless you pick one above.
                  </p>
                )}
              </div>
            </FormSection>

            {withoutCi && (
              <Alert variant="destructive">
                <AlertTitle>Loops will merge without waiting for CI</AlertTitle>
                <AlertDescription>
                  <p>No required check is named, so a loop merges its PR as soon as its own gates pass.</p>
                  <label className="mt-2 flex items-center gap-2 text-foreground">
                    <Checkbox
                      checked={noChecksAcknowledged}
                      onCheckedChange={(checked) => setNoChecksAcknowledged(checked === true)}
                    />
                    Set up without required checks
                  </label>
                </AlertDescription>
              </Alert>
            )}

            {/* The result and the buttons that produced it, scrolled into view together. */}
            <div ref={result} className="grid gap-4">
              {/* A clean Check is the footer's one-line status; only problems take an alert, to stay readable as a list. */}
              {problems !== null && problems.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>
                    {problems.length} problem{problems.length === 1 ? "" : "s"}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {failure !== null && (
                <Alert variant="destructive">
                  <AlertTitle>Setup did not go through</AlertTitle>
                  <AlertDescription className="whitespace-pre-wrap break-words">
                    <div>
                      <CommandNotice error={failure} />
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center gap-3 border-t pt-5">
                {/* Why the PR is held comes first: it is what the operator must act on before anything else. */}
                <p className="flex min-w-0 flex-1 basis-60 items-center gap-2 text-xs text-muted-foreground">
                  {trackerWaits !== null ? (
                    `Tracker: ${trackerWaits}.`
                  ) : withoutCi && !noChecksAcknowledged ? (
                    "Tick “Set up without required checks” above, or name a required check."
                  ) : problems !== null && problems.length === 0 ? (
                    <span className="flex items-center gap-2 text-status-success">
                      <CheckCircle2 aria-hidden className="size-4 shrink-0" />
                      The config is valid: project-config accepts it as it stands.
                    </span>
                  ) : (
                    "Check validates the config without opening anything."
                  )}
                </p>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void check()}>
                    {busy === "check" && <Loader2 className="animate-spin" />}
                    Check
                  </Button>
                  <Button type="submit" disabled={busy !== null || (withoutCi && !noChecksAcknowledged) || trackerWaits !== null}>
                    {busy === "submit" && <Loader2 className="animate-spin" />}
                    Open setup PR
                    {busy !== "submit" && <GitPullRequest aria-hidden />}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
