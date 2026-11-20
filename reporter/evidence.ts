/**
 * The bound on what one issue's evidence may hold (felipearos/ralph#680).
 *
 * The evidence goes into a model prompt, and a real event can carry a
 * several-hundred-frame trace and hundreds of breadcrumbs with free-text
 * messages. Unbounded, one noisy issue would crowd out the ticket, the code
 * and everything else the model needs, so every reporter cuts its evidence
 * here, to the same shape: the frames most likely to matter first, the most
 * recent breadcrumbs, short messages, and only the tags that locate the crash.
 */
import type { Breadcrumb, Evidence, Frame } from "./types";

export const MAX_FRAMES = 30;
export const MAX_BREADCRUMBS = 30;
export const MAX_MESSAGE_CHARS = 200;

/** Evidence as a reporter receives it, before the bound. */
export interface RawEvidence {
  issueId: string;
  release: string | null;
  environment: string | null;
  /** As Sentry sends them: outermost first, crash site last. */
  frames: Frame[];
  tags: Record<string, string>;
  /** Chronological. */
  breadcrumbs: Breadcrumb[];
}

const KEPT_TAGS = ["browser", "os", "url", "transaction"] as const;

/** Cuts text to MAX_MESSAGE_CHARS, ending a cut one with "…" inside the limit. */
const clip = (text: string): string => {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  let cut = text.slice(0, MAX_MESSAGE_CHARS - 1);
  // A cut through a surrogate pair would leave half a character in the prompt.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
};

export function boundEvidence(raw: RawEvidence): Evidence {
  // The crash site and the project's own code are what a fix touches, so
  // in-app frames lead and each group reads from the crash outward.
  const innermostFirst = [...raw.frames].reverse();
  const ordered = [
    ...innermostFirst.filter((frame) => frame.inApp),
    ...innermostFirst.filter((frame) => !frame.inApp),
  ];
  // Minified bundles produce enormous file and function names; clip them like messages.
  const frames = ordered
    .slice(0, MAX_FRAMES)
    .map((frame) => ({ ...frame, file: clip(frame.file), function: clip(frame.function) }));

  // The breadcrumbs just before the crash explain it; the oldest rarely do.
  const recent = raw.breadcrumbs.slice(Math.max(0, raw.breadcrumbs.length - MAX_BREADCRUMBS));
  const breadcrumbs = recent.map((crumb) => ({ ...crumb, message: clip(crumb.message) }));

  const tags: Evidence["tags"] = {};
  for (const key of KEPT_TAGS) {
    const value = raw.tags[key];
    if (value !== undefined) tags[key] = clip(value);
  }

  return {
    issueId: raw.issueId,
    release: raw.release,
    environment: raw.environment,
    frames,
    framesOmitted: ordered.length - frames.length,
    tags,
    breadcrumbs,
    breadcrumbsOmitted: raw.breadcrumbs.length - breadcrumbs.length,
  };
}
