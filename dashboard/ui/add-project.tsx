/**
 * The add-project dialog, reached from the switcher's last item: a project
 * from a local checkout, or cloned from GitHub. The view logic is in
 * `onboarding-model.ts`; every rule is the server's.
 */
import { Check, CircleAlert, CloudDownload, FolderGit2, FolderOpen, Loader2, Lock, Plus, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { AddProjectResult, FolderPickResult, GithubReposView } from "../contracts";
import { CommandNotice, send, useCommandAvailability } from "./command";
import { EMPTY_ANSWER } from "./command-model";
import { addRequest, cloneTarget, filterRepos, inputRefusal, refusalView, type AddTab, type RefusalView } from "./onboarding-model";
import { HelpTip } from "./help-tip";
import { TrackerMark } from "./tracker-marks";
import { useGithubRepos } from "./use-reads";

/** Each source says what adding from it does, so the choice is made knowing the outcome. */
const SOURCES: readonly { id: AddTab; title: string; blurb: ReactNode; icon: LucideIcon | "github" }[] = [
  {
    id: "local",
    title: "Local checkout",
    blurb: "A git checkout already on this host. Ralph registers its main checkout.",
    icon: FolderGit2,
  },
  {
    id: "github",
    title: "Clone from GitHub",
    blurb: (
      <>
        Cloned with <code className="font-mono">gh</code> into <code className="font-mono">~/&lt;name&gt;</code>, then
        added like a local checkout.
      </>
    ),
    icon: "github",
  },
];

function SourcePicker({ source, onPick }: { source: AddTab; onPick: (source: AddTab) => void }) {
  return (
    <div className="grid grid-cols-1 overflow-hidden border sm:grid-cols-2" role="group" aria-label="Add from">
      {SOURCES.map(({ id, title, blurb, icon: Icon }) => {
        const picked = id === source;
        const iconClass = cn("size-4 shrink-0", picked ? "text-foreground" : "text-muted-foreground");
        return (
          <button
            key={id}
            type="button"
            aria-pressed={picked}
            onClick={() => onPick(id)}
            className={cn(
              "-mr-px -mb-px border-r border-b px-3.5 py-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
              picked && "bg-foreground/[0.07] shadow-[inset_2px_0_0_var(--foreground)] hover:bg-foreground/[0.07]",
            )}
          >
            <span className="flex items-center gap-2">
              {Icon === "github" ? <TrackerMark kind="github" className={iconClass} /> : <Icon aria-hidden className={iconClass} />}
              <span className="flex-1 text-xs font-semibold">{title}</span>
              {picked && <Check aria-hidden className="size-3.5 shrink-0" />}
            </span>
            <span className="mt-1 block pl-6 text-xs text-muted-foreground">{blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The operator's own repos (`gh repo list` leaves out org repos they do not
 * own), counted as the filter narrows them so an empty list reads as "no
 * match" rather than "nothing loaded".
 */
function RepoList({
  repos,
  query,
  onPick,
  onRetry,
}: {
  repos: Repos;
  query: string;
  onPick: (nameWithOwner: string) => void;
  onRetry: () => void;
}) {
  if (repos.state === "error") {
    return (
      <div className="flex items-center justify-between gap-3 border px-3 py-2.5 text-xs text-status-bad">
        <span className="min-w-0">Could not list repositories: {repos.message}</span>
        <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  const total = repos.state === "ready" ? repos.data.repos.length : null;
  const shown = repos.state === "ready" ? filterRepos(repos.data.repos, query) : [];
  return (
    <div className="border">
      <div className="flex justify-between border-b px-3 py-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        <span>Your repositories</span>
        <span aria-live="polite">
          {total === null ? (
            "…"
          ) : shown.length === total ? (
            <span className="text-foreground">{total}</span>
          ) : (
            <>
              {shown.length} of <span className="text-foreground">{total}</span> match
            </>
          )}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto">
        {repos.state === "loading" ? (
          <div className="grid gap-2 p-3" role="status" aria-label="Listing your repositories">
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7 opacity-60" />
          </div>
        ) : shown.length === 0 ? (
          <p className="px-3 py-3.5 text-xs text-muted-foreground">
            {total === 0 ? "You have no repositories of your own." : "None of your repos match."} A full{" "}
            <code className="font-mono">owner/name</code> still clones any repo you can read, org repos included.
          </p>
        ) : (
          <ul>
            {shown.map((entry) => {
              const picked = query.trim() === entry.nameWithOwner;
              const slash = entry.nameWithOwner.indexOf("/");
              return (
                <li key={entry.nameWithOwner} className="border-b border-border/50 last:border-b-0">
                  <button
                    type="button"
                    aria-pressed={picked}
                    onClick={() => onPick(entry.nameWithOwner)}
                    className={cn(
                      "grid w-full grid-cols-[1fr_auto] items-center gap-2.5 px-3 py-2 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
                      picked && "bg-foreground/[0.07] shadow-[inset_2px_0_0_var(--foreground)] hover:bg-foreground/[0.07]",
                    )}
                  >
                    <span className="grid min-w-0">
                      <span className="truncate font-mono text-xs">
                        <span className="text-muted-foreground">{entry.nameWithOwner.slice(0, slash + 1)}</span>
                        <span className="font-semibold">{entry.nameWithOwner.slice(slash + 1)}</span>
                      </span>
                      {entry.description !== null && (
                        <span className="mt-0.5 truncate text-xs text-muted-foreground">{entry.description}</span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {entry.isPrivate && (
                        <span className="flex items-center gap-1 border px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wide text-muted-foreground uppercase">
                          <Lock aria-hidden className="size-2.5" />
                          Private
                        </span>
                      )}
                      {picked && <Check aria-hidden className="size-3.5" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The button on the right, and on the left what pressing it will do. */
function FormFooter({ note, children }: { note: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-4">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{note}</p>
      {children}
    </div>
  );
}

type Repos = { state: "loading" } | { state: "ready"; data: GithubReposView } | { state: "error"; message: string };

export function AddProjectDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the registered project once the server accepts it. */
  onAdded: (result: AddProjectResult) => void;
}) {
  const [tab, setTab] = useState<AddTab>("local");
  const [path, setPath] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [refusal, setRefusal] = useState<RefusalView | null>(null);
  // Listed once per open: the repo list does not change while picking. The
  // read is held from the first time the GitHub tab shows until the dialog
  // closes, so switching tabs does not list again; closing lets the store
  // forget it, and the next open lists afresh.
  const [listing, setListing] = useState(false);
  const { read: reposRead, reload: reloadRepos, busy: reposBusy } = useGithubRepos(listing);
  const reposFailed = reposRead.state === "error";
  useEffect(() => {
    if (!open) setListing(false);
    else if (tab === "github") {
      setListing(true);
      // A failed listing is asked again on coming back to the tab, as it was
      // before the store: the operator may have just fixed `gh auth`.
      if (reposFailed) reloadRepos();
    }
    // Only a tab change retries; a failure arriving must not re-ask at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab]);
  // A retry keeps the failed snapshot while it asks, so the busy flag is what shows it is listing again.
  const repos: Repos =
    reposBusy && reposRead.state === "error"
      ? { state: "loading" }
      : reposRead.state === "ready"
      ? { state: "ready", data: reposRead.data }
      : reposRead.state === "error"
        ? { state: "error", message: reposRead.message }
        : { state: "loading" };

  const target = cloneTarget(repo);

  const reset = () => {
    setPath("");
    setRepo("");
    setRefusal(null);
    setBusy(false);
  };

  // The server opens the host's own folder dialog: a page cannot learn a
  // folder's absolute path from the browser's picker. Only the machine has
  // one, so the remote page is not offered it.
  const picker = useCommandAvailability("/api/projects/pick-folder");

  const browse = async () => {
    setPicking(true);
    setRefusal(null);
    const answer = await send<FolderPickResult>("/api/projects/pick-folder");
    setPicking(false);
    if (!answer.ok) {
      // A pick refusal names no checkout to register.
      setRefusal({ error: answer.error, registerLocal: null });
      return;
    }
    if (answer.value === null) {
      setRefusal(refusalView(EMPTY_ANSWER));
      return;
    }
    if (answer.value.path !== null) setPath(answer.value.path);
  };

  const submit = async (as: AddTab, input: string) => {
    const request = addRequest(as, input);
    if ("error" in request) {
      setRefusal(inputRefusal(request.error));
      return;
    }
    setBusy(true);
    setRefusal(null);
    const answer = await send<AddProjectResult>("/api/projects", request.body);
    setBusy(false);
    if (!answer.ok) {
      setRefusal(refusalView(answer.error));
      return;
    }
    if (answer.value === null) {
      setRefusal(refusalView(EMPTY_ANSWER));
      return;
    }
    reset();
    onAdded(answer.value);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      {/* Wide enough to show a whole checkout path, not just its first folders. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Pick a checkout on this machine, or clone one of your GitHub repos.
          </DialogDescription>
        </DialogHeader>

        <SourcePicker
          source={tab}
          onPick={(next) => {
            setTab(next);
            setRefusal(null);
          }}
        />

        {tab === "local" ? (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit("local", path);
            }}
          >
            <div className="grid gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label htmlFor="add-project-path">Checkout path</Label>
                <HelpTip label="About the checkout path">
                  An absolute path to any folder in the repo, a worktree included. Ralph adds the repo's main checkout and names
                  the project after its folder.
                </HelpTip>
              </span>
              <div className="flex gap-2">
                <Input
                  id="add-project-path"
                  className="font-mono"
                  placeholder="/home/you/widget"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  autoFocus
                />
                {!picker.disabled && (
                  <Button type="button" variant="outline" className="shrink-0" disabled={busy || picking} onClick={() => void browse()}>
                    {picking ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                    Browse…
                  </Button>
                )}
              </div>
            </div>
            <FormFooter
              note={
                <>
                  Without a committed <code className="font-mono">.ralph/config.json</code> it's added as needing setup, and you
                  set it up next.
                </>
              }
            >
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Plus />}
                Add project
              </Button>
            </FormFooter>
          </form>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit("github", repo);
            }}
          >
            <div className="grid gap-1.5">
              <span className="flex items-center gap-1.5">
                <Label htmlFor="add-project-repo">Repository</Label>
                <HelpTip label="About cloning">
                  Pick one of yours, or paste any owner/name you can read. It is cloned with gh into ~/&lt;name&gt;; if that
                  folder already exists nothing is cloned, and you can add the folder as a local checkout instead.
                </HelpTip>
              </span>
              <Input
                id="add-project-repo"
                className="font-mono"
                placeholder="owner/name, or filter the list"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                autoFocus
              />
            </div>
            <RepoList repos={repos} query={repo} onPick={setRepo} onRetry={reloadRepos} />
            <FormFooter
              note={
                target === null ? (
                  "Pick a repo or paste owner/name."
                ) : (
                  <>
                    Clones <span className="font-medium text-foreground">{target.repo}</span> into{" "}
                    <code className="font-mono">{target.folder}</code>, then adds it.
                  </>
                )
              }
            >
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <CloudDownload />}
                Clone and add
              </Button>
            </FormFooter>
          </form>
        )}

        {refusal !== null && (
          <div role="alert" className="flex items-start gap-2.5 border border-l-2 border-status-bad/35 border-l-status-bad bg-status-bad/[0.05] px-3 py-2.5 text-sm">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-status-bad" />
            <div className="min-w-0">
              <p className="font-semibold text-status-bad">Not added</p>
              {/* A div, not a p: a refusal's problems can be a list. */}
              <div className="mt-0.5 break-words text-muted-foreground">
                <CommandNotice error={refusal.error} />
              </div>
              {refusal.registerLocal !== null && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2.5"
                  disabled={busy}
                  onClick={() => void submit("local", refusal.registerLocal!)}
                >
                  <FolderGit2 />
                  Add {refusal.registerLocal} as a local checkout
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
