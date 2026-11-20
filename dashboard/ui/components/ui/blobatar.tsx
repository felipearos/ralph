"use client";

import type * as React from "react";
import { Blobatar as Generated } from "@blobatar/react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type GeneratedOptions = DistributiveOmit<React.ComponentProps<typeof Generated>, "name">;

export type BlobatarProps = React.ComponentProps<typeof Avatar> & {
  name: string;
  src?: string;
  alt?: string;
  blobatar?: GeneratedOptions;
  blobatarRef?: React.Ref<SVGSVGElement>;
};

/**
 * The creature fills only ~60% of blobatar's 100-unit viewBox, so at avatar
 * sizes its eyes are 2-3px and smear on a 1x display. Scaling the SVG up gives
 * the face more pixels without growing the box it sits in. 1.15 is the most
 * that keeps every body inside that box: the furthest reach measured, hovered
 * (the library's 1.04 lift) on top of breathe and bob, is ~43.5 units from
 * the centre, and 50 / 43.5 = 1.15. Past that a body spills onto its
 * neighbours.
 */
const CREATURE_CLASS = "size-full scale-[1.15]";

export function Blobatar({ name, src, alt, blobatar, blobatarRef, className, ...props }: BlobatarProps) {
  // A generated face stands on its own: the avatar's round ring and clip are
  // a frame for a photo, and around a creature they read as a badge it sits in.
  if (!src) {
    const { size: _size, ...span } = props;
    return (
      <span data-slot="blobatar" className={cn("relative flex size-8 shrink-0 select-none", className)} {...span}>
        {blobatar?.animate ? (
          <Generated {...blobatar} ref={blobatarRef} name={name} className={CREATURE_CLASS} />
        ) : (
          <Generated {...blobatar} name={name} className={CREATURE_CLASS} />
        )}
      </span>
    );
  }
  return (
    <Avatar className={className} {...props}>
      <AvatarImage src={src} alt={alt ?? name} />
      <AvatarFallback className="overflow-hidden bg-transparent">
        <Generated {...blobatar} name={name} className={CREATURE_CLASS} />
      </AvatarFallback>
    </Avatar>
  );
}
