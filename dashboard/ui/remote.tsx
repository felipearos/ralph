/**
 * The remote dashboard's addition to the page (spec #165 §8): the bridge
 * banner, and the context carrying the bridge's status to the command module.
 *
 * It is inert on the local dashboard: `isRemote()` is false there and the
 * banner is never mounted. The rules are `remote-model.ts`.
 *
 * A relayed answer is settled only by `command.tsx`, from its route, so no
 * view follows a relay by hand; the local-only note lives there too
 * (`LocalOnlyNote`), driven by its command's route rather than by the page.
 */
import { createContext } from "react";

import type { BridgeStatusView } from "../contracts";
import { cn } from "@/lib/utils";
import { bridgeBanner, type BannerTone } from "./remote-model";

/** The bridge's last status, read once per project page; null locally and until the first read. */
export const BridgeContext = createContext<BridgeStatusView | null>(null);

const TONE_DOT: Record<BannerTone, string> = {
  good: "bg-status-good",
  info: "bg-status-info",
  warn: "bg-status-warn",
  bad: "bg-status-bad",
};

const TONE_STRIP: Record<BannerTone, string> = {
  good: "border-status-good/25 bg-status-good/[0.06]",
  info: "border-status-info/25 bg-status-info/[0.06]",
  warn: "border-status-warn/30 bg-status-warn/[0.08]",
  bad: "border-status-bad/30 bg-status-bad/10",
};

const TONE_TEXT: Record<BannerTone, string> = {
  good: "text-foreground",
  info: "text-foreground",
  warn: "text-status-warn",
  bad: "text-status-bad",
};

/**
 * The strip under the header: is the machine there, and how old is what the
 * page shows. `status` null with `error` set means `/api/bridge` itself failed.
 */
export function BridgeBanner({
  status,
  error,
  snapshotAt,
}: {
  status: BridgeStatusView | null;
  error: string | null;
  /** The dashboard snapshot's push time. */
  snapshotAt: Date | null;
}) {
  const lines =
    status !== null
      ? bridgeBanner(status, { nowMs: Date.now(), snapshotAt })
      : error !== null
        ? [{ tone: "bad" as const, text: `The machine's status could not be read: ${error}` }]
        : [{ tone: "info" as const, text: "Checking whether the machine is there…" }];
  return (
    <div
      role="status"
      aria-label="Machine status"
      data-bridge-banner
      className={cn(
        "sticky top-12 z-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5 text-xs backdrop-blur",
        TONE_STRIP[lines[0]!.tone],
      )}
    >
      {lines.map((line) => (
        <span key={line.text} data-tone={line.tone} className={cn("inline-flex items-center gap-2", TONE_TEXT[line.tone])}>
          <span className={cn("inline-flex size-2 shrink-0 rounded-full", TONE_DOT[line.tone])} />
          {line.text}
        </span>
      ))}
    </div>
  );
}
