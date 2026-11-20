/**
 * One entry of the Seguimiento menu: the stage, its status and its Chile
 * date and time, as a link that opens in a new tab, or as text when the
 * stage has no page (a held move, a report with no permalink).
 *
 * `intake.tsx` hands it to the shadcn `DropdownMenuItem` with `asChild`, so
 * it passes every prop it is given to the element: that is how the menu's
 * focus, keyboard and styling reach it. Written without JSX, so a node test
 * can render it under the root tsconfig, which compiles none.
 */
import { createElement, type HTMLAttributes, type ReactElement, type Ref } from "react";

import type { TrailEntry } from "./intake-trail";

type Props = { entry: TrailEntry; ref?: Ref<HTMLElement> } & HTMLAttributes<HTMLElement>;

export function TrailEntryItem({ entry, ...props }: Props): ReactElement {
  const body = [
    createElement("span", { key: "title", className: "font-medium" }, entry.title),
    createElement(
      "span",
      { key: "meta", className: "text-muted-foreground tabular-nums" },
      entry.status === null ? entry.when : `${entry.status} · ${entry.when}`,
    ),
  ];
  const layout = "flex flex-col items-start gap-0.5 normal-case tracking-normal";
  const className = props.className === undefined ? layout : `${props.className} ${layout}`;
  if (entry.href === null) return createElement("div", { ...props, className, "data-entry": entry.id }, body);
  return createElement("a", { ...props, className, "data-entry": entry.id, href: entry.href, target: "_blank", rel: "noopener noreferrer" }, body);
}
