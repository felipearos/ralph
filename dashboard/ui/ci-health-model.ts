/**
 * The CI health panel's derivations (felipearos/ralph#160).
 *
 * The panel answers what an operator asks about CI itself rather than about a
 * loop: is the base branch green and since when, is anything broken outside
 * the repository, which tests are flaking and what they have cost, which
 * tickets are parked behind them, and what the doctor has spent today.
 *
 * All of it comes from one read of the ci-doctor's store, which the
 * aggregation has already put on the `Dashboard` — no fetch, no network, as
 * the ticket requires. What is left is picking the honest shape, which is what
 * lives here: `.tsx` has no tests, so every decision this panel makes is made
 * in this file.
 */
import {
  doctors,
  type CiCaseView,
  type CiHealthView,
  type CiMainState,
  type CiMetricsView,
  type CiRetriesView,
  type CiWaitsView,
  type Dashboard,
  type DashboardLoop,
} from "../contracts";

/**
 * How many case rows the flake table draws.
 *
 * Only `cases` is capped. The incidents, the parked tickets and the reverts
 * are each bounded by their nature — a project with twelve open infra
 * incidents has one problem, not twelve — and a hidden incident would be the
 * one row worth seeing.
 */
export const CASE_ROW_LIMIT = 12;

/** One roster doctor and the case it holds. */
export interface CiHealthDoctorRow {
  loop: string;
  /** Null when it holds nothing, and null when the store was not read. */
  case: CiCaseView | null;
}

export interface CiHealthPanelView {
  /**
   * The store's picture. Null when the store could not be READ at all —
   * unknown, never an empty CI. A MISSING store is not this case: it folds to
   * an empty view, because a project whose doctor has never run has nothing to
   * report and that is a complete answer (#160's fourth acceptance criterion).
   */
  health: CiHealthView | null;
  /** Why `health` is null, when it is. */
  problem: string | null;
  /** When the read was taken; null when none was. */
  readAt: string | null;
  /** One row per ci-doctor on the roster, in roster order. */
  doctors: CiHealthDoctorRow[];
  /** Cases past `CASE_ROW_LIMIT`, so a truncated table says so. */
  moreCases: number;
}

/**
 * The panel, or null when this project staffs no ci-doctor.
 *
 * Null rather than an empty panel, for the reason `triagePanel` is: a project
 * with no doctor has nobody measuring CI, and a panel of zeroes beside a green
 * main would read as healthy CI rather than as a question nobody is asking.
 *
 * A project that DOES staff one and has no store on disk gets the empty panel.
 * That is the acceptance criterion, and `dashboard/ci-health.ts` already folds
 * a missing, truncated or wrong-version store to an empty view, so the whole
 * of the work here is not second-guessing it.
 */
export function ciHealthPanel(data: Dashboard): CiHealthPanelView | null {
  const rows = doctors(data.loops);
  if (rows.length === 0) return null;
  const read = data.ciHealth ?? null;
  const health = read?.view ?? null;
  return {
    health: health === null ? null : { ...health, cases: health.cases.slice(0, CASE_ROW_LIMIT) },
    problem: read === null ? "the adapter supplied no CI health read" : read.problem,
    readAt: read?.readAt ?? null,
    doctors: rows.map((entry) => ({ loop: entry.loop, case: entry.case })),
    moreCases: health === null ? 0 : Math.max(0, health.cases.length - CASE_ROW_LIMIT),
  };
}

/* ----------------------------------------------- the 14-day trend (#163) */

/** One day of the trend, with the bar heights the panel draws it at. */
export interface CiTrendBar {
  /** `2026-10-05`. */
  day: string;
  /** `Mon 5 Oct` — the axis label, short enough for fourteen of them. */
  label: string;
  knownFlakeReds: number;
  parkedOnFlake: number;
  /**
   * 0–100, as a percentage of the window's peak, and exactly what the panel
   * draws — floor included, so the tested number is the drawn number.
   */
  redHeight: number;
  parkedHeight: number;
  /** The last day, which is the day of the read. */
  today: boolean;
  /**
   * What the x-axis prints under this day: `Today` under the last, a short
   * `Mon 26` every third day counted back from it, and "" otherwise —
   * fourteen labels side by side would not fit and would collide.
   */
  axisLabel: string;
  /** The popover's three lines, and `aria` the same words in one string. */
  detail: { label: string; reds: string; parked: string; aria: string };
  /**
   * Whether the popover opens to the LEFT of the column: true for the right
   * half of the window, so a popover near the right edge never overflows the
   * card.
   */
  flip: boolean;
}

export interface CiTrendView {
  bars: CiTrendBar[];
  /**
   * The top of the shared scale: the largest of either counter across the
   * window, or 0 when nothing happened.
   *
   * ONE scale for both series, not one each. The two are counts of different
   * things, but the panel draws them side by side and a reader compares their
   * heights whatever a caption says — so scaling them independently would make
   * one parked ticket look like eleven flake reds.
   */
  peak: number;
  reds: number;
  parkedPeak: number;
  /** Known-flake reds on the last day, for the header's "today" figure. */
  todayReds: number;
  /**
   * The y-axis tick values, highest first: the peak, its rounded half and 0,
   * with duplicates dropped (a peak of 1 halves to 1, so it is `[1, 0]`).
   */
  ticks: number[];
  /** Whether the doctor has recorded any day at all. */
  recorded: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A UTC day key as a short label. Built from the key's own three numbers
 * through `Date.UTC`, never `new Date("2026-10-05").toLocaleDateString()`:
 * that parses as midnight UTC and then prints in the READER's zone, so an
 * operator west of Greenwich would see every bar labelled a day early.
 */
const dayLabel = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) return day;
  const at = new Date(Date.UTC(year, month - 1, date));
  if (Number.isNaN(at.getTime())) return day;
  return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
};

/**
 * How tall a bar is drawn, as a percentage of the window's peak.
 *
 * A non-zero count gets a floor of 2% — a day with one red against a peak of
 * fifty rounds to 2% anyway, but one against a peak of a hundred rounds to 1
 * and then to nothing visible, and "one red" must not draw the same as "none".
 * The floor lives here rather than in the panel because the panel has no
 * tests, and a `.tsx` that adjusted these numbers would make the figures this
 * module is tested on not the figures a reader sees.
 */
const barHeight = (value: number, peak: number): number => {
  if (peak === 0 || value <= 0) return 0;
  return Math.max(Math.round((value / peak) * 100), 2);
};

/** Every third day carries an x-axis label, counted back from today. */
const AXIS_EVERY = 3;

/**
 * The y-axis ticks for a peak. A Set because the half rounds onto an end for
 * small peaks — 1 halves to 1 — and two labels at one height would print on
 * top of each other.
 */
export const trendTicks = (peak: number): number[] =>
  peak <= 0 ? [0] : [...new Set([peak, Math.round(peak / 2), 0])];

/** `Mon 5 Oct` → `Mon 5`: the month is redundant inside one fortnight. */
const shortLabel = (label: string): string => label.split(" ").slice(0, 2).join(" ");

/**
 * One day's popover wording. "parked" takes no plural, so only the reds need
 * agreeing.
 */
export const trendDetail = (label: string, reds: number, parked: number): CiTrendBar["detail"] => {
  const redsText = `${reds} known-flake red${reds === 1 ? "" : "s"}`;
  const parkedText = `${parked} parked`;
  return { label, reds: redsText, parked: parkedText, aria: `${label}: ${redsText}, ${parkedText}` };
};

/** The trend the panel draws, from the view the store was folded into. */
export function ciTrend(metrics: CiMetricsView): CiTrendView {
  const peak = metrics.days.reduce((most, day) => Math.max(most, day.knownFlakeReds, day.parkedOnFlake), 0);
  const height = (value: number): number => barHeight(value, peak);
  const last = metrics.days.length - 1;
  return {
    bars: metrics.days.map((day, index) => {
      const label = dayLabel(day.day);
      // Counted back from today rather than forward from the first day, so the
      // last labelled day never sits beside "Today" and collides with it.
      const axisLabel = index === last ? "Today" : (last - index) % AXIS_EVERY === 0 ? shortLabel(label) : "";
      return {
        day: day.day,
        label,
        knownFlakeReds: day.knownFlakeReds,
        parkedOnFlake: day.parkedOnFlake,
        redHeight: height(day.knownFlakeReds),
        parkedHeight: height(day.parkedOnFlake),
        today: index === last,
        axisLabel,
        detail: trendDetail(label, day.knownFlakeReds, day.parkedOnFlake),
        flip: index >= metrics.days.length / 2,
      };
    }),
    peak,
    reds: metrics.reds,
    parkedPeak: metrics.parkedPeak,
    todayReds: metrics.days[last]?.knownFlakeReds ?? 0,
    ticks: trendTicks(peak),
    recorded: metrics.recorded,
  };
}

/**
 * Which of the trend's three shapes to draw: the chart, or one of two
 * sentences that are NOT the same answer. "Nothing recorded" means the doctor
 * has not run here; "quiet" means it has, for a fortnight, and found nothing —
 * which is the good news the zeros alone cannot tell from the other.
 *
 * Here rather than as two predicates in the panel, for the reason `anyWaits`
 * below is here: choosing between two sentences is a decision, and the panel
 * has no tests.
 */
export const trendState = (trend: CiTrendView): "unrecorded" | "quiet" | "drawn" =>
  !trend.recorded ? "unrecorded" : trend.peak === 0 ? "quiet" : "drawn";

/* ------------------------------------------------- the wait times (#163) */

/** `1 iteration`, `3 iterations`: a count and its noun, agreeing. */
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * One wait cell: the 24-hour median the panel sets in large type, the words
 * after it, and the 7-day median as the line under it — so the panel styles
 * them differently without respelling any. `figure` is null when there is no
 * 24-hour median, and `unit` then says why.
 *
 * "no iteration waited" rather than "0 min": a median of nothing is not zero,
 * and a panel that printed zero would say the loops never wait on CI, which is
 * the opposite of the truth it is there to measure. The same holds for the
 * week line.
 *
 * The day leads because it is the one an operator can still act on; the week
 * under it is the shape that day belongs to. How many iterations the day's
 * median is OF goes in `title`: a median of one is not a typical wait, and
 * the hover is where a reader checking the figure looks.
 *
 * One function returning every part rather than a string the panel takes
 * apart: `mainWord`'s header below gives the reason — a second copy of a
 * panel's own vocabulary, in a file no test compiles, is how the two come to
 * disagree. The first version of this returned one sentence, the panel rebuilt
 * all but the null branch itself, and the word "median" never reached a screen.
 */
export interface CiWaitCell {
  figure: string | null;
  unit: string;
  week: string;
  title: string;
}

export const waitCell = (
  day: { minutes: number | null; iterations: number },
  week: { minutes: number | null; iterations: number },
): CiWaitCell => ({
  figure: day.minutes === null ? null : String(day.minutes),
  unit: day.minutes === null ? "no iteration waited in 24 h" : "min · 24h",
  week:
    week.minutes === null
      ? "no iteration waited over 7 d"
      : `${week.minutes} min over 7 d · ${plural(week.iterations, "iteration")}`,
  title:
    day.minutes === null
      ? "median over 24 h: no iteration waited"
      : `median of ${plural(day.iterations, "iteration")} over 24 h`,
});

/**
 * Whether the panel has any wait figure to draw at all. A project whose loops
 * have opened no PR in a week has none, and that is not a fault.
 */
export const anyWaits = (waits: CiWaitsView): boolean =>
  waits.week.ciIterations > 0 || waits.week.queueIterations > 0;

/**
 * A median CI wait as a tone. The threshold is the supervisor's own CI wait
 * cap (`pr-wait.ts`'s 1500 s, 25 minutes): an iteration whose typical wait is
 * at the cap is an iteration that typically times out, which is the operator's
 * problem rather than CI's.
 */
export const waitTone = (minutes: number | null): "neutral" | "warn" =>
  minutes !== null && minutes >= 25 ? "warn" : "neutral";

/**
 * A case state as prose rather than as an enum. `handed-off` is the only one
 * whose stored spelling is not already a phrase.
 */
const STATE_WORD: Record<CiCaseView["state"], string> = {
  candidate: "candidate",
  confirmed: "confirmed",
  filed: "filed",
  fixing: "fixing",
  fixed: "fixed",
  retired: "retired",
  "handed-off": "handed off",
};

/** A case state as the table and the card say it. */
export const stateWord = (state: CiCaseView["state"]): string => STATE_WORD[state];

/**
 * A case key past its `<kind>:` prefix — `flake:a.test.ts > flaps` reads as
 * `a.test.ts > flaps`.
 *
 * `CiCaseView.subject` is already this, computed by the reader. This is for the
 * places the panel is handed a raw KEY instead: a parked case's `rule` and an
 * unpark's `diagnosis` are both case keys, and showing them with the prefix on
 * would spell the same test two ways on one screen.
 */
export const subjectOf = (key: string): string => key.slice(key.indexOf(":") + 1);

/**
 * A case said in one line, as a card's description: what it is, and what it is
 * about.
 *
 * `confirmed flake · src/a.test.ts > flaps`. The kind keeps its stored
 * spelling, `pr-specific` included: it is the doctor's own word for the case
 * and inventing a friendlier one would stop the card and the store agreeing.
 */
export const caseLine = (kase: CiCaseView): string => `${stateWord(kase.state)} ${kase.kind} · ${kase.subject}`;

/**
 * What a loop card's description leads with: a doctor's case, else its ticket.
 *
 * The decision is here rather than in `app.tsx` because that is a `.tsx` no
 * test compiles, and because it is the ticket's second acceptance criterion in
 * one line. A loop with no case falls through to exactly the string the card
 * built before, so a coder's card is unchanged.
 */
export function cardLead(entry: Pick<DashboardLoop, "case" | "issue" | "issueTitle">): string | null {
  if (entry.case !== null) return caseLine(entry.case);
  if (entry.issue === null) return null;
  return `#${entry.issue}${entry.issueTitle ? ` ${entry.issueTitle}` : ""}`;
}

/**
 * How main's colour reads.
 *
 * `unknown` is neutral, not bad: nothing has been measured — the doctor has
 * not scanned, or the window holds no main build — which is not news about
 * CI. Tinting it would make every project without a doctor look broken.
 */
export const mainTone = (state: CiMainState): "good" | "bad" | "neutral" =>
  state === "green" ? "good" : state === "red" ? "bad" : "neutral";

/**
 * A main colour as prose. `unknown` is a sentence rather than the word
 * "unknown", which beside a green and a red reads like a third colour.
 *
 * Here and not in the `.tsx` for the reason `triage-model.ts`'s `bucketTone`
 * gives: a second copy of a panel's own vocabulary, in a file no test
 * compiles, is how the two come to disagree.
 */
export const mainWord = (state: CiMainState): string => (state === "unknown" ? "not measured yet" : state);

/**
 * How a case's row reads: a case that has taken main down is the one an
 * operator must act on, whatever else it has cost.
 *
 * `bad` on `mainReds > 0` rather than on the weight, because the weight mixes
 * three costs and a single main red is already the worst of them.
 */
export const caseTone = (kase: CiCaseView): "bad" | "neutral" => (kase.mainReds > 0 ? "bad" : "neutral");

/**
 * How an open infra incident reads.
 *
 * `warn` and not `bad`: an incident is something outside the repository, so
 * there is nothing in the diff to fix and the doctor's whole response is a
 * notification. One that has taken main down is a different matter.
 */
export const incidentTone = (kase: CiCaseView): "bad" | "warn" => (kase.mainReds > 0 ? "bad" : "warn");

/**
 * What a doctor's row says about the case it holds.
 *
 * `healthKnown` is the whole point. `DashboardLoop.case` is null three ways —
 * not a doctor, a doctor holding nothing, or a store that was never read — and
 * `contracts.ts` says of the third: *"A card that said 'no case' on the
 * strength of a read that did not happen would be the one wrong answer."* The
 * panel cannot honour that rule without being told which null it has.
 */
export const caseWord = (kase: CiCaseView | null, healthKnown: boolean): string =>
  kase !== null ? caseLine(kase) : healthKnown ? "holding no case" : "case unknown — the store was not read";

/**
 * Whether the doctor has spent TODAY's retries.
 *
 * `warn` at the cap, never `bad`: a spent allowance is a fact about what the
 * doctor can still do today, not a failure. A cap of zero is a project that
 * has turned retries off, and a count of zero against it is not pressure, so
 * the cap must be positive for this to warn at all.
 *
 * `today` is part of the question, not a caveat beside it. The store carries
 * one day's count, so a figure read the morning after is yesterday's, and an
 * amber number next to the words "not today's count" would have the colour
 * contradicting the sentence.
 */
export const retryTone = (retries: CiRetriesView): "neutral" | "warn" =>
  retries.today && retries.cap > 0 && retries.count >= retries.cap ? "warn" : "neutral";

/* ------------------------------------------------------ the status strip */

/**
 * One tile of the strip across the top of the panel: the four answers an
 * operator wants before reading any section — is main green, is anything
 * broken outside the repository, what have flakes cost today, and how much
 * of the doctor's retry allowance is left.
 */
export interface CiStripTile {
  key: "main" | "incidents" | "lost" | "retries";
  label: string;
  /** The large figure. */
  value: string;
  /** The small words beside the figure; null when the figure stands alone. */
  unit: string | null;
  /** The line under the figure. */
  detail: string;
  tone: "good" | "bad" | "warn" | "neutral";
  /** The raw instant behind the figure, for a hover; null when there is none. */
  title: string | null;
}

/**
 * How long ago an instant was, compact enough to sit beside a large figure:
 * `45m`, `1h 20m`, `3d 4h`. Two units at most, and a zero second unit is
 * dropped, because `2h 0m` says nothing `2h` does not.
 *
 * Null for an instant that does not parse, rather than `NaNm`. A `since` in
 * the future (the reader's clock behind the doctor's) clamps to `0m`: the
 * colour is current, which is the true part of the answer.
 */
export const spanSince = (at: string, nowMs: number): string | null => {
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000));
  const pair = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
    small === 0 ? `${big}${bigUnit}` : `${big}${bigUnit} ${small}${smallUnit}`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return pair(hours, "h", minutes % 60, "m");
  return pair(Math.floor(hours / 24), "d", hours % 24, "h");
};

/**
 * The strip, always four tiles in the same order, so the operator's eye finds
 * the same answer in the same place on every project.
 *
 * Each tile repeats a section's decision rather than making its own: the tones
 * are `mainTone`, `incidentTone` and `retryTone`, so a tile and the section
 * below it cannot disagree about the colour of the same fact.
 */
export function ciStrip(health: CiHealthView, nowMs: number): CiStripTile[] {
  const { main, incidents, lostTime, retries } = health;

  const [first] = incidents;
  const incidentDetail =
    first === undefined
      ? "none open"
      : incidents.length > 1
        ? `${first.subject} +${incidents.length - 1} more`
        : first.subject;
  // Worst of the open incidents: one that has taken main down outranks any
  // number that have not.
  const incidentsTone: CiStripTile["tone"] =
    incidents.length === 0 ? "neutral" : incidents.some((entry) => incidentTone(entry) === "bad") ? "bad" : "warn";

  // Neutral whatever the figure: it is reds × median BUILD time, an estimate,
  // and a red tile would present it as a measured cost.
  const lost: CiStripTile =
    lostTime.reds === 0
      ? { key: "lost", label: "CI time lost · 24h", value: "0", unit: "min", detail: "no known-flake reds", tone: "neutral", title: null }
      : lostTime.minutes === null
        ? {
            key: "lost",
            label: "CI time lost · 24h",
            value: "—",
            unit: null,
            detail: `${plural(lostTime.reds, "known-flake red")} · no build could be timed`,
            tone: "neutral",
            title: null,
          }
        : {
            key: "lost",
            label: "CI time lost · 24h",
            value: String(lostTime.minutes),
            unit: "min",
            detail: `${plural(lostTime.reds, "known-flake red")} · estimate`,
            tone: "neutral",
            title: null,
          };

  // A count from another day is said to be one, for the reason `retryTone`
  // gives: the store holds one day's figure and rolls it over lazily.
  const retriesTone = retryTone(retries);
  const retriesDetail =
    retries.day === null && retries.count === 0
      ? "none recorded yet"
      : retries.today
        ? retriesTone === "warn"
          ? "allowance spent"
          : `${Math.max(0, retries.cap - retries.count)} left today`
        : `on ${retries.day ?? "an unrecorded day"}, not today's count`;

  return [
    {
      key: "main",
      label: "Main",
      value: mainWord(main.state),
      unit: main.since === null ? null : spanSince(main.since, nowMs),
      detail: main.build === null ? "no build recorded" : `build #${main.build}`,
      tone: mainTone(main.state),
      title: main.since,
    },
    {
      key: "incidents",
      label: "Infra incidents",
      value: String(incidents.length),
      unit: "open",
      detail: incidentDetail,
      tone: incidentsTone,
      title: null,
    },
    lost,
    {
      key: "retries",
      label: "Retries today",
      value: String(retries.count),
      unit: `/ ${retries.cap}`,
      detail: retriesDetail,
      tone: retriesTone,
      title: null,
    },
  ];
}

/* ---------------------------------------------------- what needs attention */

/**
 * The muted count beside the "Needs attention" card's title:
 * `1 incident · 3 tests · 2 parked`. Null when all three are empty, which is
 * the panel's signal to draw no card at all — an empty "Needs attention" card
 * would ask for attention it has nothing to show.
 *
 * A zero part is dropped rather than printed: `0 incidents` beside a list of
 * flakes is a figure to read past, and the card only lists what is there.
 * `cases` is the whole count, the rows past `CASE_ROW_LIMIT` included, so the
 * summary agrees with the table's `+N more` rather than with what fits.
 */
export function attentionSummary(counts: { incidents: number; cases: number; parked: number }): string | null {
  const parts = [
    counts.incidents > 0 ? plural(counts.incidents, "incident") : null,
    counts.cases > 0 ? plural(counts.cases, "test") : null,
    counts.parked > 0 ? `${counts.parked} parked` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * A case subject as the flake table draws it: the test's NAME on top, the file
 * it lives in under it. Split on the LAST ` > ` because a vitest id nests its
 * describe blocks with the same separator — `a.test.ts > suite > flaps` names
 * the test `flaps`, and splitting on the first would print `suite > flaps`
 * as its name. A subject with no ` > ` (an infra signature, a bare
 * file) is all name and has no path line.
 *
 * The describe blocks stay on the path side: they are where the test sits,
 * which is what that line is for, and the full subject is the row's `title`.
 */
export function testName(subject: string): { name: string; path: string | null } {
  const at = subject.lastIndexOf(" > ");
  if (at === -1) return { name: subject, path: null };
  return { name: subject.slice(at + 3), path: subject.slice(0, at) };
}

/**
 * A case's three costs as the table's one Cost cell:
 * `3 reds/72h · 1 on main · 2 dequeues`. Split into parts so the panel can set
 * the red count bold and the main reds in `caseTone`'s colour without
 * respelling either. `reds/72h` keeps the incident row's spelling, so the two
 * lists say the same window the same way.
 */
export interface CiCostParts {
  reds: string;
  redsWords: string;
  main: string;
  mainTone: "bad" | "neutral";
  dequeues: string;
}

export const costParts = (kase: CiCaseView): CiCostParts => ({
  reds: String(kase.redBuilds),
  redsWords: "reds/72h",
  main: `${kase.mainReds} on main`,
  mainTone: caseTone(kase),
  dequeues: plural(kase.dequeues, "dequeue"),
});
