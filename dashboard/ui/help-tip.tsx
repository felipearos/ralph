/**
 * A `?` beside a label that shows its help on hover or focus, so a form keeps
 * one line per field and the longer explanation is there when someone asks.
 */
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function HelpTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A button, not a bare icon, so keyboard users can reach the help too. */}
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground",
            className,
          )}
        >
          <CircleHelp aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="block normal-case tracking-normal font-normal leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
