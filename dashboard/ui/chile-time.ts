/**
 * Every time the intake page shows, in Chile time (felipearos/ralph#459).
 * The team reads the page from Santiago, and an operator's browser may sit
 * in another zone: a time an hour or a day off from the one the team lived
 * is a wrong time, so the zone is fixed here and never the viewer's.
 */

export const CHILE_TIME_ZONE = "America/Santiago";

/** The label that says which clock the times are on. */
export const CHILE_TIME_LABEL = "Hora de Chile";

type Instant = string | number | Date | null | undefined;

// The one formatter every helper below reads, so the date and the time of
// one instant can never come from two different zones.
const FORMAT = new Intl.DateTimeFormat("es-CL", {
  timeZone: CHILE_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function msOf(value: Instant): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The instant's parts in Santiago, or null for a missing or unreadable date.
 * Read from parts: es-CL's own join ("22-10-2026, 16:04") is not a format
 * the runtime promises to keep.
 */
function chileParts(value: Instant): Record<string, string> | null {
  const ms = msOf(value);
  if (ms === null) return null;
  return Object.fromEntries(FORMAT.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
}

/** "22-10-2026" in Santiago, or "-". */
export function chileDate(value: Instant): string {
  const parts = chileParts(value);
  return parts === null ? "-" : `${parts.day}-${parts.month}-${parts.year}`;
}

/** "16:04", 24h, in Santiago, or "-". */
export function chileTime(value: Instant): string {
  const parts = chileParts(value);
  return parts === null ? "-" : `${parts.hour}:${parts.minute}`;
}

/** "22-10-2026 16:04" in Santiago, or "-": the page's stamps that sit in one line of text. */
export function chileDateTime(value: Instant): string {
  const parts = chileParts(value);
  return parts === null ? "-" : `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Milliseconds since the epoch, for sorting a date column by the whole
 * instant rather than by the text it shows; a missing date sorts oldest.
 */
export function instantMs(value: Instant): number {
  return msOf(value) ?? Number.NEGATIVE_INFINITY;
}
