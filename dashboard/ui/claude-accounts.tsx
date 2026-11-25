/**
 * Claude accounts, on the project's Settings page: the accounts this machine
 * has (registered, and found but not yet registered), adding and removing
 * them, and a pair of dropdowns per row — the project and each agent — for
 * which account it runs on and what happens when that account is out of
 * usage. Every change goes through `POST /api/claude-accounts`, which runs
 * the harness's `claude-account.ts`; the agents pick a change up before their
 * next iteration, with no commit and no restart.
 *
 * Local only, like the route: the accounts live on this machine.
 */
import { useEffect, useState } from "react";
import { Copy, Plus, RotateCcw } from "lucide-react";

import {
  CLAUDE_ACCOUNT_NAME_PATTERN,
  CLAUDE_ACCOUNTS_PROJECT_TARGET,
  type ClaudeAccountsAnswer,
  type ClaudeAccountsRequest,
  type ClaudeAccountsTargetView,
  type ClaudeAccountsView,
  type ClaudeAccountView,
} from "../contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Confirming } from "./agents";
import { LocalOnlyNote, useCommand } from "./command";
import { noticeText } from "./command-model";
import {
  accountOptions,
  choiceLine,
  defaultDir,
  ENV,
  formChanged,
  formFromTarget,
  INHERIT,
  limitOptions,
  loginCommand,
  requestFromForm,
  sourceLabel,
  unregistered,
  type RowForm,
} from "./claude-accounts-model";
import { Dot, TONE_TEXT } from "./shell-parts";
import { useClaudeAccounts } from "./use-reads";

const PATH = "/api/claude-accounts";

type Said = { ok: boolean; text: string } | null;

/** Send one change and settle it to a line to show; the read is refreshed whatever the answer. */
function useAccountsCommand(project: string, refresh: () => void) {
  const command = useCommand(PATH);
  const run = async (request: ClaudeAccountsRequest): Promise<Said> => {
    const result = await command.send<ClaudeAccountsAnswer>(request, { project });
    refresh();
    if (!result.ok) return result.error.kind === "Aborted" ? null : { ok: false, text: noticeText(result.error) };
    const answer = result.value;
    if (answer === null) return { ok: false, text: "The server answered nothing" };
    return { ok: answer.ok, text: answer.message };
  };
  return { ...command, run };
}

function SaidLine({ said }: { said: Said }) {
  if (said === null) return null;
  return <span className={cn("text-xs whitespace-pre-line", said.ok ? "text-muted-foreground" : TONE_TEXT.bad)}>{said.text}</span>;
}

export function ClaudeAccounts({ project }: { project: string }) {
  const { read, refresh } = useClaudeAccounts(project);
  // Loading, the remote page (which reads nothing), or a server without the route.
  if (read.state === "loading") return null;
  if (read.state === "error" && read.status === 404) return null;
  // A failed poll after a good one keeps the last answer.
  const view: ClaudeAccountsView | null = read.data;
  return (
    <div className="space-y-4" aria-label="Claude accounts">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Claude accounts</h2>
        <p className="text-sm text-muted-foreground">
          The Claude Code accounts this machine is logged in to, and which one each agent of the project runs on. A change applies at each agent's next
          iteration; nothing is committed and no agent restarts.
        </p>
        <LocalOnlyNote route={PATH} />
      </div>
      {view === null ? (
        <p className={cn("text-xs", TONE_TEXT.bad)}>{read.state === "error" ? read.message : "Unreadable"}</p>
      ) : view.problem !== null ? (
        <p className={cn("text-xs", TONE_TEXT.bad)}>{view.problem}</p>
      ) : (
        <>
          {view.problems.length > 0 && (
            <ul className={cn("list-disc space-y-0.5 pl-4 text-xs", TONE_TEXT.warn)}>
              {view.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <Assignments project={project} view={view} refresh={refresh} />
          <Accounts project={project} view={view} refresh={refresh} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ assignments */

function Assignments({ project, view, refresh }: { project: string; view: ClaudeAccountsView; refresh: () => void }) {
  if (view.accounts.length === 0) {
    return <p className="text-xs text-muted-foreground">Register an account below to choose which one the agents run on.</p>;
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Which account each agent runs on</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>When it is out of usage</TableHead>
            <TableHead>Now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <AssignmentRow
            project={project}
            label="All agents"
            target={CLAUDE_ACCOUNTS_PROJECT_TARGET}
            loop={false}
            own={false}
            state={view.project}
            accounts={view.accounts}
            refresh={refresh}
          />
          {view.loops.map((loop) => (
            <AssignmentRow
              key={loop.loop}
              project={project}
              label={loop.loop}
              target={loop.loop}
              loop
              own={loop.own}
              state={loop}
              accounts={view.accounts}
              refresh={refresh}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function AssignmentRow({
  project,
  label,
  target,
  loop,
  own,
  state,
  accounts,
  refresh,
}: {
  project: string;
  label: string;
  target: string;
  loop: boolean;
  own: boolean;
  state: ClaudeAccountsTargetView | null;
  accounts: ClaudeAccountView[];
  refresh: () => void;
}) {
  const initial = formFromTarget(state, loop, own, accounts);
  const [form, setForm] = useState<RowForm>(initial);
  const [said, setSaid] = useState<Said>(null);
  const command = useAccountsCommand(project, refresh);
  const key = `${initial.account}|${initial.onLimit}`;
  // Seeded per read, so a pick shows at once and the next read confirms it.
  useEffect(() => {
    setForm(initial);
  }, [key]);

  const save = async (next: RowForm) => {
    setForm(next);
    if (!formChanged(initial, next)) return;
    setSaid(null);
    const answer = await command.run(requestFromForm(target, next, accounts));
    setSaid(answer !== null && answer.ok ? null : answer);
  };
  const picked = form.account !== INHERIT && form.account !== ENV;
  const now = state === null ? null : choiceLine(state.choice);
  const disabled = command.disabled || command.pending;
  return (
    <TableRow>
      <TableCell className="font-medium">
        {loop ? <span className="font-mono">{label}</span> : label}
        {state !== null && state.source !== "none" && <div className="text-xs font-normal text-muted-foreground">{sourceLabel(state.source)}</div>}
      </TableCell>
      <TableCell>
        <Select
          value={form.account}
          disabled={disabled}
          onValueChange={(account) => void save({ account, onLimit: form.onLimit === "" ? "wait" : limitKept(form.onLimit, account) })}
        >
          <SelectTrigger size="sm" className="w-64" aria-label={`Account for ${label}`} title={command.why ?? undefined}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {accountOptions(accounts, loop).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {picked ? (
          <Select value={form.onLimit} disabled={disabled} onValueChange={(onLimit) => void save({ ...form, onLimit })}>
            <SelectTrigger size="sm" className="w-56" aria-label={`When ${label}'s account is out of usage`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {limitOptions(accounts, form.account).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {now !== null && (
          <span className={cn("inline-flex items-center gap-1.5 text-xs", TONE_TEXT[now.tone])} title={state?.choice.detail}>
            <Dot tone={now.tone} />
            {command.pending ? "Saving…" : now.text}
          </span>
        )}
        <div>
          <SaidLine said={said} />
        </div>
      </TableCell>
    </TableRow>
  );
}

/** A limit policy that names the account just picked as its fallback makes no sense: fall back to waiting. */
function limitKept(onLimit: string, account: string): string {
  return onLimit === `next:${account}` ? "wait" : onLimit;
}

/* --------------------------------------------------------------- accounts */

function Accounts({ project, view, refresh }: { project: string; view: ClaudeAccountsView; refresh: () => void }) {
  const found = unregistered(view.detected);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Accounts on this machine</h3>
        {view.accounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No account registered yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Logged in as</TableHead>
                <TableHead>Directory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.accounts.map((account) => (
                <AccountRow key={account.name} project={project} account={account} refresh={refresh} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      {found.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Found on this machine, not registered</h3>
          <div className="space-y-2">
            {found.map((entry) => (
              <AddAccount
                key={entry.configDir}
                project={project}
                refresh={refresh}
                initialName={entry.suggestedName}
                dir={entry.configDir}
                who={entry.email === null ? (entry.loggedIn ? "logged in" : "not logged in") : `${entry.email}${entry.organization === null ? "" : ` (${entry.organization})`}`}
              />
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Add another account</h3>
        <AddAccount project={project} refresh={refresh} initialName="" dir={null} who={null} />
      </div>
    </div>
  );
}

function AccountRow({ project, account, refresh }: { project: string; account: ClaudeAccountView; refresh: () => void }) {
  const command = useAccountsCommand(project, refresh);
  const [said, setSaid] = useState<Said>(null);
  const [copied, setCopied] = useState(false);
  const limited = account.limitedUntil !== null;
  return (
    <TableRow>
      <TableCell className="font-mono">{account.name}</TableCell>
      <TableCell className="text-xs">
        {account.email ?? <span className="text-muted-foreground">—</span>}
        {account.organization !== null && <div className="text-muted-foreground">{account.organization}</div>}
      </TableCell>
      <TableCell className="font-mono text-xs">{account.configDir}</TableCell>
      <TableCell className="text-xs">
        {!account.loggedIn ? (
          <div className="space-y-1">
            <span className={TONE_TEXT.warn}>Not logged in. In a terminal, run:</span>
            <div className="flex items-center gap-1">
              <code className="rounded bg-muted px-1 py-0.5">{loginCommand(account.configDir)}</code>
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                title="Copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(`CLAUDE_CONFIG_DIR=${account.configDir} claude`).then(() => setCopied(true));
                }}
              >
                <Copy className="size-3" />
              </Button>
              {copied && <span className="text-muted-foreground">copied</span>}
            </div>
          </div>
        ) : limited ? (
          <span className={TONE_TEXT.warn}>Out of usage until {new Date(account.limitedUntil!).toLocaleString()}</span>
        ) : (
          <span className={TONE_TEXT.good}>Available</span>
        )}
        <div>
          <SaidLine said={said} />
        </div>
      </TableCell>
      <TableCell className="space-x-2 text-right whitespace-nowrap">
        {limited && (
          <Button
            size="sm"
            variant="outline"
            disabled={command.disabled || command.pending}
            title="Forget the spent-limit mark: agents try this account again at their next iteration"
            onClick={() => void command.run({ action: "clear-limit", name: account.name }).then(setSaid)}
          >
            <RotateCcw className="size-3.5" />
            Clear limit
          </Button>
        )}
        <Confirming
          label="Remove"
          confirm={`Remove ${account.name}`}
          busy={command.pending}
          unavailable={command.disabled}
          why={command.why}
          armedDetails={
            <span className="text-xs text-muted-foreground">
              Agents set to {account.name} skip it from their next iteration. Its login stays in {account.configDir}.
            </span>
          }
          onConfirm={() => void command.run({ action: "remove", name: account.name }).then(setSaid)}
        />
      </TableCell>
    </TableRow>
  );
}

function AddAccount({
  project,
  refresh,
  initialName,
  dir,
  who,
}: {
  project: string;
  refresh: () => void;
  initialName: string;
  /** A found directory, fixed; null to type one. */
  dir: string | null;
  who: string | null;
}) {
  const command = useAccountsCommand(project, refresh);
  const [name, setName] = useState(initialName);
  const [typedDir, setTypedDir] = useState("");
  const [said, setSaid] = useState<Said>(null);
  const trimmed = name.trim();
  const nameOk = CLAUDE_ACCOUNT_NAME_PATTERN.test(trimmed);
  const target = dir ?? (typedDir.trim() === "" ? (nameOk ? defaultDir(trimmed) : "") : typedDir.trim());
  const submit = async () => {
    setSaid(null);
    const answer = await command.run({ action: "add", name: trimmed, dir: target });
    setSaid(answer);
    if (answer?.ok && dir === null) {
      setName("");
      setTypedDir("");
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (nameOk && target !== "") void submit();
      }}
    >
      {dir !== null && (
        <span className="min-w-0 text-xs">
          <span className="font-mono">{dir}</span>
          {who !== null && <span className="text-muted-foreground"> — {who}</span>}
        </span>
      )}
      <Input
        className="h-8 w-40 font-mono"
        aria-label="Account name"
        placeholder="name, e.g. work"
        value={name}
        disabled={command.disabled}
        onChange={(event) => setName(event.target.value)}
      />
      {dir === null && (
        <Input
          className="h-8 w-64 font-mono"
          aria-label="Config directory"
          placeholder={nameOk ? defaultDir(trimmed) : "~/.claude-<name>"}
          value={typedDir}
          disabled={command.disabled}
          onChange={(event) => setTypedDir(event.target.value)}
        />
      )}
      <Button type="submit" size="sm" variant={dir === null ? "default" : "outline"} disabled={!nameOk || target === "" || command.disabled || command.pending}>
        <Plus className="size-3.5" />
        {command.pending ? "Adding…" : dir === null ? "Add account" : "Register"}
      </Button>
      {trimmed !== "" && !nameOk && <span className={cn("text-xs", TONE_TEXT.warn)}>Lowercase letters, digits, - or _</span>}
      <SaidLine said={said} />
    </form>
  );
}
