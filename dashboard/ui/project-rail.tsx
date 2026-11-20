/**
 * The project rail: the narrow column at the sidebar's left edge. The All
 * projects floor sits at the top; every project below is a lettered tile with
 * its health dot and a square per agent; the ones with nothing running are
 * dimmed below a rule; adding a project is the last tile. The view comes from
 * `project-rail-model.ts`.
 *
 * It replaces the project switcher's dropdown: a project's state is on screen
 * before anyone opens anything, a click on its tile opens it, and a right
 * click opens a menu of its pages and settings, and puts the project to sleep
 * or wakes it.
 */
import { LayoutGrid, Plus } from "lucide-react";
import { useState } from "react";
import type { ComponentType, CSSProperties, MouseEvent, ReactNode } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { AddProjectDialog } from "./add-project";
import { useCommandAvailability } from "./command";
import type { AgentState } from "./factory-model";
import { pagePath, type HealthTone } from "./project-model";
import type { RailTile, RailView } from "./project-rail-model";
import { ProjectSleepDialog, ProjectSleepMenuItems, wakeProject } from "./project-sleep";
import { usePreloadHref } from "./in-app-link";

/** A page of a project, as the sidebar lists it: what a tile's menu offers. */
export interface RailPage {
  title: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
}

/** A modified click keeps the browser's own meaning (new tab, new window), so it does not navigate in place. */
const modified = (event: MouseEvent) => event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

const TONE_DOT: Record<HealthTone, string> = {
  good: "bg-status-good",
  warn: "bg-status-warn",
  bad: "bg-status-bad",
  info: "bg-status-info",
  neutral: "bg-muted-foreground",
};

/** The floor's agent colours, at the size of a rail square. */
const MARK_LOOK: Record<AgentState, string> = {
  working: "bg-factory",
  waiting: "bg-factory-wait/80",
  idle: "bg-factory-idle/70",
  paused: "bg-status-warn/80",
  blocked: "bg-status-bad",
  down: "ring-1 ring-inset ring-muted-foreground/50",
};

/** A rail entry: a square button with the active bar, and its hover text to the right. */
function RailItem({
  label,
  active,
  href,
  onClick,
  dim,
  disabled,
  ariaLabel,
  children,
  below,
  menu,
  onPointerEnter,
  onFocus,
}: {
  label: ReactNode;
  disabled?: boolean;
  /** The accessible name, where the hover text is not plain words. */
  ariaLabel?: string;
  active: boolean;
  href?: string;
  onClick: (event: MouseEvent) => void;
  dim?: boolean;
  children: ReactNode;
  below?: ReactNode;
  /** A menu the tile opens on a right click; a left click still does `onClick`. */
  menu?: ReactNode;
  /** Hover and keyboard focus: a tile preloads the page it opens ahead of the click (#727, #739). */
  onPointerEnter?: () => void;
  onFocus?: () => void;
}) {
  const Tag = href === undefined ? "button" : "a";
  const [menuOpen, setMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const tile = (
    <Tag
      {...(href === undefined ? { type: "button" as const, disabled } : { href })}
      onClick={onClick}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/tile relative flex w-full flex-col items-center gap-1 py-1 outline-none",
        dim && "opacity-45 hover:opacity-100",
        disabled && "cursor-not-allowed opacity-45",
      )}
    >
      {active && <span aria-hidden className="absolute top-1 left-0 h-8 w-0.5 bg-sidebar-foreground" />}
      <span
        className={cn(
          "relative flex size-8 items-center justify-center border border-sidebar-border transition-colors",
          "group-hover/tile:bg-sidebar-accent group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-sidebar-ring",
          active && "bg-sidebar-accent",
        )}
      >
        {children}
      </span>
      {below}
    </Tag>
  );
  const tip = (
    <TooltipContent side="right" className="max-w-72">
      {label}
    </TooltipContent>
  );
  if (menu === undefined) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{tile}</TooltipTrigger>
        {tip}
      </Tooltip>
    );
  }
  // The hover text steps aside while the menu is open: both sit to the tile's right.
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <Tooltip open={tipOpen && !menuOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
        </TooltipTrigger>
        {tip}
      </Tooltip>
      <ContextMenuContent className="min-w-52">{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function ProjectTile({
  tile,
  go,
  dim,
  pages,
}: {
  tile: RailTile;
  go: (path: string) => void;
  dim?: boolean;
  pages: readonly RailPage[];
}) {
  // Held here, not in the menu: the menu closes on a pick and unmounts its items.
  const [sleeping, setSleeping] = useState(false);
  const [wakeFailure, setWakeFailure] = useState<string | null>(null);
  const preloadHref = usePreloadHref();
  // The active project is already being read; another one's page is preloaded
  // ahead of the click (its route loader reads all the page shows), so it opens
  // on data instead of a skeleton.
  const prefetch = (): void => {
    if (!tile.active) preloadHref(tile.href);
  };
  return (
    <>
      <RailItem
        label={
          <span className="grid gap-0.5">
            <span className="font-medium">{tile.lines[0]}</span>
            {tile.lines.slice(1).map((line) => (
              <span key={line} className="opacity-70">
                {line}
              </span>
            ))}
          </span>
        }
        ariaLabel={tile.lines.join(" · ")}
        active={tile.active}
        href={tile.href}
        dim={dim}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        onClick={(event) => {
          if (modified(event)) return;
          event.preventDefault();
          if (!tile.active) go(tile.href);
        }}
        menu={
          <>
            <ContextMenuLabel className="grid max-w-64 gap-0.5">
              <span className="truncate">{tile.lines[0]}</span>
              {tile.lines.slice(1).map((line) => (
                <span key={line} className="text-xs font-normal text-muted-foreground">
                  {line}
                </span>
              ))}
            </ContextMenuLabel>
            <ContextMenuSeparator />
            {pages.map((page) => {
              const href = pagePath(tile.id, page.path);
              return (
                <ContextMenuItem key={page.path} asChild>
                  <a
                    href={href}
                    onPointerEnter={() => preloadHref(href)}
                    onFocus={() => preloadHref(href)}
                    onClick={(event) => {
                      if (modified(event)) return;
                      event.preventDefault();
                      go(href);
                    }}
                  >
                    <page.icon className="size-4" />
                    {page.title}
                  </a>
                </ContextMenuItem>
              );
            })}
            <ProjectSleepMenuItems
              project={tile.id}
              onSleep={() => setSleeping(true)}
              onWake={(refresh) => void wakeProject(tile.id, refresh).then(setWakeFailure)}
            />
          </>
        }
        below={
          tile.agents.length > 0 && (
            <span aria-hidden className="flex items-center gap-px">
              {tile.agents.map((state, index) => (
                <span key={index} className={cn("block size-1", MARK_LOOK[state])} />
              ))}
              {tile.more > 0 && <span className="ml-px text-[7px] leading-none text-muted-foreground">+</span>}
            </span>
          )
        }
      >
        {/* The hue tells projects apart; lightness and chroma are one for all, like a label's text. */}
        <span
          className="font-mono text-[10px] font-semibold tracking-wide"
          style={{ color: `oklch(0.78 0.11 ${tile.hue})` } as CSSProperties}
        >
          {tile.mark}
        </span>
        {tile.tone !== null && (
          <span aria-hidden className={cn("absolute -right-1 -bottom-1 size-2 rounded-full border-2 border-sidebar", TONE_DOT[tile.tone])} />
        )}
      </RailItem>
      {sleeping && <ProjectSleepDialog project={tile.id} open onOpenChange={setSleeping} />}
      <Dialog open={wakeFailure !== null} onOpenChange={(open) => !open && setWakeFailure(null)}>
        <DialogContent className="gap-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tile.id} did not wake</DialogTitle>
            <DialogDescription>{wakeFailure}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setWakeFailure(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ProjectRail({
  view,
  onFloor,
  floorPath,
  go,
  pages,
}: {
  view: RailView;
  /** A project's pages, which each tile's menu opens in that project. */
  pages: readonly RailPage[];
  onFloor: boolean;
  floorPath: string;
  /** Navigate in place to a full path. */
  go: (path: string) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const [adding, setAdding] = useState(false);
  // The remote function serves no add: the route's availability says so, and why.
  const addLock = useCommandAvailability("/api/projects");
  const preloadHref = usePreloadHref();
  const preloadFloor = (): void => preloadHref(floorPath);
  const travel = (path: string) => {
    go(path);
    if (isMobile) setOpenMobile(false);
  };
  return (
    <nav aria-label="Projects" className="flex h-full flex-col items-center gap-1 overflow-y-auto py-2">
      <RailItem
        label="All projects"
        ariaLabel="All projects"
        active={onFloor}
        href={floorPath}
        onPointerEnter={preloadFloor}
        onFocus={preloadFloor}
        onClick={(event) => {
            if (modified(event)) return;
          event.preventDefault();
          travel(floorPath);
        }}
      >
        <LayoutGrid className="size-4" />
      </RailItem>
      <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />
      {view.live.map((tile) => (
        <ProjectTile key={tile.id} tile={tile} go={travel} pages={pages} />
      ))}
      {view.dormant.length > 0 && <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-sidebar-border" />}
      {view.dormant.map((tile) => (
        <ProjectTile key={tile.id} tile={tile} go={travel} pages={pages} dim />
      ))}
      <span className="flex-1" />
      <RailItem
        label={addLock.disabled ? `Add project · ${addLock.why}` : "Add project"}
        ariaLabel={addLock.disabled ? `Add project · ${addLock.why}` : "Add project"}
        active={false}
        disabled={addLock.disabled}
        onClick={() => {
          setAdding(true);
          if (isMobile) setOpenMobile(false);
        }}
      >
        <Plus className="size-4 text-muted-foreground" />
      </RailItem>
      <AddProjectDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(result) => {
          setAdding(false);
          go(pagePath(result.project.id, "/"));
        }}
      />
    </nav>
  );
}
