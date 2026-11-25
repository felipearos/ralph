/**
 * The Claude accounts section on the page, as pure functions: the options of
 * the two dropdowns each row has (which account, and what a spent limit does),
 * the request a pick sends, and the line that says what a loop runs on now.
 * The view (`claude-accounts.tsx`) only draws these.
 *
 * A row's first dropdown is the account: for the project, "Default" (this
 * machine's account, or the committed config's rule) or a registered
 * account; for a loop, "Same as project", "This machine's default" or an
 * account. Its second, shown once an account is picked, is the limit policy:
 * wait for the reset, switch to another account (one, or any), or stop.
 */
import {
  CLAUDE_ACCOUNTS_PROJECT_TARGET,
  type ClaudeAccountChoiceView,
  type ClaudeAccountsRequest,
  type ClaudeAccountsTargetView,
  type ClaudeAccountView,
  type ClaudeAccountDetectedView,
  type ClaudeAccountsSource,
} from "../contracts";

/** The account dropdown's non-account values. */
export const INHERIT = "__inherit";
export const ENV = "__env";
/** The limit dropdown's "switch to any other account". */
export const NEXT_ANY = "next:*";

export interface Option {
  value: string;
  label: string;
}

export interface RowForm {
  account: string;
  onLimit: string;
}

const isOverride = (source: ClaudeAccountsSource): boolean => source === "override" || source === "override-project";

/** "work · someone@example.org", or the bare name when the profile says nothing. */
export function accountLabel(account: Pick<ClaudeAccountView, "name" | "email">): string {
  return account.email === null ? account.name : `${account.name} · ${account.email}`;
}

/** The account dropdown's options for the project row (`loop` false) or a loop's. */
export function accountOptions(accounts: readonly ClaudeAccountView[], loop: boolean): Option[] {
  const head: Option[] = loop
    ? [
        { value: INHERIT, label: "Same as project" },
        { value: ENV, label: "This machine's default account" },
      ]
    : [{ value: INHERIT, label: "Default (this machine's account)" }];
  return [...head, ...accounts.map((account) => ({ value: account.name, label: accountLabel(account) }))];
}

/** The limit dropdown's options once `primary` is picked. */
export function limitOptions(accounts: readonly ClaudeAccountView[], primary: string): Option[] {
  const others = accounts.filter((account) => account.name !== primary);
  return [
    { value: "wait", label: "Wait for it to reset" },
    ...others.map((account) => ({ value: `next:${account.name}`, label: `Switch to ${account.name}` })),
    ...(others.length > 1 ? [{ value: NEXT_ANY, label: "Switch to any other account" }] : []),
    { value: "stop", label: "Stop the agent" },
  ];
}

/**
 * The form a row opens with, from what applies to it now. A rule that comes
 * from the committed config (or, for a loop, from the project) shows as the
 * inherited choice: picking an account writes this host's override over it.
 */
export function formFromTarget(target: ClaudeAccountsTargetView | null, loop: boolean, own: boolean, accounts: readonly ClaudeAccountView[]): RowForm {
  const fallback = { account: INHERIT, onLimit: "wait" };
  if (target === null) return fallback;
  const overridden = loop ? own : isOverride(target.source);
  if (!overridden) return fallback;
  if (target.rule === null) return { account: loop ? ENV : INHERIT, onLimit: "wait" };
  const [primary, ...rest] = target.rule.use;
  if (primary === undefined) return fallback;
  if (target.rule.onLimit !== "next") return { account: primary, onLimit: target.rule.onLimit };
  const others = accounts.filter((account) => account.name !== primary).map((account) => account.name);
  const any = rest.length > 1 && rest.length === others.length && rest.every((name) => others.includes(name));
  return { account: primary, onLimit: any ? NEXT_ANY : rest[0] === undefined ? "wait" : `next:${rest[0]}` };
}

/** The request a row's form sends for `target` (`*` for the project). */
export function requestFromForm(target: string, form: RowForm, accounts: readonly ClaudeAccountView[]): ClaudeAccountsRequest {
  if (form.account === INHERIT) return { action: "unassign", target };
  if (form.account === ENV && target !== CLAUDE_ACCOUNTS_PROJECT_TARGET) return { action: "assign-env", target };
  if (form.account === ENV) return { action: "unassign", target };
  if (form.onLimit === "wait" || form.onLimit === "stop") return { action: "assign", target, use: [form.account], onLimit: form.onLimit };
  const others = accounts.filter((account) => account.name !== form.account).map((account) => account.name);
  const fallback = form.onLimit === NEXT_ANY ? others : [form.onLimit.replace(/^next:/, "")];
  return { action: "assign", target, use: [form.account, ...fallback.filter((name) => name !== form.account)], onLimit: "next" };
}

/** Whether a form says something other than what the row opened with. */
export function formChanged(before: RowForm, after: RowForm): boolean {
  return before.account !== after.account || (after.account !== INHERIT && after.account !== ENV && before.onLimit !== after.onLimit);
}

/** Where the rule in effect comes from, in a few words. */
export function sourceLabel(source: ClaudeAccountsSource): string {
  switch (source) {
    case "override":
      return "set here";
    case "override-project":
      return "project setting";
    case "config-loop":
    case "config":
      return "from .ralph/config.json";
    case "none":
      return "no account chosen";
  }
}

export type Tone = "good" | "warn" | "bad" | "neutral";

/** What a row runs on now, and how worrying that is. */
export function choiceLine(choice: ClaudeAccountChoiceView, format: (iso: string) => string = (iso) => new Date(iso).toLocaleString()): { text: string; tone: Tone } {
  const until = /reset(?:s)? at (\S+)|until (\S+)/.exec(choice.detail);
  const when = until === null ? null : (until[1] ?? until[2] ?? null);
  const at = when !== null && !Number.isNaN(Date.parse(when)) ? ` until ${format(when)}` : "";
  switch (choice.verdict) {
    case "default":
      return { text: "Runs on this machine's default account", tone: "neutral" };
    case "run":
      return { text: `Runs on ${choice.account ?? "?"}`, tone: "good" };
    case "wait":
      return { text: `Waiting for ${choice.account ?? "its account"}${at}`, tone: "warn" };
    case "stop":
      return { text: `Stops: ${choice.account ?? "its account"} is out of usage${at}`, tone: "bad" };
  }
}

/** The directories found on the host that are not registered yet. */
export function unregistered(detected: readonly ClaudeAccountDetectedView[]): ClaudeAccountDetectedView[] {
  return detected.filter((entry) => entry.registeredAs === null);
}

/** The shell line that logs an account in; the page cannot run `/login` for it. */
export function loginCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR=${configDir} claude   # then /login`;
}

/** The directory a new account named `name` gets when the operator leaves it blank. */
export function defaultDir(name: string): string {
  return `~/.claude-${name}`;
}
