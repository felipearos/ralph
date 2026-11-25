/**
 * The machine's UsageBar reading: every provider the operator enabled in
 * UsageBar (CodexBar's Linux build), as `codexbar usage --format json` prints
 * it — the same windows the tray shows, read from the providers themselves
 * rather than from what the loops' logs happened to record.
 *
 * One argv and nothing else. The CLI exits non-zero whenever any one provider
 * failed, yet still prints every provider's entry, so stdout is narrowed
 * whatever the status: a provider's own error stays on its row, and only a
 * run that printed no JSON at all reads as unavailable. Never thrown: a host
 * without UsageBar simply has no card.
 *
 * Asked at most every `ttlMs`, and never waited on twice. The CLI calls the
 * providers' own usage endpoints, which rate-limit (Claude's OAuth usage
 * endpoint does), so a page polling every few seconds must not become a
 * caller polling Anthropic every few seconds. A stale reading is answered at
 * once while the next one is fetched behind it.
 *
 * The last good reading also outlives the server when it is given a
 * `memory`: UsageBar's tray keeps its last bars because it runs for days, but
 * the dashboard restarts, and a restart inside one of Claude's rate-limit
 * cooldowns (5 to 60 minutes, shared by every UsageBar process) would
 * otherwise show a bare error until the cooldown lifts.
 */
import type {
  DailySpendView,
  MachineSpendView,
  ModelSpendView,
  UsageBarProviderView,
  UsageBarView,
  UsageBarWindowView,
} from "./contracts";
import { createProcessExecutor, guarded, type Executor } from "./executor";

export const USAGEBAR_SURFACE = {
  usage: { command: "codexbar", args: ["usage", "--format", "json"] },
  // The cost view's 90 days: UsageBar's longest spend range.
  cost: { command: "codexbar", args: ["cost", "--format", "json", "--days", "90"] },
} as const;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * A window's name, as UsageBar's popover names it (`payload.js` windowLabel):
 * from its length, not from the CLI's `rateWindowLabels`, so the dashboard
 * and the tray call the same bar the same thing.
 */
export function windowName(minutes: number | null, slot: number): string {
  if (minutes === null) return ["Session", "Weekly", "Monthly"][slot] ?? "Window";
  if (minutes >= 40_000) return "Monthly";
  if (minutes >= 9_000) return "Weekly";
  if (minutes >= 1_440) return `${Math.ceil(minutes / 1_440)}-day`;
  if (slot === 0) return `Session (${Math.ceil(minutes / 60)}h)`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)}h`;
  return `${minutes}m`;
}

const SLOTS = ["primary", "secondary", "tertiary"] as const;

function windowView(raw: unknown, label: string, pace: string | null): UsageBarWindowView | null {
  const window = record(raw);
  const used = finite(window?.usedPercent);
  // UsageBar drops a window it synthesised for a lane the provider never reported.
  if (window === null || used === null || window.isSyntheticPlaceholder === true) return null;
  return {
    label,
    usedPercent: used,
    windowMinutes: finite(window.windowMinutes),
    resetsAt: text(window.resetsAt),
    resetDescription: text(window.resetDescription),
    pace,
  };
}

function providerView(value: unknown): UsageBarProviderView | null {
  const raw = record(value);
  const provider = text(raw?.provider);
  if (raw === null || provider === null) return null;
  const usage = record(raw.usage);
  const pace = record(raw.pace) ?? {};
  const identity = record(usage?.identity);
  const windows: UsageBarWindowView[] = [];
  // With no live session, Claude reports its weekly window in the session
  // slot too: the same length, reset and figure twice. Drawn once.
  const same = (left: UsageBarWindowView, right: UsageBarWindowView): boolean =>
    left.windowMinutes === right.windowMinutes && left.resetsAt === right.resetsAt && left.usedPercent === right.usedPercent;
  SLOTS.forEach((slot, index) => {
    const minutes = finite(record(usage?.[slot])?.windowMinutes);
    const view = windowView(usage?.[slot], windowName(minutes, index), text(record(pace[slot])?.summary));
    if (view === null) return;
    const twin = windows.findIndex((seen) => same(seen, view));
    if (twin < 0) windows.push(view);
    // The later slot carries the pace forecast; keep it on the one bar.
    else if (windows[twin]!.pace === null) windows[twin] = { ...windows[twin]!, pace: view.pace };
  });
  // Named per-model limits (Claude's Sonnet or Fable week, Codex Spark), drawn
  // like the standard windows, as UsageBar's card draws them.
  for (const extra of Array.isArray(usage?.extraRateWindows) ? usage.extraRateWindows : []) {
    const entry = record(extra);
    const label = text(entry?.title) ?? text(entry?.id);
    const view = label === null ? null : windowView(entry?.window, label, null);
    if (view !== null) windows.push(view);
  }
  const error = record(raw.error);
  return {
    provider,
    source: text(raw.source),
    account: text(usage?.accountEmail) ?? text(identity?.accountEmail) ?? text(raw.account),
    plan: text(usage?.loginMethod) ?? text(identity?.loginMethod),
    updatedAt: text(usage?.updatedAt),
    windows,
    error: error === null ? null : (text(error.message) ?? "provider fetch failed"),
    stale: false,
  };
}

/**
 * A failed provider's last good windows, carried into a fresh reading and
 * marked stale (UsageBar's `mergeStale`): a provider whose usage endpoint
 * rate-limits keeps the bars it last showed instead of blanking to an error.
 * A run that printed nothing at all keeps every bar it can, each provider
 * stale and carrying why the run failed.
 */
export function carryStale(previous: UsageBarView | null, fresh: UsageBarView): UsageBarView {
  if (previous?.state !== "read") return fresh;
  if (fresh.state === "unavailable") {
    const carried = previous.providers.filter((provider) => provider.windows.length > 0);
    if (carried.length === 0) return fresh;
    // The bars were measured then, not now: the run that failed measured nothing.
    return {
      state: "read",
      readAt: previous.readAt,
      providers: carried.map((provider) => ({ ...provider, error: fresh.why, stale: true })),
    };
  }
  if (fresh.state !== "read") return fresh;
  return {
    ...fresh,
    providers: fresh.providers.map((provider) => {
      if (provider.error === null || provider.windows.length > 0) return provider;
      const last = previous.providers.find((entry) => entry.provider === provider.provider && entry.windows.length > 0);
      if (last === undefined) return provider;
      return {
        ...provider,
        windows: last.windows,
        account: provider.account ?? last.account,
        plan: provider.plan ?? last.plan,
        updatedAt: last.updatedAt,
        stale: true,
      };
    }),
  };
}

/**
 * The bars carried from: a reading of every provider with windows, and when
 * each was last named by a run. Saved as is, so the rule holds after a restart.
 */
export type UsageBarBaseline = Extract<UsageBarView, { state: "read" }> & { seenAt: Record<string, string> };

/**
 * How long a provider a reading leaves out keeps its bars. `codexbar` names
 * every enabled provider, failed or not, so a long absence means it was
 * disabled; a short one is a partial read the bars should outlast.
 */
export const OMITTED_KEEP_MS = 6 * 60 * 60_000;

/**
 * The bars to carry from next time: every provider with windows in this
 * reading, and every one the reading left out kept from before while it was
 * named within `keepMs`, so a partial read never forgets a provider it did
 * not mention, and a disabled one does not come back. Pure.
 */
export function baselineOf(
  previous: UsageBarBaseline | null,
  view: UsageBarView,
  keepMs: number = OMITTED_KEEP_MS,
): UsageBarBaseline | null {
  if (view.state !== "read") return previous;
  const at = Date.parse(view.readAt);
  const current = view.providers.filter((provider) => provider.windows.length > 0);
  const named = new Set(view.providers.map((provider) => provider.provider));
  const seenAt: Record<string, string> = {};
  for (const provider of current) seenAt[provider.provider] = view.readAt;
  const kept = (previous?.providers ?? []).filter((provider) => {
    if (provider.windows.length === 0 || named.has(provider.provider)) return false;
    const seen = previous!.seenAt[provider.provider] ?? previous!.readAt;
    if (!(at - Date.parse(seen) < keepMs)) return false;
    seenAt[provider.provider] = seen;
    return true;
  });
  const providers = [...current, ...kept];
  return providers.length === 0 ? previous : { state: "read", readAt: view.readAt, providers, seenAt };
}

/** What the CLI printed, or why it is not a reading. Pure. */
export function narrowUsageBar(stdout: string, readAt: string): UsageBarView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "unavailable", readAt, why: "codexbar printed no JSON" };
  }
  if (!Array.isArray(parsed)) return { state: "unavailable", readAt, why: "codexbar printed an unexpected shape" };
  const providers = parsed.flatMap((entry) => {
    const view = providerView(entry);
    return view === null ? [] : [view];
  });
  return { state: "read", readAt, providers };
}

/** The first line of what a failed run said, without the CLI's library noise. */
function whyFailed(stderr: string, status: number | null): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !entry.includes("no version information available"));
  if (line !== undefined) return line;
  return status === null ? "codexbar could not be run" : `codexbar exited ${status} without output`;
}

/**
 * One provider's `codexbar cost` days as the dashboard's daily series.
 *
 * The CLI splits a day's tokens by model only as a total, so each model's
 * input, output and cache figures are the day's, in proportion to its share
 * of the day's tokens. Codex counts cache reads inside its input tokens
 * (UsageBar's `INPUT_INCLUDES_CACHE`); they are taken out so input means
 * uncached input for every provider. A model the CLI could not price keeps a
 * null cost, as a runner that reports none does.
 */
function costDays(entry: Record<string, unknown>): DailySpendView[] {
  const provider = text(entry.provider);
  if (provider === null || !Array.isArray(entry.daily)) return [];
  const days: DailySpendView[] = [];
  for (const raw of entry.daily) {
    const day = record(raw);
    const date = text(day?.date);
    if (day === null || date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const cacheRead = finite(day.cacheReadTokens) ?? 0;
    const rawInput = finite(day.inputTokens) ?? 0;
    const input = provider === "codex" ? Math.max(0, rawInput - cacheRead) : rawInput;
    const output = finite(day.outputTokens) ?? 0;
    const cacheWrite = finite(day.cacheCreationTokens) ?? 0;
    const total = finite(day.totalTokens) ?? input + output + cacheRead + cacheWrite;
    const breakdowns = (Array.isArray(day.modelBreakdowns) ? day.modelBreakdowns : []).flatMap((item) => {
      const model = record(item);
      const name = text(model?.modelName);
      return model === null || name === null ? [] : [{ name, tokens: finite(model.totalTokens) ?? 0, cost: finite(model.cost) }];
    });
    // A day with no split is one model, the provider's own.
    const parts = breakdowns.length > 0 ? breakdowns : [{ name: provider, tokens: total, cost: finite(day.totalCost) }];
    const models: ModelSpendView[] = parts.map((part) => {
      const share = total > 0 ? part.tokens / total : 1 / parts.length;
      return {
        // Ralph books Codex as `codex/<model>`; Claude models name themselves.
        model: part.name.startsWith("claude") ? part.name : `${provider}/${part.name}`,
        costUsd: part.cost,
        tokens: {
          input: Math.round(input * share),
          output: Math.round(output * share),
          cacheRead: Math.round(cacheRead * share),
          cacheWrite: Math.round(cacheWrite * share),
        },
      };
    });
    days.push({ date, models });
  }
  return days;
}

/** What `codexbar cost --format json` printed, as one daily series across providers. Pure. */
export function narrowUsageBarCost(stdout: string, readAt: string): MachineSpendView {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { state: "unavailable", readAt, why: "codexbar cost printed no JSON" };
  }
  if (!Array.isArray(parsed)) return { state: "unavailable", readAt, why: "codexbar cost printed an unexpected shape" };
  const byDate = new Map<string, ModelSpendView[]>();
  for (const entry of parsed) {
    const raw = record(entry);
    if (raw === null) continue;
    for (const day of costDays(raw)) byDate.set(day.date, [...(byDate.get(day.date) ?? []), ...day.models]);
  }
  const daily = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, models]) => ({ date, models }));
  return { state: "read", readAt, daily };
}

/**
 * A cached CLI read: answered from cache while fresh, refreshed behind a
 * stale answer, and never run twice at once.
 */
function cachedCli<T>(
  run: () => Promise<T>,
  ttlMs: number,
  now: () => number,
): { read(): Promise<T>; peek(): T | null; refresh(): Promise<T> } {
  let cached: { at: number; view: T } | null = null;
  let inFlight: Promise<T> | null = null;
  const refresh = (): Promise<T> => {
    inFlight ??= run()
      .then((view) => {
        cached = { at: now(), view };
        return view;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    read() {
      if (cached === null) return refresh();
      // The run degrades to a view of its own, so a refresh cannot reject;
      // the catch only keeps a future change from leaking an unhandled one.
      if (now() - cached.at >= ttlMs) refresh().catch(() => {});
      return Promise.resolve(cached.view);
    },
    peek() {
      if (cached !== null && now() - cached.at >= ttlMs) refresh().catch(() => {});
      return cached?.view ?? null;
    },
    refresh,
  };
}

/**
 * Where the last good reading outlives the server. Both calls may fail
 * silently: a lost memory only costs the stale bars after a restart.
 */
export interface UsageBarMemory {
  load(): unknown;
  save(view: UsageBarView): void;
}

/**
 * A remembered reading, if it still is one: only providers with windows are
 * kept, since only those can be carried. Pure.
 */
export function recalled(raw: unknown): UsageBarBaseline | null {
  const view = record(raw);
  if (view?.state !== "read" || !Array.isArray(view.providers)) return null;
  const readAt = text(view.readAt);
  if (readAt === null) return null;
  const providers = view.providers.flatMap((entry): UsageBarProviderView[] => {
    const provider = record(entry);
    const name = text(provider?.provider);
    if (provider === null || name === null || !Array.isArray(provider.windows)) return [];
    const windows = provider.windows.flatMap((item): UsageBarWindowView[] => {
      const window = record(item);
      const label = text(window?.label);
      const used = finite(window?.usedPercent);
      if (window === null || label === null || used === null) return [];
      return [
        {
          label,
          usedPercent: used,
          windowMinutes: finite(window.windowMinutes),
          resetsAt: text(window.resetsAt),
          resetDescription: text(window.resetDescription),
          pace: text(window.pace),
        },
      ];
    });
    if (windows.length === 0) return [];
    return [
      {
        provider: name,
        source: text(provider.source),
        account: text(provider.account),
        plan: text(provider.plan),
        updatedAt: text(provider.updatedAt),
        windows,
        error: null,
        stale: false,
      },
    ];
  });
  if (providers.length === 0) return null;
  const seen = record(view.seenAt) ?? {};
  const seenAt: Record<string, string> = {};
  for (const provider of providers) seenAt[provider.provider] = text(seen[provider.provider]) ?? readAt;
  return { state: "read", readAt, providers, seenAt };
}

export interface UsageBarAdapter {
  /** The providers' limit windows: `codexbar usage`, a second or two. */
  usage(): Promise<UsageBarView>;
  /**
   * The machine's daily spend: `codexbar cost`, which scans every session log
   * and takes minutes. Never waited on: before the first read lands it
   * answers `reading` and starts one.
   */
  cost(): Promise<MachineSpendView>;
}

export function createUsageBarAdapter(
  options: {
    exec?: Executor;
    /** Where the CLI runs; it reads only the operator's own config. */
    cwd?: string;
    env?: Record<string, string | undefined>;
    ttlMs?: number;
    timeoutMs?: number;
    /** How long a cost reading stands; it takes minutes to make. */
    costTtlMs?: number;
    costTimeoutMs?: number;
    /**
     * How long the very first limit read is waited on before the route
     * answers `reading` instead: a CLI that hangs to its timeout must not hold
     * the project's spend back with it.
     */
    firstWaitMs?: number;
    /** Where the last good reading outlives a restart; none keeps it in memory only. */
    memory?: UsageBarMemory;
    now?: () => number;
  } = {},
): UsageBarAdapter {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const costTimeoutMs = options.costTimeoutMs ?? 600_000;
  const exec = guarded(options.exec ?? createProcessExecutor({ timeoutMs }));
  const now = options.now ?? Date.now;

  const run = async <T>(
    surface: { command: string; args: readonly string[] },
    budget: number,
    narrow: (stdout: string, readAt: string) => T,
    unavailable: (readAt: string, why: string) => T,
  ): Promise<T> => {
    const result = await exec({
      command: surface.command,
      args: [...surface.args],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      timeoutMs: budget,
    });
    const readAt = new Date(now()).toISOString();
    return result.stdout.trim() === "" ? unavailable(readAt, whyFailed(result.stderr, result.status)) : narrow(result.stdout, readAt);
  };

  const remember = (view: UsageBarView): void => {
    try {
      options.memory?.save(view);
    } catch {
      // A reading that is not remembered only costs its bars after a restart.
    }
  };
  let lastUsage: UsageBarBaseline | null = null;
  try {
    lastUsage = recalled(options.memory?.load() ?? null);
  } catch {
    lastUsage = null;
  }
  const usage = cachedCli(
    async () => {
      const fresh = await run(USAGEBAR_SURFACE.usage, timeoutMs, narrowUsageBar, (readAt, why): UsageBarView => ({
        state: "unavailable",
        readAt,
        why,
      }));
      const merged = carryStale(lastUsage, fresh);
      // A run that printed nothing teaches nothing new: the baseline stands.
      const next = fresh.state === "read" ? baselineOf(lastUsage, merged) : lastUsage;
      if (next !== null && next !== lastUsage) {
        lastUsage = next;
        remember(next);
      }
      return merged;
    },
    options.ttlMs ?? 120_000,
    now,
  );
  const cost = cachedCli(
    () =>
      run(USAGEBAR_SURFACE.cost, costTimeoutMs, narrowUsageBarCost, (readAt, why): MachineSpendView => ({
        state: "unavailable",
        readAt,
        why,
      })),
    options.costTtlMs ?? 15 * 60_000,
    now,
  );

  const firstWaitMs = options.firstWaitMs ?? 4_000;
  return {
    usage: async () => {
      const view = usage.peek();
      if (view !== null) return view;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<UsageBarView>((resolve) => {
        timer = setTimeout(() => resolve({ state: "reading" }), firstWaitMs);
      });
      try {
        return await Promise.race([usage.refresh(), waited]);
      } finally {
        clearTimeout(timer);
      }
    },
    cost: async () => {
      const view = cost.peek();
      if (view !== null) return view;
      cost.refresh().catch(() => {});
      return { state: "reading" };
    },
  };
}
