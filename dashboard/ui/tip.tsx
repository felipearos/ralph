/**
 * A hover hint, as the shadcn tooltip draws it, for the status marks whose
 * hover text carries something the mark does not say (who holds a claim and
 * for how long, why a ticket is stuck, what a PR's checks are doing).
 *
 * Several lines are kept as lines: callers pass `\n`-joined text, and a
 * browser `title` was where that convention came from. Empty content draws
 * the child alone, so a mark with nothing to add needs no branch.
 *
 * A truncated title keeps its native `title`: that hint only finishes the
 * cut text, and a tooltip per row would put hundreds on a long backlog.
 */
import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function Tip({
  content,
  children,
  className,
}: {
  content: ReactNode;
  /** One element, which becomes the trigger: it must take a ref and props (a DOM element does). */
  children: ReactElement;
  className?: string;
}) {
  if (content === undefined || content === null || content === "") return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className={cn("max-w-80 whitespace-pre-line", className)}>{content}</TooltipContent>
    </Tooltip>
  );
}
