/**
 * The small shared pieces of text the panels draw: a label's words (URLs as
 * links, file paths as a short chip that leads with the file name), an issue
 * number as a link to the tracker, and the quiet prose that stands in for an
 * absence.
 *
 * The last two live here because three panels had grown their own identical
 * copy, and a panel's "no entries" line and its issue links are the two things
 * every panel needs to read the same way.
 */
import { cn } from "@/lib/utils";
import { issueHref, issueRef } from "./issue-link";

import { segments, type PathPiece } from "./activity-model";

/**
 * A path shown as `…/dir/name.ext`, with the whole of it on hover. The
 * directories give way first: `compact` drops them, and a narrow row elides
 * them, so the file name is the last thing to go.
 */
export function FilePath({ path, compact = false }: { path: PathPiece; compact?: boolean }) {
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-baseline rounded-sm bg-muted/60 px-1 align-baseline font-mono text-[11px]"
      title={path.full}
    >
      {path.dir && !compact && <span className="min-w-0 truncate text-muted-foreground">{path.dir}</span>}
      <span className={cn("shrink-0 font-medium text-foreground", compact && "max-w-[22ch] truncate")}>{path.name}</span>
    </span>
  );
}

/** The label's text, with its URLs and file paths given their own shape. */
export function LabelText({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <>
      {segments(text).map((piece, index) => {
        if (piece.kind === "link") {
          return (
            <a
              key={index}
              href={piece.href}
              target="_blank"
              rel="noreferrer"
              className="text-status-info underline underline-offset-2 hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              {piece.text}
            </a>
          );
        }
        if (piece.kind === "path") return <FilePath key={index} path={piece.path} compact={compact} />;
        return <span key={index}>{piece.text}</span>;
      })}
    </>
  );
}

/** Secondary prose: an absence, an unknown, or a "nothing here yet". */
export const Quiet = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

/** A ticket number as the project's tracker spells and links it (`issue-link.ts`). */
export function IssueLink({ repoUrl, issue }: { repoUrl: string | null; issue: number }) {
  const href = issueHref(repoUrl, issue);
  if (href === null) return <>{issueRef(issue)}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      {issueRef(issue)}
    </a>
  );
}

/** A pull request number, linked the same way. Beside `IssueLink` so the two cannot drift apart. */
export function PullLink({ repoUrl, pr }: { repoUrl: string | null; pr: number }) {
  if (repoUrl === null) return <>PR #{pr}</>;
  return (
    <a href={`${repoUrl}/pull/${pr}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
      PR #{pr}
    </a>
  );
}
